// Everything a bot turn shows in the chat goes through one TurnRecorder, whatever the engine:
//   - each text segment becomes a `message` entry, created on its first words (isStreaming), fed
//     with `conv:delta`, and finalised with its @mentions when the segment ends
//   - each tool call becomes a `tool-call` entry: running → done / error / denied / cancelled
//   - problems become `event` lines
//   - the bot's live phase (reading, thinking, typing, tool) follows along
// Every append also re-sends the conversation (`conv:changed`) because lastEntryAt / unread moved.

import type { Bot, BotPhase, Conversation, Entry, Id, ToolCallInfo } from '@shared/domain'
import type { EventBus, Store, ToolResult } from '../contracts'
import type { LiveStates } from './live-state'
import { parseMentions } from './mentions'

export interface RecorderDeps {
  store: Pick<Store, 'entries' | 'conversations'>
  bus: EventBus
  live: LiveStates
  redact(text: string): string
}

export interface RecorderOptions {
  turnId?: Id
  bot: Bot
  conversation: Conversation
  /** Bots that can be @mentioned from this conversation (its members). */
  members: Bot[]
  replyToId?: Id
  meta?: Entry['meta']
  /** Selected evidence stays in this turn until the host checks its live authority at delivery. */
  selectedResultAvailable?(): boolean
  /** Once aborted (Stop, reset), late text and tool calls from the engine are dropped. */
  signal?: AbortSignal
  /**
   * Asked before every message entry the turn creates (one post each). Returning false means the
   * post budget of the group round is spent: nothing more is posted (earlier messages stay) and
   * onRefused stops the turn.
   */
  /** A delegated worker may retain a bounded, separately scoped observation after cancellation. */
  onLateText?(delta: string): void
  reservePost?(): boolean
  onRefused?(): void
}

/** Text the tool registry uses when the user said no, or the tool is turned off. */
const DENIED = /^(The user declined this action|.+ is turned off for you)/

const CARD_RESULT_CHARS = 2_000
export const SELECTED_RESULT_WITHHELD = 'The selected project result is unavailable. Check its sources in the project before asking fai again.'
export const SELECTED_RESULT_ERROR = 'fai could not finish its reply to the selected project result.'
/**
 * Tools that leave no card in the chat. A pass is the normal outcome for most members of a
 * group round; a card for each one would bury the actual replies.
 */
const SILENT_TOOLS = new Set(['pass_turn'])

function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]))
  }
  return value
}

export function toolStatus(result: ToolResult, aborted: boolean): ToolCallInfo['status'] {
  if (result.recovery) return 'error'
  const text = result.content.find((c) => c.type === 'text')?.text ?? ''
  if (!result.isError) return 'done'
  if (result.outcome) return result.outcome
  if (aborted || text === 'Cancelled.') return 'cancelled'
  if (DENIED.test(text)) return 'denied' // results that crossed a text-only boundary (MCP)
  return 'error'
}

export function resultPreview(result: ToolResult): string {
  const text = result.content
    .map((c) => (c.type === 'text' ? c.text : `[image ${c.mediaType}]`))
    .join('\n')
    .trim()
  return text.length > CARD_RESULT_CHARS ? `${text.slice(0, CARD_RESULT_CHARS)}…` : text
}

export class TurnRecorder {
  /** Finalised message entries of this turn, in order. */
  readonly posts: Entry[] = []
  private current: { entry: Entry; text: string } | undefined
  private pending = ''
  private readonly tools = new Map<string, Entry>()
  private refused = false
  private phaseNow: { phase: BotPhase; activity?: string } | undefined
  private usage = { inputTokens: 0, outputTokens: 0 }
  private usageCoverage: 'none' | 'complete' | 'incomplete' = 'none'
  private codexUsageState?: 'measured' | 'unknown'
  private held?: { text: string; separate: boolean; failed: boolean; overflow: boolean; withdrawn: boolean; closed: boolean }

  constructor(
    private readonly deps: RecorderDeps,
    private readonly opts: RecorderOptions
  ) {
    if (opts.selectedResultAvailable)
      this.held = { text: '', separate: false, failed: false, overflow: false, withdrawn: false, closed: false }
  }

  get bot(): Bot {
    return this.opts.bot
  }

  get conversationId(): Id {
    return this.opts.conversation.id
  }

  streamingText(entryId: Id): string | undefined {
    return this.current?.entry.id === entryId ? this.current.text : undefined
  }

  /** True when the post budget stopped this turn. */
  get budgetRefused(): boolean {
    return this.refused
  }

  /**
   * The conversation can disappear under a running turn (deleted, reset, its bot deleted).
   * Writes then fail quietly instead of breaking the turn's clean-up.
   */
  private append(entry: Omit<Entry, 'id' | 'seq' | 'createdAt' | 'updatedAt'>): Entry | undefined {
    let stored: Entry
    try {
      stored = this.deps.store.entries.append(this.opts.turnId
        ? { ...entry, meta: { ...entry.meta, ...(this.opts.meta?.projectScoped && { projectScoped: true }), turnId: this.opts.turnId } } : entry)
    } catch {
      return undefined
    }
    this.deps.bus.emit('conv:entry', { entry: stored })
    const conversation = this.deps.store.conversations.get(stored.conversationId)
    if (conversation) this.deps.bus.emit('conv:changed', { conversation })
    return stored
  }

  private update(id: Id, patch: Partial<Entry>): Entry | undefined {
    let entry: Entry
    try {
      entry = this.deps.store.entries.update(id, patch)
    } catch {
      return undefined
    }
    this.deps.bus.emit('conv:entry', { entry })
    return entry
  }

  phase(phase: BotPhase, activity?: string): void {
    if (this.opts.signal?.aborted || this.held?.closed) return
    if (this.held && activity) activity = 'Working on the selected project result'
    this.phaseNow = { phase, ...(activity && { activity }) }
    this.deps.live.set(this.opts.bot.id, this.opts.conversation.id, phase, activity)
  }

  get currentPhase(): { phase: BotPhase; activity?: string } | undefined {
    return this.phaseNow
  }

  withdrawSelectedResult(): void {
    if (!this.held) return
    this.held.text = ''
    this.held.withdrawn = true
  }

  /** Stream text into the current message (created on the first non-blank text). */
  textDelta(delta: string): void {
    if (this.refused || !delta || this.held?.closed) return
    if (this.opts.signal?.aborted) {
      this.opts.onLateText?.(delta)
      return
    }
    if (this.held) {
      if (this.held.overflow || this.held.withdrawn) return
      if (this.held.text.length + delta.length > 512 * 1024) {
        this.held.overflow = true
        this.held.text = ''
        return
      }
      if (this.held.separate && this.held.text) this.held.text += '\n\n'
      this.held.text += delta
      this.held.separate = false
      return
    }
    if (!this.current) {
      this.pending += delta
      if (!this.pending.trim()) return
      if (this.opts.reservePost && !this.opts.reservePost()) {
        this.refused = true
        this.pending = ''
        this.opts.onRefused?.()
        return
      }
      delta = this.pending.trimStart()
      this.pending = ''
      const entry = this.append({
        conversationId: this.opts.conversation.id,
        kind: 'message',
        ...(this.opts.replyToId && { replyToId: this.opts.replyToId }),
        author: { kind: 'bot', botId: this.opts.bot.id },
        text: '',
        mentions: [],
        mentionsEveryone: false,
        attachments: [],
        isStreaming: true,
        ...(this.opts.meta && { meta: this.opts.meta })
      })
      if (!entry) return
      this.current = { entry, text: '' }
    }
    this.current.text += delta
    this.deps.bus.emit('conv:delta', { conversationId: this.opts.conversation.id, entryId: this.current.entry.id, textDelta: delta })
    if (this.phaseNow?.phase !== 'typing') this.phase('typing')
  }

  /** Finish the current message, if any. */
  endText(): void {
    if (this.held) {
      this.held.separate = true
      return
    }
    this.pending = ''
    const current = this.current
    if (!current) return
    this.current = undefined
    const text = current.text.trimEnd()
    const others = this.opts.members.filter((b) => b.id !== this.opts.bot.id)
    const { ids, everyone } = parseMentions(text, others)
    const entry = this.update(current.entry.id, { text, isStreaming: false, mentions: ids, mentionsEveryone: everyone })
    if (entry) this.posts.push(entry)
  }

  /** Tokens this turn used so far, summed over its model calls (for the turn log). */
  get usageTotals(): { inputTokens: number; outputTokens: number; codexUsageState?: 'measured' | 'unknown' } {
    return { ...this.usage, ...(this.codexUsageState && { codexUsageState: this.codexUsageState }) }
  }

  recordCodexUsage(delta?: { inputTokens: number; outputTokens: number }): void {
    this.addUsage(delta)
    if (this.codexUsageState !== 'unknown') this.codexUsageState = delta ? 'measured' : 'unknown'
  }

  addUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
    const complete = [usage?.inputTokens, usage?.outputTokens].every(n => Number.isSafeInteger(n) && n! >= 0)
    if (!complete) this.usageCoverage = 'incomplete'
    else if (this.usageCoverage === 'none') this.usageCoverage = 'complete'
    if (!usage) return
    this.usage.inputTokens += usage.inputTokens ?? 0
    this.usage.outputTokens += usage.outputTokens ?? 0
  }

  toolStart(callId: string, toolName: string, title: string, input: unknown, actionId?: string): Entry | undefined {
    this.endText()
    if (SILENT_TOOLS.has(toolName) || this.opts.signal?.aborted || this.held?.closed) return undefined
    if (this.held) {
      title = toolName === 'read_project_result' ? 'Checking the selected project result' : 'Using a tool for this project request'
      input = {}
    }
    if (this.tools.has(callId)) return this.tools.get(callId)
    const entry = this.append({
      conversationId: this.opts.conversation.id,
      kind: 'tool-call',
      author: { kind: 'bot', botId: this.opts.bot.id },
      text: title,
      mentions: [],
      mentionsEveryone: false,
      attachments: [],
      toolCall: { callId, ...(actionId && { actionId }), toolName, title, input: toolName === 'read_project_result' ? {} : redactDeep(input, this.deps.redact), status: 'running' },
      isStreaming: false
    })
    if (entry) this.tools.set(callId, entry)
    return entry
  }

  toolEnd(callId: string, result: ToolResult, aborted: boolean): void {
    if (this.held?.closed) return
    const entry = this.tools.get(callId)
    if (!entry?.toolCall) return
    this.finishTool(callId, entry, {
      status: toolStatus(result, aborted),
      resultText: resultPreview(result),
      ...(result.display?.title && { title: result.display.title }),
      ...(result.display?.exchangeConversationId && { exchangeConversationId: result.display.exchangeConversationId })
    })
  }

  /** Close a tool card with a plain outcome (external engines report text, not ToolResults). */
  toolEndText(callId: string, status: ToolCallInfo['status'], resultText: string): void {
    if (this.held?.closed) return
    const entry = this.tools.get(callId)
    if (!entry?.toolCall) return
    const preview = resultText.length > CARD_RESULT_CHARS ? `${resultText.slice(0, CARD_RESULT_CHARS)}…` : resultText
    this.finishTool(callId, entry, { status, resultText: this.deps.redact(preview) })
  }

  /** Attach details to a tool card while it runs (e.g. the exchange a send_to_agent opened). */
  annotateTool(entryId: Id, patch: Partial<Pick<ToolCallInfo, 'title' | 'exchangeConversationId'>>): void {
    if (this.held?.closed) return
    for (const [callId, entry] of this.tools) {
      if (entry.id !== entryId || !entry.toolCall) continue
      const toolCall = { ...entry.toolCall, ...patch }
      if (this.held) toolCall.title = entry.toolCall.title
      const updated = this.update(entry.id, { toolCall, text: toolCall.title })
      if (updated) this.tools.set(callId, updated)
      return
    }
  }

  /** The tool card for a call id, or the newest running card of a tool (bridge calls carry their own ids). */
  findToolEntry(callId: string, toolNames: string[]): Entry | undefined {
    const exact = this.tools.get(callId)
    if (exact) return exact
    const running = [...this.tools.values()].reverse()
    return running.find((e) => e.toolCall?.status === 'running' && toolNames.includes(e.toolCall.toolName))
  }

  private finishTool(callId: string, entry: Entry, patch: Partial<ToolCallInfo>): void {
    const toolCall: ToolCallInfo = { ...entry.toolCall!, ...patch }
    if (this.held) {
      toolCall.title = entry.toolCall!.title
      if (patch.resultText !== undefined) toolCall.resultText = toolCall.status === 'done' ? 'Tool finished.' : 'Tool did not complete.'
    }
    // The source DM owns the selected words. Copying them into a tool card would bypass future grant checks.
    if (toolCall.toolName === 'read_handoff' && patch.resultText !== undefined) {
      toolCall.resultText = toolCall.status === 'done' ? 'Handoff checked against current access.' : 'The handoff could not be read.'
    }
    if (toolCall.toolName === 'read_project_result' && patch.resultText !== undefined)
      toolCall.resultText = toolCall.status === 'done' ? 'The selected result was checked against current access.' : 'The selected result could not be read.'
    const updated = this.update(entry.id, { toolCall, text: toolCall.title })
    this.tools.set(callId, updated ?? { ...entry, toolCall })
  }

  /** A line in the chat about this turn ("Researcher could not answer: …"). */
  event(text: string): Entry | undefined {
    this.endText()
    if (this.held) {
      this.held.failed = true
      return
    }
    return this.appendEvent(text)
  }

  private appendEvent(text: string): Entry | undefined {
    return this.append({
      conversationId: this.opts.conversation.id,
      kind: 'event',
      author: { kind: 'bot', botId: this.opts.bot.id },
      text: this.deps.redact(text),
      mentions: [],
      mentionsEveryone: false,
      attachments: [],
      isStreaming: false
    })
  }

  /** End of turn: close the open message and any tool card still running. */
  finish(aborted: boolean, failed = false): string | undefined {
    if (this.held?.closed) return
    this.endText()
    for (const [callId, entry] of this.tools) {
      if (entry.toolCall?.status !== 'running') continue
      this.finishTool(callId, entry, { status: aborted ? 'cancelled' : 'error' })
    }
    let withheld: string | undefined
    if (this.held) {
      this.held.closed = true
      const output = this.held.text.trim()
      this.held.text = ''
      if (!aborted) {
        // Never emit a partial delta or streaming DB row for scoped evidence. No await separates
        // the final authority check and the one complete, user-visible message.
        let available = false
        try { available = this.opts.selectedResultAvailable!() } catch { /* Withhold by default. */ }
        if (!available || this.held.withdrawn) withheld = SELECTED_RESULT_WITHHELD
        else if (failed || this.held.failed) withheld = SELECTED_RESULT_ERROR
        else if (this.held.overflow) withheld = 'The selected-result reply was too long to display. Ask a narrower question.'
        if (withheld) this.appendEvent(withheld)
        else if (output) {
          const mentions = parseMentions(output, this.opts.members.filter(b => b.id !== this.bot.id))
          const entry = this.append({ conversationId:this.conversationId,kind:'message',author:{kind:'bot',botId:this.bot.id},
            text:output,mentions:mentions.ids,mentionsEveryone:mentions.everyone,attachments:[],isStreaming:false,
            ...(this.opts.replyToId && {replyToId:this.opts.replyToId}),...(this.opts.meta && {meta:this.opts.meta}) })
          if (entry) this.posts.push(entry)
        }
      }
    }
    const last = this.posts[this.posts.length - 1]
    const measuredChild = this.opts.conversation.kind === 'exchange' && !!this.opts.replyToId && this.usageCoverage === 'complete'
    if (last && (measuredChild || this.usage.inputTokens || this.usage.outputTokens)) {
      const meta = { ...last.meta, inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens,
        ...(measuredChild && { measuredChildUsage: true as const }) }
      this.posts[this.posts.length - 1] = this.update(last.id, { meta }) ?? last
    }
    return withheld
  }
}
