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
  bot: Bot
  conversation: Conversation
  /** Bots that can be @mentioned from this conversation (its members). */
  members: Bot[]
  meta?: Entry['meta']
  /** Once aborted (Stop, reset), late text and tool calls from the engine are dropped. */
  signal?: AbortSignal
  /**
   * Asked before every message entry the turn creates (one post each). Returning false means the
   * post budget of the group round is spent: nothing more is posted (earlier messages stay) and
   * onRefused stops the turn.
   */
  reservePost?(): boolean
  onRefused?(): void
}

/** Text the tool registry uses when the user said no, or the tool is turned off. */
const DENIED = /^(The user declined this action|.+ is turned off for you)/

const CARD_RESULT_CHARS = 2_000
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

  constructor(
    private readonly deps: RecorderDeps,
    private readonly opts: RecorderOptions
  ) {}

  get bot(): Bot {
    return this.opts.bot
  }

  get conversationId(): Id {
    return this.opts.conversation.id
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
      stored = this.deps.store.entries.append(entry)
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
    this.phaseNow = { phase, ...(activity && { activity }) }
    this.deps.live.set(this.opts.bot.id, this.opts.conversation.id, phase, activity)
  }

  get currentPhase(): { phase: BotPhase; activity?: string } | undefined {
    return this.phaseNow
  }

  /** Stream text into the current message (created on the first non-blank text). */
  textDelta(delta: string): void {
    if (this.refused || !delta || this.opts.signal?.aborted) return
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
  get usageTotals(): { inputTokens: number; outputTokens: number } {
    return { ...this.usage }
  }

  addUsage(usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
    if (!usage) return
    this.usage.inputTokens += usage.inputTokens ?? 0
    this.usage.outputTokens += usage.outputTokens ?? 0
  }

  toolStart(callId: string, toolName: string, title: string, input: unknown, actionId?: string): Entry | undefined {
    this.endText()
    if (SILENT_TOOLS.has(toolName) || this.opts.signal?.aborted) return undefined
    if (this.tools.has(callId)) return this.tools.get(callId)
    const entry = this.append({
      conversationId: this.opts.conversation.id,
      kind: 'tool-call',
      author: { kind: 'bot', botId: this.opts.bot.id },
      text: title,
      mentions: [],
      mentionsEveryone: false,
      attachments: [],
      toolCall: { callId, ...(actionId && { actionId }), toolName, title, input: redactDeep(input, this.deps.redact), status: 'running' },
      isStreaming: false
    })
    if (entry) this.tools.set(callId, entry)
    return entry
  }

  toolEnd(callId: string, result: ToolResult, aborted: boolean): void {
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
    const entry = this.tools.get(callId)
    if (!entry?.toolCall) return
    const preview = resultText.length > CARD_RESULT_CHARS ? `${resultText.slice(0, CARD_RESULT_CHARS)}…` : resultText
    this.finishTool(callId, entry, { status, resultText: this.deps.redact(preview) })
  }

  /** Attach details to a tool card while it runs (e.g. the exchange a send_to_agent opened). */
  annotateTool(entryId: Id, patch: Partial<Pick<ToolCallInfo, 'title' | 'exchangeConversationId'>>): void {
    for (const [callId, entry] of this.tools) {
      if (entry.id !== entryId || !entry.toolCall) continue
      const toolCall = { ...entry.toolCall, ...patch }
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
    const updated = this.update(entry.id, { toolCall, text: toolCall.title })
    this.tools.set(callId, updated ?? { ...entry, toolCall })
  }

  /** A line in the chat about this turn ("Researcher could not answer: …"). */
  event(text: string): Entry | undefined {
    this.endText()
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
  finish(aborted: boolean): void {
    this.endText()
    for (const [callId, entry] of this.tools) {
      if (entry.toolCall?.status !== 'running') continue
      this.finishTool(callId, entry, { status: aborted ? 'cancelled' : 'error' })
    }
    const last = this.posts[this.posts.length - 1]
    if (last && (this.usage.inputTokens || this.usage.outputTokens)) {
      const meta = { ...last.meta, inputTokens: this.usage.inputTokens, outputTokens: this.usage.outputTokens }
      this.posts[this.posts.length - 1] = this.update(last.id, { meta }) ?? last
    }
  }
}
