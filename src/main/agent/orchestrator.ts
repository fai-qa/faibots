// The runtime: who speaks when (ARCHITECTURE §5). Plain code decides, no model does:
//
//   dm        every user message gives the bot one turn.
//   group     every user message starts a cascade of rounds. Round 1: @mentioned bots must answer;
//             @everyone/@all addresses all members; nobody addressed -> the group policy (open:
//             everyone may answer or pass; mentions: the primary bot answers; router: a cheap
//             model call picks). Later rounds offer the bots' new posts to the other members
//             (mentioned bots must answer; in open policy the rest may answer or pass). At most
//             maxRounds rounds and maxBotPosts bot posts; the last round is "winding down";
//             a round without posts ends the cascade.
//   exchange  a bot's send_to_agent posts into the exchange with the other bot, runs that bot's
//             turn there and waits for its reply (chain depth ≤ 3, no loops, 10 minute timeout).
//
// A bot runs one turn at a time per conversation (SerialQueues). Stop cancels every running and
// queued turn of a conversation, and through the signals every exchange those turns opened.
//
// Every turn that reaches a model is written to the turn log with what started it (user, group,
// agent, routine) and its tokens. Automatic turns (agent, routine) first check the bot's daily run
// limit, so a routine or a chatty bot cannot spend a whole allowance unattended.

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  DEFAULT_GROUP_SETTINGS,
  MAX_GROUP_BOTS,
  type Bot,
  type BotPhase,
  type Conversation,
  type Entry,
  type EntryTrigger,
  type GroupSettings,
  type GroupTurnPolicy,
  type Id,
  type ManifestLiteSource,
  type TurnTrigger
} from '@shared/domain'
import { MAX_ASKS_PER_CHAIN } from '@shared/work-brief'
import type { SendMessageRequest } from '@shared/ipc'
import type { AutomatedRunResult, Runtime, Services, ToolContext, ToolDefinition, ToolResult } from '../contracts'
import type { EngineKind } from '../providers/catalog'
import type { RuntimeProviders } from '../providers/provider-service'
import type { ToolCallRequest } from '../providers/types'
import type { PlatformStore } from '../store'
import { backgroundAnchor, createDelegationRepo, type AssignmentRoot, type DelegationLease } from '../store/delegations'
import { errorResult } from '../tools/define'
import { MAX_RESULT_CHARS, truncateText } from '../tools/registry'
import { nativeActionId } from '../tools/action-executor'
import { CollabError, CollabRefusal, findBot, type CollabRuntime } from './collab-tools'
import { attachmentContext, projectSelections, safeModelId, saveTurnContext } from '../store/turn-context'
import { startOfLocalDay } from '../store/turns'
import { MAIN_BOT_NAME } from '../store/bots'
import { workBriefs } from '../store/work-briefs'
import { BackgroundAssignments } from './delegation-tools'
import { projectReplyOrigin, projectResultForEntry, projectResultOrigin, queueProjectReply } from '../store/project-result-requests'
import { IncompleteTurnError, type TurnEngine } from './engine'
import { speakerName } from './history'
import { LiveStates } from './live-state'
import { resolveMentionHints } from './mentions'
import { buildSystemPrompt, turnNote } from './prompt'
import { SerialQueues } from './queue'
import { routeMessage } from './router'
import { TurnRecorder, toolStatus, resultPreview, SELECTED_RESULT_ERROR, SELECTED_RESULT_WITHHELD } from './turn-recorder'

export const MAX_CHAIN_DEPTH = 3
/** send_to_agent calls one turn may make. */
export const MAX_ASKS_PER_TURN = 5
/** send_to_agent calls one chain may make in total, across every level of asking. */
export { MAX_ASKS_PER_CHAIN }
export const EXCHANGE_TIMEOUT_MS = 10 * 60_000
const SHUTDOWN_WAIT_MS = 4_000

export type RuntimeDeps = Omit<Services, 'providers' | 'runtime' | 'routines' | 'webhooks' | 'missions' | 'store'> &
  { providers: RuntimeProviders; store: PlatformStore }

export interface RuntimeOptions {
  engines: Record<EngineKind, TurnEngine>
  exchangeTimeoutMs?: number
  now?: () => Date
}

export interface TurnOutcome {
  turnId?: Id
  /** 'limited': an automatic turn was refused by the bot's daily run limit. */
  status: 'sent' | 'pass' | 'error' | 'cancelled' | 'skipped' | 'limited'
  posts: Entry[]
  error?: string
  needsReconciliation?: boolean
  lateReply?: string
}

interface TurnRequest {
  /** What started the turn: the turn log and the daily limit use it. */
  trigger: TurnTrigger
  mustAnswer: boolean
  isWindingDown?: boolean
  inGroup: boolean
  chain: Id[]
  /** Selected sources for this turn (manifest-lite, FJ-09); only mission runs set it. */
  projectRun?: { projectId: Id; runId: Id }
  manifestLite?: { sources: ManifestLiteSource[] }
  readProjectNote?: ToolContext['readProjectNote']
  /** Aborts the turn from outside (the asking bot's turn, the exchange timeout). */
  parentSignal?: AbortSignal
  cascade?: Cascade
  root?: AssignmentRoot
  userRequest?: { id: Id; seq: number }
  wake?: { id: string; revision: number; entryId: string }
  assignment?: { lease: DelegationLease; questionId: Id; questionSeq: number; origin: NonNullable<Conversation['origin']> }
}

interface ActiveTurn {
  turnId: Id
  bot: Bot
  conversationId: Id
  recorder: TurnRecorder
  mustAnswer: boolean
  passed: boolean
  abort: AbortController
  waiting: number
  beforeWaiting?: { phase: BotPhase; activity?: string }
  asks: number
  projectRun?: TurnRequest['projectRun']
  root: AssignmentRoot
  unresolvedActions: Set<string>
}

/** One user message's rounds in a group. */
class Cascade {
  posts = 0
  refused = 0
  stopped = false
  superseded = false
  constructor(readonly maxPosts: number) {}

  /** Take one post (one message entry) from the budget. */
  reserve(): boolean {
    if (this.stopped || this.posts >= this.maxPosts) {
      this.refused++
      return false
    }
    this.posts++
    return true
  }

  get exhausted(): boolean {
    return this.posts >= this.maxPosts
  }
}

interface ConversationRun {
  stop: AbortController
  cascades: Set<Cascade>
}

interface Participant {
  bot: Bot
  mustAnswer: boolean
}

const unique = <T>(items: T[]) => [...new Set(items)]
const isOwn = (e: Entry, botId: Id) => e.author.kind === 'bot' && e.author.botId === botId
const POLICIES: GroupTurnPolicy[] = ['open', 'mentions', 'router']

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
}

/** Group settings with defaults filled in and values kept in sane bounds. */
export function normalizeGroupSettings(settings: Partial<GroupSettings> | undefined): GroupSettings {
  const s = { ...DEFAULT_GROUP_SETTINGS, ...settings }
  return {
    turnPolicy: POLICIES.includes(s.turnPolicy) ? s.turnPolicy : DEFAULT_GROUP_SETTINGS.turnPolicy,
    maxRounds: clamp(s.maxRounds, 1, 10, DEFAULT_GROUP_SETTINGS.maxRounds),
    maxBotPosts: clamp(s.maxBotPosts, 1, 50, DEFAULT_GROUP_SETTINGS.maxBotPosts),
    allowBotToBot: typeof s.allowBotToBot === 'boolean' ? s.allowBotToBot : DEFAULT_GROUP_SETTINGS.allowBotToBot,
    parallel: typeof s.parallel === 'boolean' ? s.parallel : DEFAULT_GROUP_SETTINGS.parallel
  }
}

export class Orchestrator implements Runtime, CollabRuntime {
  private readonly live: LiveStates
  private readonly queues = new SerialQueues()
  private readonly runs = new Map<Id, ConversationRun>()
  private readonly active = new Map<Id, ActiveTurn>()
  private readonly background = new Set<Promise<unknown>>()
  private readonly delegations: ReturnType<typeof createDelegationRepo>
  private readonly briefs: ReturnType<typeof workBriefs>
  private readonly scheduledWakes = new Set<string>()
  private readonly scheduledResults = new Set<string>()
  readonly assignments: BackgroundAssignments
  private readonly unsubscribe: () => void
  private readonly exchangeTimeoutMs: number
  private readonly now: () => Date
  private closed = false

  constructor(
    private readonly deps: RuntimeDeps,
    private readonly options: RuntimeOptions
  ) {
    this.live = new LiveStates(deps.bus)
    this.exchangeTimeoutMs = options.exchangeTimeoutMs ?? EXCHANGE_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
    this.briefs = workBriefs(deps.store.db)
    this.delegations = createDelegationRepo(deps.store.db, deps.store.entries)
    this.assignments = new BackgroundAssignments(this.delegations, deps.tools, deps.store, (entry) => this.emitEntry(entry))
    this.delegations.recover()
    this.recoverInterruptedTurns()
    for (const item of this.briefs.interrupted()) this.systemEvent(item.chat, `The app closed while fai was reviewing brief ${item.id}. Its returns are saved. Ask fai to continue reviewing them.`)
    queueMicrotask(() => this.wakeBriefs())
    queueMicrotask(() => this.recoverProjectResults())
    this.unsubscribe = deps.approvals.subscribe((event) => {
      const turn = this.active.get(event.ctx.turnId)
      if (event.state === 'pending') this.emitConversationAndRoot(event.ctx.conversation.id)
      if (!turn) return
      if (event.state === 'pending') {
        if (turn.waiting++ === 0) turn.beforeWaiting = turn.recorder.currentPhase
        turn.recorder.phase('waiting', 'Waiting for your approval')
      } else if (--turn.waiting <= 0) {
        turn.waiting = 0
        turn.recorder.phase(turn.beforeWaiting?.phase ?? 'tool', turn.beforeWaiting?.activity)
      }
    })
  }

  // -------------------------------------------------------------------------------------------
  // Runtime contract
  // -------------------------------------------------------------------------------------------

  async send(req: SendMessageRequest): Promise<Entry> {
    if (this.closed) throw new Error('faibots is shutting down.')
    const { store } = this.deps
    const conversation = store.conversations.get(req.conversationId)
    if (!conversation) throw new Error('Conversation not found')
    if (conversation.kind === 'exchange') throw new Error('Conversations between bots are read-only.')
    if (req.clientNonce) {
      const existing = store.entries.findByNonce(conversation.id, req.clientNonce)
      if (existing) {
        if (existing.meta?.selectedResultEntryId && (existing.replyToId !== req.replyToId || existing.text !== req.text.trim()))
          throw new Error('This message ID already belongs to a different selected-result reply.')
        if (req.clientNonce.startsWith('project-result-') || existing.replyToId) this.dispatchProjectResult(existing)
        return existing
      }
    }
    const text = req.text.trim()
    if (!text && req.attachmentPaths.length === 0) throw new Error('Type a message or attach a file.')

    const mentions = resolveMentionHints(text, this.membersOf(conversation), req.mentions, req.mentionsEveryone)
    const replyOrigin = conversation.kind === 'dm' && req.replyToId && projectReplyOrigin(store, conversation.id, req.replyToId)
    const append = () => {
      const attachments = req.attachmentPaths.length ? this.deps.attachments.ingest(req.attachmentPaths) : []
      if (!text && !attachments.length) throw new Error('Type a message or attach a file.')
      return store.entries.append({
        conversationId: conversation.id,
        kind: 'message',
        author: { kind: 'user' },
        text,
        mentions: mentions.ids,
        mentionsEveryone: mentions.everyone,
        ...(req.replyToId && { replyToId: req.replyToId }),
        ...(replyOrigin && { meta: { selectedResultEntryId: replyOrigin } }),
        attachments,
        isStreaming: false,
        ...(req.clientNonce && { clientNonce: req.clientNonce })
      })
    }
    if (replyOrigin) {
      const reply = queueProjectReply(store, this.deps, conversation.id, replyOrigin, append)
      this.dispatchProjectResult(reply)
      return reply
    }
    const entry = append()
    this.emitEntry(entry)

    if (conversation.kind === 'dm') {
      const botId = conversation.botIds[0]
      if (botId) {
        const recipient = store.bots.get(botId)
        const personalWork = recipient?.isPrimary && recipient.name === MAIN_BOT_NAME
        this.track(this.scheduleTurn(conversation.id, botId, { trigger: 'user', mustAnswer: true, inGroup: false,
          chain: [], ...(personalWork && { userRequest: { id: entry.id, seq: entry.seq } }) }))
      }
    } else {
      this.track(this.runCascade(conversation.id, entry))
    }
    return entry
  }

  cancelBrief(workId: Id): void {
    for (const task of this.briefs.assignments(workId)) this.assignments.abort(task.id)
    for (const turn of this.active.values()) {
      const work = this.briefs.rootForTurn(turn.root.turnId) ?? this.briefs.rootForTurn(turn.turnId)
      if (work?.id === workId) turn.abort.abort()
    }
  }

  stop(conversationId: Id): void {
    this.assignments.stopChat(conversationId)
    const run = this.runs.get(conversationId)
    if (!run) return
    for (const cascade of run.cascades) cascade.stopped = true
    run.stop.abort()
    // Turns scheduled after the stop get a fresh signal.
    run.stop = new AbortController()
  }

  reset(conversationId: Id): void {
    const { store, bus } = this.deps
    this.stop(conversationId)
    store.db.prepare('delete from turn_context_receipts where conversation_id=?').run(conversationId)
    store.entries.clear(conversationId)
    store.botContext.clearConversation(conversationId)
    const conversation = store.conversations.get(conversationId)
    if (conversation) bus.emit('conv:changed', { conversation })
  }

  streamingText(conversationId: Id, entryId: Id): string | undefined {
    for (const turn of this.active.values()) {
      if (turn.conversationId !== conversationId) continue
      const text = turn.recorder.streamingText(entryId)
      if (text !== undefined) return text
    }
  }

  liveStates() {
    return this.live.list()
  }

  createGroup(input: { title?: string; botIds: Id[]; settings?: Partial<GroupSettings> }): Conversation {
    const { store, bus } = this.deps
    const botIds = unique(input.botIds)
    if (botIds.length === 0) throw new Error('Pick at least one bot for the group.')
    if (botIds.length > MAX_GROUP_BOTS) throw new Error(`A group can have at most ${MAX_GROUP_BOTS} bots.`)
    const bots = botIds.map((id) => {
      const bot = store.bots.get(id)
      if (!bot) throw new Error('One of the bots no longer exists.')
      return bot
    })
    const title = input.title?.trim() || bots.map((b) => b.name).join(', ')
    const conversation = store.conversations.create({
      kind: 'group',
      title,
      botIds,
      group: normalizeGroupSettings(input.settings)
    })
    bus.emit('conv:changed', { conversation })
    return conversation
  }

  openDm(botId: Id): Conversation {
    const { store, bus } = this.deps
    const bot = store.bots.get(botId)
    if (!bot) throw new Error('Bot not found')
    const existing = store.conversations.findDm(botId)
    if (existing) return existing
    const conversation = store.conversations.create({ kind: 'dm', title: bot.name, botIds: [botId] })
    bus.emit('conv:changed', { conversation })
    return conversation
  }

  async runAutomated(input: { botId: Id; text: string; trigger: EntryTrigger; signal?: AbortSignal; readProjectNote?: ToolContext['readProjectNote']; projectRun?: { projectId: Id; runId: Id }; manifestLite?: { sources: ManifestLiteSource[] } }): Promise<AutomatedRunResult> {
    if (this.closed) throw new Error('faibots is shutting down.')
    const { store } = this.deps
    const text = input.text.trim()
    if (!text) throw new Error('A routine needs something to do.')
    const conversation = this.openDm(input.botId)
    // FaiBots, not the user, speaks here: the bot must not take a routine's words as yours.
    const entry = store.entries.append({
      conversationId: conversation.id,
      kind: 'message',
      author: { kind: 'system' },
      text,
      mentions: [input.botId],
      mentionsEveryone: false,
      attachments: [],
      isStreaming: false,
      trigger: input.trigger
    })
    this.emitEntry(entry)

    const outcome = await this.scheduleTurn(conversation.id, input.botId, {
      trigger: 'routine',
      mustAnswer: true,
      inGroup: false,
      chain: [],
      ...(input.projectRun && { projectRun: input.projectRun }),
      ...(input.manifestLite && { manifestLite: input.manifestLite }),
      readProjectNote: input.readProjectNote,
      ...(input.signal && { parentSignal: input.signal })
    })
    // Include coalesced text as context only. A skipped turn has no verified execution outcome;
    // another turn's partial reply must never promote it to successful completion.
    const posts =
      outcome.posts.length > 0
        ? outcome.posts
        : store.entries.since(conversation.id, entry.seq).filter((e) => e.kind === 'message' && isOwn(e, input.botId))
    const reply = posts.filter((p) => p.kind === 'message').map((p) => p.text).join('\n\n').trim()
    const status: AutomatedRunResult['status'] =
      outcome.status === 'sent' || outcome.status === 'pass' ? 'done' : outcome.status
    return {
      status,
      conversationId: conversation.id,
      entryId: entry.id,
      reply,
      ...(outcome.error && { error: outcome.error }),
      ...(outcome.turnId && { turnId: outcome.turnId })
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true
    for (const id of this.runs.keys()) this.stop(id)
    const settled = Promise.allSettled([...this.background, this.queues.idle()])
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref?.())])
    this.unsubscribe()
    this.live.clear()
  }

  /** Resolves when every scheduled turn and cascade has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background])
    await this.queues.idle()
  }

  // -------------------------------------------------------------------------------------------
  // Collab tools
  // -------------------------------------------------------------------------------------------

  jobHistory(bot: Bot, conversationId: Id) {
    const { db, turns } = this.deps.store
    const running = db.prepare("select count(*) as n from delegations where child_id=? and state='assigned'").get(bot.id)
    const recent = db.prepare(`select d.updated_at-d.created_at as elapsed from delegations d join entries p on p.id=d.parent_entry_id
      where d.child_id=? and p.conversation_id=? and d.state='answered' order by d.updated_at desc limit 20`).all(bot.id,conversationId)
    const times = recent.map(row => Number(row.elapsed)).sort((a,b)=>a-b)
    const middle = Math.floor(times.length/2)
    const medianMs = times.length ? (times.length % 2 ? times[middle]! : (times[middle-1]!+times[middle]!)/2) : null
    const used = bot.dailyRunLimit > 0 ? turns.automaticRunsSince(bot.id,startOfLocalDay(this.now().getTime())) : 0
    const accepted = db.prepare(`select count(distinct w.id) as n from chief_work w join chief_work_turns t on t.work_id=w.id
      join assignment_admissions a on a.root_turn_id=t.turn_id join delegations d on d.id=a.assignment_id
      where w.conversation_id=? and w.state='accepted' and w.partial=0 and d.child_id=? and d.state='answered'`).get(conversationId,bot.id)
    return { running: Number(running?.n ?? 0), remaining: bot.dailyRunLimit > 0 ? Math.max(0,bot.dailyRunLimit-used) : null,
      medianMs, accepted: Number(accepted?.n ?? 0) }
  }

  markPassed(turnId: Id): 'passed' | 'no-turn' | 'must-answer' {
    const turn = this.active.get(turnId)
    if (!turn) return 'no-turn'
    if (turn.mustAnswer) return 'must-answer'
    turn.passed = true
    return 'passed'
  }

  async askBot(ctx: ToolContext, target: Bot, message: string, reason?: string): Promise<{ reply: string; exchange: Conversation }> {
    const { store, bus } = this.deps
    const from = ctx.bot
    if (target.id === from.id) throw new CollabRefusal('You cannot send a message to yourself.')
    if (ctx.chain.includes(target.id)) {
      const names = [...ctx.chain, from.id].map((id) => store.bots.get(id)?.name ?? 'a bot').join(' → ')
      throw new CollabRefusal(
        `${target.name} is already waiting for an answer in this chain (${names}). Asking it would loop; answer with what you have.`
      )
    }
    if (ctx.chain.length >= MAX_CHAIN_DEPTH) {
      throw new CollabRefusal(`This request is already ${MAX_CHAIN_DEPTH} bots deep. Answer with what you have instead of asking another bot.`)
    }
    if (ctx.signal.aborted) throw new CollabRefusal('Cancelled.')

    // Each asked bot may ask others in turn, so without these limits one message could fan out
    // into hundreds of model turns.
    const asking = this.active.get(ctx.turnId)
    if (asking) {
      if (asking.asks >= MAX_ASKS_PER_TURN) {
        throw new CollabRefusal(`You already asked other bots ${MAX_ASKS_PER_TURN} times in this turn. Answer with what you have.`)
      }
    }
    // Bridge call IDs are independent of the engine's card IDs. Never bind a durable return
    // to an unrelated running card merely because it was the last one shown for this tool.
    const candidate = asking?.recorder.findToolEntry(ctx.callId, ['send_to_agent'])
    const card = candidate?.toolCall?.callId === ctx.callId ? candidate : undefined
    const id = ctx.actionId ?? nativeActionId(ctx)
    const detached = this.assignments.isDetached(id)
    const inherited = asking?.root ?? { turnId: ctx.turnId, conversationId: ctx.conversation.id }
    const work = this.briefs.rootForTurn(inherited.turnId) ?? this.briefs.rootForTurn(ctx.turnId)
    if (this.briefs.superseded(ctx.turnId)) throw new CollabRefusal('The owner updated this job. Wait for its new instruction before assigning further work.')
    if (work && work.state !== 'active' && !(work.state === 'waiting' && inherited.parentAssignmentId)) throw new CollabRefusal('This brief is closed or waiting. New work cannot be assigned.')
    const assignmentLimit = work?.assignmentLimit ?? MAX_ASKS_PER_CHAIN
    const root = work ? { ...inherited, turnId: work.rootTurnId } : inherited
    const inputHash = createHash('sha256').update(message.trim()).digest('hex')
    const assignment = this.delegations.assign({ id, callerId: from.id, childId: target.id, parentId: ctx.conversation.id, inputHash }, () => {
      if (!this.delegations.reserve(id, root, assignmentLimit)) {
        const reason = work
          ? `The specialist assignment limit for this job is ${assignmentLimit}. The budget is used or this assignment was already admitted.`
          : `Bots already asked each other ${assignmentLimit} times for this request, or this assignment was already admitted.`
        throw new CollabRefusal(reason + ' Answer with what you have.')
      }
      if (detached && this.delegations.list(from.id, ctx.conversation.id, true).length >= MAX_ASKS_PER_TURN) {
        throw new CollabRefusal(`This chat already has ${MAX_ASKS_PER_TURN} background assignments running.`)
      }
      const parent = card ?? store.entries.append({
        conversationId: ctx.conversation.id, kind: 'event', author: { kind: 'system' },
        text: detached ? `Assigned ${target.name} background work (${id}).` : `Messaging ${target.name}`,
        ...(reason && !ctx.projectResultTrigger && { meta: { selectionReason: this.deps.secrets.redact(reason) } }),
        ...(detached && { clientNonce: backgroundAnchor(id) }), mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false
      })
      if (detached && (parent.kind !== 'event' || parent.author.kind !== 'system')) throw new CollabRefusal('The assignment anchor is already in use.')
      const origin = { conversationId: ctx.conversation.id, entryId: parent.id, fromBotId: from.id }
      const found = store.conversations.findExchange(from.id, target.id)
      const exchange = found ??
        store.conversations.create({ kind: 'exchange', title: `${from.name} ↔ ${target.name}`, botIds: [from.id, target.id], origin })
      const question = store.entries.append({
        conversationId: exchange.id, kind: 'message', author: { kind: 'bot', botId: from.id }, meta: { turnId: ctx.turnId },
        text: this.deps.secrets.redact(message.trim()), mentions: [target.id], mentionsEveryone: false, attachments: [], isStreaming: false
      })
      return { parent, question }
    })
    if (assignment.existing) {
      const work = assignment.existing
      if (work.state === 'answered' && work.receipt) {
        return { reply: work.receipt.text, exchange: store.conversations.get(work.exchangeId)! }
      }
      throw new CollabError(work.receipt?.text ?? 'The delegated task is already running.', work.receipt?.partial, work.exchangeId)
    }
    const { lease, parent, question } = assignment
    if (asking) asking.asks++
    const exchange = store.conversations.get(question.conversationId)!
    bus.emit('conv:changed', { conversation: exchange })
    if (card) asking?.recorder.annotateTool(card.id, { title: `Messaging ${target.name}`, exchangeConversationId: exchange.id })
    else this.emitEntry(parent)
    this.emitEntry(question)
    this.assignments.admitted(lease, exchange.id)

    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), this.exchangeTimeoutMs)
    let failure: 'failed' | 'reconciliation_required' = 'reconciliation_required'
    let reply: string
    let lateReply: string | undefined
    try {
      const outcome = await this.scheduleTurn(exchange.id, target.id, {
        trigger: 'agent',
        mustAnswer: true,
        inGroup: false,
        ...(asking?.projectRun && { projectRun: asking.projectRun }),
        assignment: { lease, questionId: question.id, questionSeq: question.seq, origin: { conversationId: ctx.conversation.id, entryId: parent.id, fromBotId: from.id } },
        chain: [...ctx.chain, from.id],
        parentSignal: AbortSignal.any([ctx.signal, timeout.signal]),
        root: { ...root, parentAssignmentId: id }
      })
      lateReply = outcome.lateReply
      reply = truncateText(this.deps.secrets.redact(outcome.posts.map((p) => p.text).join('\n\n').trim()), MAX_RESULT_CHARS)
      const partial = reply || undefined
      if (ctx.signal.aborted) throw new CollabError('Cancelled.', partial, exchange.id)
      if (timeout.signal.aborted) {
        const ms = this.exchangeTimeoutMs
        const limit = ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.max(1, Math.round(ms / 1000))} seconds`
        throw new CollabError(`${target.name} did not answer within ${limit}.`, partial, exchange.id)
      }
      if (outcome.status !== 'cancelled' && !outcome.needsReconciliation) failure = 'failed'
      const failed = Boolean(outcome.error) || outcome.status === 'error' || outcome.status === 'cancelled' || outcome.status === 'limited'
      if (failed) {
        const reason = outcome.error ?? `its turn ended as ${outcome.status}`
        throw new CollabError(`${target.name} could not answer: ${reason}`, partial, exchange.id)
      }
      if (!reply) throw new CollabError(`${target.name} did not reply.`, undefined, exchange.id)
    } catch (error) {
      const text = this.deps.secrets.redact(error instanceof Error ? error.message : String(error))
      const partial = error instanceof CollabError && error.partial ? this.deps.secrets.redact(error.partial) : undefined
      const work = this.delegations.get(id)
      if (work?.state === 'reconciliation_required') {
        if (lateReply) this.delegations.retainLate(lease, lateReply)
        throw new CollabError(work.receipt?.text ?? text, partial, exchange.id)
      }
      const resultEntry = this.delegations.finish(lease, failure, { text, ...(partial && { partial }) })
      if (lateReply) this.delegations.retainLate(lease, lateReply)
      if (resultEntry) this.emitEntry(resultEntry)
      this.wakeBriefs()
      if (!card) this.emitEntry(store.entries.get(parent.id)!)
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (this.delegations.get(id)?.state === 'reconciliation_required') {
      this.delegations.retainLate(lease, reply)
      throw new CollabError('The delegation was already closed. Its late reply remains a separate observation.', undefined, exchange.id)
    }
    const resultEntry = this.delegations.finish(lease, 'answered', { text: reply, responder: this.deps.secrets.redact(`${target.name} (@${target.handle})`) })
    if (resultEntry) this.emitEntry(resultEntry)
    this.wakeBriefs()
    if (!card) this.emitEntry(store.entries.get(parent.id)!)
    return { reply, exchange }
  }

  // -------------------------------------------------------------------------------------------
  // Rounds
  // -------------------------------------------------------------------------------------------

  private async runCascade(conversationId: Id, trigger: Entry): Promise<void> {
    const run = this.runFor(conversationId)
    // A new user message replaces older cascades: they finish their round and stop.
    for (const older of run.cascades) older.superseded = true
    const first = this.deps.store.conversations.get(conversationId)
    if (!first) return
    const settings = normalizeGroupSettings(first.group)
    const cascade = new Cascade(settings.maxBotPosts)
    run.cascades.add(cascade)
    const stopSignal = run.stop.signal
    try {
      let offered: Entry[] = [trigger]
      for (let round = 1; round <= settings.maxRounds; round++) {
        if (stopSignal.aborted || cascade.stopped) return
        const conversation = this.deps.store.conversations.get(conversationId)
        if (!conversation) return
        const members = this.membersOf(conversation)
        const participants =
          round === 1
            ? await this.firstRound(members, trigger, settings.turnPolicy, stopSignal)
            : this.followUpRound(members, offered, settings.turnPolicy)
        if (participants.length === 0 || stopSignal.aborted) return

        const isWindingDown = round > 1 && round === settings.maxRounds
        const turn = (p: Participant) =>
          this.scheduleTurn(conversationId, p.bot.id, {
            trigger: round === 1 ? 'user' : 'group',
            mustAnswer: p.mustAnswer,
            isWindingDown,
            inGroup: true,
            chain: [],
            cascade
          })
        const outcomes: TurnOutcome[] = []
        if (settings.parallel) {
          outcomes.push(...(await Promise.all(participants.map(turn))))
        } else {
          for (const p of participants) {
            if (stopSignal.aborted || cascade.stopped) break
            outcomes.push(await turn(p))
          }
        }
        if (stopSignal.aborted || cascade.stopped) return
        const posts = outcomes.flatMap((o) => o.posts)

        if (cascade.refused > 0) {
          this.systemEvent(conversationId, `Reached the limit of ${settings.maxBotPosts} bot replies for one message.`)
          return
        }
        const passed = outcomes.some((o) => o.status === 'pass') && outcomes.every((o) => o.status === 'pass' || o.status === 'skipped')
        if (round === 1 && posts.length === 0 && passed && participants.every((p) => !p.mustAnswer)) {
          this.systemEvent(conversationId, 'No one had anything to add. @mention a bot to ask it directly.')
        }
        if (posts.length === 0 || !settings.allowBotToBot || cascade.superseded || cascade.exhausted) return
        offered = posts
      }
    } finally {
      run.cascades.delete(cascade)
    }
  }

  private async firstRound(members: Bot[], trigger: Entry, policy: GroupTurnPolicy, signal: AbortSignal): Promise<Participant[]> {
    if (members.length === 0) return []
    if (trigger.mentionsEveryone) return members.map((bot) => ({ bot, mustAnswer: true }))
    const mentioned = members.filter((b) => trigger.mentions.includes(b.id))
    if (mentioned.length > 0) return mentioned.map((bot) => ({ bot, mustAnswer: true }))
    if (policy === 'mentions') {
      const primary = members.find((b) => b.isPrimary) ?? members[0]!
      return [{ bot: primary, mustAnswer: true }]
    }
    if (policy === 'router') {
      const picked = await this.route(members, trigger.text, signal)
      if (picked) return members.filter((b) => picked.includes(b.id)).map((bot) => ({ bot, mustAnswer: true }))
    }
    return members.map((bot) => ({ bot, mustAnswer: false }))
  }

  /** Round k+1: the other members get the new posts; mentioned ones must answer. */
  private followUpRound(members: Bot[], offered: Entry[], policy: GroupTurnPolicy): Participant[] {
    const out: Participant[] = []
    for (const bot of members) {
      const fromOthers = offered.filter((p) => !isOwn(p, bot.id))
      if (fromOthers.length === 0) continue
      const mentioned = fromOthers.some((p) => p.mentionsEveryone || p.mentions.includes(bot.id))
      if (mentioned) out.push({ bot, mustAnswer: true })
      else if (policy === 'open') out.push({ bot, mustAnswer: false })
    }
    return out
  }

  /** Router policy: settings.defaultModel picks who answers. Undefined = fall back to open. */
  private async route(members: Bot[], text: string, signal: AbortSignal): Promise<Id[] | undefined> {
    const { store, providers } = this.deps
    const settings = store.settings.get()
    if (!settings.defaultModel) return undefined
    try {
      const route = providers.resolve(settings.defaultModel)
      if (route.engine !== 'native') return undefined
      return await routeMessage({
        adapter: providers.adapterFor(route.provider),
        modelId: route.modelId,
        members,
        userName: settings.userName,
        text,
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      })
    } catch (err) {
      if (!signal.aborted) console.warn('[runtime] router unavailable:', err instanceof Error ? err.message : String(err))
      return undefined
    }
  }

  // -------------------------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------------------------

  private wakeBriefs(): void {
    if (this.closed) return
    for (const wake of this.briefs.ready(this.deps.store.entries)) {
      if (this.scheduledWakes.has(wake.entryId)) continue
      const chat = this.deps.store.conversations.get(wake.chat)
      const bot = chat?.kind === 'dm' && this.deps.store.bots.get(chat.botIds[0]!)
      if (!bot || !bot.isPrimary) continue
      const entry = this.deps.store.entries.get(wake.entryId)
      if (!entry) continue
      this.scheduledWakes.add(wake.entryId)
      this.emitEntry(entry)
      this.deps.bus.emit('work:changed', { conversationId: wake.chat })
      this.track(this.scheduleTurn(wake.chat,bot.id,{trigger:'agent',mustAnswer:true,inGroup:false,chain:[],wake}).then(outcome => {
        this.briefs.finishWake(wake.id,wake.revision,outcome.status === 'sent' || outcome.status === 'pass')
      }).finally(() => this.scheduledWakes.delete(wake.entryId)))
    }
  }

  private recoverProjectResults(): void {
    if (this.closed) return
    const { store } = this.deps
    for (const row of store.db.prepare("select * from project_result_requests where state='started'").all()) {
      const finished = store.db.prepare('select 1 from turns where id=?').get(row.turn_id!)
      store.db.prepare('update project_result_requests set state=? where id=?').run(finished ? 'finished':'interrupted',row.id!)
      if (!finished) this.systemEvent(String(row.conversation_id), 'The app closed while fai was answering a selected project result. Review any existing reply. You can ask again from the project.')
    }
    for (const row of store.db.prepare("select entry_id from project_result_requests where state='queued' order by rowid").all()) {
      const entry = store.entries.get(String(row.entry_id))
      if (entry) this.dispatchProjectResult(entry)
    }
  }

  private dispatchProjectResult(entry: Entry): void {
    const { store } = this.deps
    if (this.closed || this.scheduledResults.has(entry.id)) return
    const row = store.db.prepare("select owner_id from project_result_requests where entry_id=? and conversation_id=? and state='queued'").get(entry.id,entry.conversationId)
    if (!row) return
    this.scheduledResults.add(entry.id)
    this.emitEntry(entry)
    this.track(this.scheduleTurn(entry.conversationId, String(row.owner_id), {trigger:'user',mustAnswer:true,inGroup:false,chain:[],
      userRequest:{id:entry.id,seq:entry.seq}}).then(() => {
      if (!this.closed) store.db.prepare("update project_result_requests set state='finished' where entry_id=? and state in ('queued','started')").run(entry.id)
    }).finally(() => this.scheduledResults.delete(entry.id)))
  }

  private scheduleTurn(conversationId: Id, botId: Id, req: TurnRequest): Promise<TurnOutcome> {
    // Captured now, so a Stop also cancels turns still waiting in the queue.
    const stopSignal = this.runFor(conversationId).stop.signal
    return this.queues.run(`${conversationId}\u0000${botId}`, async () => {
      if (stopSignal.aborted || req.parentSignal?.aborted || this.closed) return { status: 'cancelled', posts: [] }
      return this.runTurn(conversationId, botId, req, stopSignal)
    })
  }

  private async runTurn(conversationId: Id, botId: Id, req: TurnRequest, stopSignal: AbortSignal): Promise<TurnOutcome> {
    const { store, bus, providers, tools, secrets } = this.deps
    const conversation = req.assignment ? store.conversations.update(conversationId, { origin: req.assignment.origin }) : store.conversations.get(conversationId)
    const bot = store.bots.get(botId)
    if (!conversation || !bot || !conversation.botIds.includes(botId)) return { status: 'skipped', posts: [] }

    const context = store.botContext.get(conversationId, botId)
    // An assignment can only consume its own question. A second one may already be queued in this exchange.
    const wakeEntry = req.wake ? store.entries.get(req.wake.entryId) : undefined
    const triggerEntry = wakeEntry ?? (req.userRequest && store.entries.get(req.userRequest.id))
    const resultOrigin = triggerEntry && projectResultOrigin(store,conversationId,triggerEntry,req.wake)
    const selectedResultTrigger = resultOrigin ? triggerEntry : undefined
    if (selectedResultTrigger && selectedResultTrigger.id !== resultOrigin)
      store.entries.update(selectedResultTrigger.id,{meta:{...selectedResultTrigger.meta,selectedResultEntryId:resultOrigin}})
    const upToSeq = req.userRequest?.seq ?? wakeEntry?.seq ?? req.assignment?.questionSeq ?? store.entries.page(conversationId, { limit: 1 }).entries[0]?.seq ?? context.lastSeenSeq
    const unseen = selectedResultTrigger ? [selectedResultTrigger] : wakeEntry ? [wakeEntry] : store.entries.since(conversationId, context.lastSeenSeq).filter((e) => e.seq <= upToSeq && e.kind === 'message' && !isOwn(e, botId))
    // Nothing new (an earlier queued turn already answered it): no model call.
    if (unseen.length === 0) return { status: 'skipped', posts: [] }

    let route: ReturnType<RuntimeProviders['resolve']> | undefined
    let routeError: string | undefined
    try {
      route = providers.resolve(bot.model)
    } catch (err) {
      routeError = err instanceof Error ? err.message : String(err)
    }

    const abort = new AbortController()
    const signal = AbortSignal.any([stopSignal, abort.signal, ...(req.parentSignal ? [req.parentSignal] : [])])
    const members = this.membersOf(conversation)
    const turnId = randomUUID()
    if (selectedResultTrigger?.id === resultOrigin && resultOrigin) {
      const claimed = store.db.prepare("update project_result_requests set state='started',turn_id=? where entry_id=? and state='queued'").run(turnId,resultOrigin)
      if (!claimed.changes) return {status:'skipped',posts:[]}
    }
    if (req.wake && !this.briefs.claimWake(req.wake.id,req.wake.revision,turnId)) return { status:'skipped',posts:[] }
    let resultWithdrawn = false
    const selectedResultAvailable: (() => boolean) | undefined = resultOrigin ? () => {
      if (resultWithdrawn) return false
      if (projectResultForEntry(store, this.deps.dataDir, this.deps.attachments, conversationId, resultOrigin)?.status === 'available') return true
      resultWithdrawn = true
      recorder.withdrawSelectedResult()
      return false
    } : undefined
    let lateBuffer = ''
    const recorder: TurnRecorder = new TurnRecorder(
      { store, bus, live: this.live, redact: (s) => secrets.redact(s) },
      {
        turnId,
        bot,
        conversation,
        members,
        ...(req.userRequest && { replyToId: req.userRequest.id }),
        ...(req.assignment && { replyToId: req.assignment.questionId }),
        ...(wakeEntry && { replyToId: wakeEntry.id }),
        signal,
        selectedResultAvailable,
        ...(req.assignment && { onLateText: (delta: string) => {
          if (lateBuffer.length < 8192) lateBuffer += delta.slice(0, 8192 - lateBuffer.length)
        } }),
        ...(route && { meta: { providerId: route.provider.id, modelId: route.modelId, ...(selectedResultTrigger && {selectedResultEntryId:resultOrigin}) } }),
        ...(req.cascade && { reservePost: () => req.cascade!.reserve(), onRefused: () => abort.abort() })
      }
    )
    const active: ActiveTurn = {
      turnId, bot, conversationId, recorder, abort, mustAnswer: req.mustAnswer, passed: false, waiting: 0,
      ...(req.projectRun && { projectRun: req.projectRun }),
      asks: 0, root: req.root ?? { turnId, conversationId }, unresolvedActions: new Set()
    }

    if (!route) {
      // In an open group round a bot without a model just sits out; asked directly, it says why.
      // Its messages stay unseen, so it catches up once it has a model.
      if (req.mustAnswer) {
        recorder.event(`${bot.name} could not answer: ${routeError}`)
        if (selectedResultAvailable) recorder.finish(false, true)
      }
      return { status: req.mustAnswer ? 'error' : 'skipped', posts: [], ...(routeError && { error: routeError }) }
    }
    if (signal.aborted) return { status: 'cancelled', posts: [] }
    const startedAt = this.now().getTime()
    if ((req.trigger === 'agent' || req.trigger === 'routine') &&
      !store.turns.reserveAutomatic({ id: turnId, botId, startedAt, rootTurnId: req.root?.turnId ?? turnId })) {
      const limit = store.bots.get(botId)?.dailyRunLimit ?? bot.dailyRunLimit
      const limited = `${bot.name} reached its daily limit of ${limit} automatic run${limit === 1 ? '' : 's'}. Raise it in ${bot.name}'s Profile, or wait until tomorrow.`
      if (req.trigger === 'routine') this.systemEvent(conversationId, limited)
      return { status: 'limited', posts: [], error: limited }
    }
    store.botContext.set({ ...context, lastSeenSeq: Math.max(context.lastSeenSeq,upToSeq) })

    this.active.set(turnId, active)
    recorder.phase('reading')
    let error: string | undefined
    try {
      const engine = this.options.engines[route.engine]
      const settings = store.settings.get()
      const workspaceDir = join(settings.workspaceRoot, bot.handle)
      const excluded: Record<'scope' | 'permission', string[]> = { scope: [], permission: [] }
      const projectResultTrigger = selectedResultTrigger && {entryId:selectedResultTrigger.id, ...(req.wake && {wake:req.wake})}
      const turnTools = await tools.forTurn({ bot, conversation, inGroup: req.inGroup, projectResultTrigger }, (name, reason) => excluded[reason].push(name))
      const mcpTools = new Map<string, { serverId: Id; remoteName: string }>()
      for (const t of turnTools) if (t.serverId && t.remoteName) mcpTools.set(t.name, { serverId: t.serverId, remoteName: t.remoteName })
      const userEntry = [...unseen].reverse().find((entry) => entry.author.kind === 'user')
      const toolContext: Omit<ToolContext, 'callId'> = {
        ...(userEntry && { userEntryId: userEntry.id }),
        projectResultTrigger,
        selectedResultAvailable,
        bot,
        conversation,
        turnId,
        signal,
        chain: req.chain,
        inGroup: req.inGroup,
        workspaceDir,
        readProjectNote: req.readProjectNote,
        mcpTools,
        admittedTools: new Set(turnTools.map((tool) => tool.name))
      }
      const others = members.filter((b) => b.id !== bot.id)
      const lastAsker = [...unseen].reverse().find((e) => e.author.kind === 'bot')
      const asker = lastAsker?.author.kind === 'bot' ? store.bots.get(lastAsker.author.botId) : undefined
      const system = buildSystemPrompt({
        bot,
        conversation,
        others,
        ...(asker && { asker }),
        userName: settings.userName,
        memoryBlock: this.deps.memory.promptBlock(bot.id),
        skillsBlock: this.deps.skills.promptBlock(bot.id),
        mcpInstructions: this.deps.mcp.instructionsForBot(bot),
        workspaceDir,
        now: this.now(),
        platform: process.platform,
        engine: route.engine,
        ...(req.manifestLite && { manifestLite: req.manifestLite })
      })
      const userName = settings.userName
      if (req.assignment) {
        const systemHash = createHash('sha256').update(JSON.stringify([system.stable, system.volatile])).digest('hex')
        this.delegations.pin(req.assignment.lease, route.engine, systemHash)
      }
      const labels = new Map(turnTools.map((t) => [t.name, t.activityLabel]))
      // The app may have closed or waited in the queue after the owner clicked. Recheck before
      // the configured provider sees even the new instruction, which can itself quote the source.
      if (selectedResultTrigger && resultOrigin &&
        (projectResultOrigin(store, conversationId, selectedResultTrigger, req.wake) !== resultOrigin ||
          !selectedResultAvailable?.())) {
        recorder.event(SELECTED_RESULT_WITHHELD)
        return { status: 'skipped', posts: [] }
      }
      await engine.run({
        turnId,
        bot,
        conversation,
        route,
        system,
        tools: turnTools,
        disclose: (admitted, entries, omissions) => {
          if (signal.aborted) return
          const catalog = new Map(turnTools.map((tool) => [tool.name, tool]))
          const sources = attachmentContext(entries, this.deps)
          if (req.projectRun && req.manifestLite) sources.push(...projectSelections(store, req.projectRun.projectId, req.projectRun.runId))
          saveTurnContext(store, {
            id: turnId, botId, createdAt: startedAt, scopeId: conversationId, route: conversation.kind,
            engine: route.engine, providerId: route.provider.id, modelId: safeModelId(route.modelId, (v) => secrets.redact(v)),
            ...(req.projectRun && { projectId: req.projectRun.projectId }),
            sources, omissions: [...omissions,
              ...(selectedResultTrigger ? ['Only the selected project result is available through read_project_result. It is checked at each tool call. Earlier chat messages and prior project summaries are excluded.'] : []),
              ...(req.projectRun && !req.manifestLite ? ['No project file access was passed to this turn.'] : []),
              ...(excluded.permission.length ? [`Turned off by permission: ${excluded.permission.join(', ')}.`] : []),
              ...(excluded.scope.length ? [`Outside this bot or chat scope: ${excluded.scope.join(', ')}.`] : [])],
            tools: admitted.map((tool) => {
              const def = catalog.get(tool.name)!
              return { ...tool, permission: def.effectivePermission ?? def.defaultPermission,
                ...(def.autoAllowedInWorkspace && { workspaceException: true }) }
            })
          })
        },
        toolContext,
        context: selectedResultTrigger ? {botId,conversationId,lastSeenSeq:0,summarizedUpToSeq:0,summary:''} : context,
        selectedResultTrigger,
        upToSeq,
        turnNote: [turnNote({ inGroup: req.inGroup, mustAnswer: req.mustAnswer, isWindingDown: !!req.isWindingDown }),
          ...(req.wake ? [`Resume the specialist returns for work ${req.wake.id}. Check this work and its assignment receipts before submitting a result.`] : []),
          ...(selectedResultTrigger ? ['Use read_project_result for the owner’s selected evidence and instruction. If access is withheld, explain that. Cite the actual source revision and line.'] : [])
        ].filter(Boolean).join('\n'),
        recorder,
        signal,
        nameOf: (author) => speakerName(author, (id) => store.bots.get(id), userName),
        activityFor: (name, input) => this.activityFor(labels, name, input),
        passed: () => active.passed,
        runTool: (call) => this.runTool(recorder, toolContext, turnTools, call),
        // After a stop or reset, an engine's late state (an old session id) must not come back.
        saveContext: (patch) => {
          if (!signal.aborted && !selectedResultTrigger) store.botContext.set({ ...store.botContext.get(conversationId, botId), ...patch })
        }
      })
      if (active.unresolvedActions.size > 0 && !signal.aborted) throw new Error('A tool action remains unresolved or its outcome is unknown. Reconcile it before accepting this run.')
    } catch (err) {
      if (!signal.aborted) {
        error = selectedResultAvailable ? SELECTED_RESULT_ERROR : secrets.redact(err instanceof Error ? err.message : String(err))
        if (!(err instanceof IncompleteTurnError)) recorder.event(`${bot.name} could not answer: ${error}`)
      }
    } finally {
      this.active.delete(turnId)
      error = recorder.finish(signal.aborted, !!error) ?? error
      this.live.idle(bot.id, conversationId)
    }

    this.wakeBriefs()
    const posts = recorder.posts
    const outcome: TurnOutcome = error
      ? { status: 'error', posts, error }
      : signal.aborted
        ? { status: 'cancelled', posts }
        : { status: posts.length > 0 ? 'sent' : 'pass', posts }
    if (active.unresolvedActions.size) outcome.needsReconciliation = true
    store.turns.record({
      id: turnId,
      rootTurnId: req.root?.turnId ?? turnId,
      botId,
      conversationId,
      conversationKind: conversation.kind,
      trigger: req.trigger,
      status: outcome.status === 'error' || outcome.status === 'cancelled' || outcome.status === 'sent' ? outcome.status : 'pass',
      providerId: route.provider.id,
      modelId: route.modelId,
      ...(route.engine === 'codex' && { codexUsageState: 'unknown' as const }),
      ...recorder.usageTotals,
      startedAt,
      endedAt: Date.now(),
      ...(error && { error })
    })
    return { ...outcome, turnId, ...(lateBuffer && { lateReply: secrets.redact(lateBuffer).slice(0, 4000) }) }
  }

  private async runTool(
    recorder: TurnRecorder,
    toolContext: Omit<ToolContext, 'callId'>,
    turnTools: ToolDefinition[],
    call: ToolCallRequest
  ): Promise<ToolResult> {
    const labels = new Map(turnTools.map((t) => [t.name, t.activityLabel]))
    const title = this.activityFor(labels, call.name, call.input)
    const ctx = { ...toolContext, callId: call.id }
    const actionId = nativeActionId(ctx)
    recorder.toolStart(call.id, call.name, title, call.input, actionId)
    recorder.phase('tool', title)
    let result: ToolResult
    if (call.inputError) {
      result = errorResult(`Your call to ${call.name} could not be used: ${call.inputError}`)
    } else {
      result = await this.deps.tools.execute(call.name, call.input, { ...ctx, actionId })
    }
    recorder.toolEnd(call.id, result, toolContext.signal.aborted)
    if (call.name === 'send_to_agent' && !result.recovery) {
      const card = recorder.findToolEntry(call.id, ['send_to_agent'])
      if (card?.toolCall?.actionId === actionId && card.toolCall.status !== 'running') this.delegations.acknowledge(actionId, card.id)
    }
    const active = this.active.get(toolContext.turnId)
    if (result.recovery) active?.unresolvedActions.add(result.recovery.actionId)
    else if (!result.isError) active?.unresolvedActions.delete(actionId)
    recorder.phase('thinking')
    return result
  }

  private activityFor(labels: Map<string, string>, name: string, input?: unknown): string {
    if (name === 'send_to_agent' && input && typeof input === 'object') {
      const to = (input as { to?: unknown }).to
      const target = typeof to === 'string' ? findBot(this.deps.store.bots.list(), to) : undefined
      return target ? `Messaging ${target.name}` : 'Messaging another bot'
    }
    return labels.get(name) ?? (name.startsWith('mcp__') ? `Using ${name.split('__')[1] ?? 'a connector'}` : `Using ${name}`)
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /**
   * After a crash or a forced quit, the newest entries can still say "streaming" or "running".
   * The application owns a single-instance lock. Run once before workers start.
   * An interrupted dispatch is unknown, not proof that the external action was cancelled.
   */
  private recoverInterruptedTurns(): void {
    const { store } = this.deps
    store.actions.recoverInterrupted()
    for (const entry of store.entries.interrupted()) {
        try {
          if (entry.isStreaming) store.entries.update(entry.id, { isStreaming: false })
          if (entry.toolCall?.status === 'running') {
            const action = entry.toolCall.actionId ? store.actions.get(entry.toolCall.actionId) : undefined
            const unknown = action?.state === 'unknown'
            const result = action?.receipt
            store.entries.update(entry.id, { toolCall: { ...entry.toolCall,
              status: unknown ? 'error' : result ? toolStatus(result, false) : 'cancelled',
              ...(unknown ? { resultText: 'Outcome unknown after interruption. Reconcile this action before retrying.' } :
                result ? { resultText: resultPreview(result) } : {}) } })
          }
        } catch (err) {
          console.warn('[runtime] could not tidy an interrupted entry:', err instanceof Error ? err.message : String(err))
        }
    }
  }

  private runFor(conversationId: Id): ConversationRun {
    let run = this.runs.get(conversationId)
    if (!run) {
      run = { stop: new AbortController(), cascades: new Set() }
      this.runs.set(conversationId, run)
    }
    return run
  }

  private membersOf(conversation: Conversation): Bot[] {
    return conversation.botIds.map((id) => this.deps.store.bots.get(id)).filter((b): b is Bot => !!b)
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((err) => {
      console.error('[runtime] background task failed:', err instanceof Error ? err.message : String(err))
    })
    this.background.add(tracked)
    void tracked.finally(() => this.background.delete(tracked))
  }

  private emitEntry(entry: Entry): void {
    const { store, bus } = this.deps
    bus.emit('conv:entry', { entry })
    const conversation = store.conversations.get(entry.conversationId)
    if (conversation) bus.emit('conv:changed', { conversation })
  }

  /** A system line in a conversation ("No one had anything to add…"). */
  private systemEvent(conversationId: Id, text: string): void {
    const entry = this.deps.store.entries.append({
      conversationId,
      kind: 'event',
      author: { kind: 'system' },
      text,
      mentions: [],
      mentionsEveryone: false,
      attachments: [],
      isStreaming: false
    })
    this.emitEntry(entry)
  }

  /** conv:changed for a conversation and, for an exchange, the conversation its chain started in. */
  private emitConversationAndRoot(conversationId: Id): void {
    const { store, bus } = this.deps
    let current = store.conversations.get(conversationId)
    for (let depth = 0; current && depth < 10; depth++) {
      bus.emit('conv:changed', { conversation: current })
      if (current.kind !== 'exchange' || !current.origin) return
      current = store.conversations.get(current.origin.conversationId)
    }
  }
}
