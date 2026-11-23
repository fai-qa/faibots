// Shared by the Claude Code and Codex engines. Those tools keep their own session (Claude Code
// session / Codex thread), so each turn only sends what is new since the bot's last turn, as text.
// When a session starts fresh in a conversation that already has history (first turn after a model
// switch, or a lost session), the recent history is included once so the bot is not lost.

import { dirname } from 'node:path'
import type { Entry } from '@shared/domain'
import type { Store, ToolResult } from '../contracts'
import type { EngineTurn } from './engine'
import { entriesAsText, isProjectHistory, NO_NEW_MESSAGES } from './history'

/** Earlier messages replayed into a fresh session. */
const HISTORY_FOR_NEW_SESSION = 30
/** New messages sent in one turn (a bot just added to a long group chat sees the newest ones). */
const MAX_NEW_MESSAGES = 50

export function turnPrompt(turn: EngineTurn, store: Pick<Store, 'entries'>, freshSession: boolean): { text: string; newEntries: Entry[]; replayedEntries: Entry[] } {
  const conversationId = turn.conversation.id
  if (turn.isolatedTrigger) {
    const entries = [turn.isolatedTrigger]
    return { text: [entriesAsText(entries,turn.nameOf,turn.bot.id),turn.turnNote].filter(Boolean).join('\n\n'),
      newEntries: entries, replayedEntries: [] }
  }
  const seen = turn.context.lastSeenSeq
  const fresh = store.entries
    .since(conversationId, seen)
    .filter((e) => e.seq <= turn.upToSeq && e.kind === 'message' && !isProjectHistory(e) && !(e.author.kind === 'bot' && e.author.botId === turn.bot.id))

  let replayedEntries: Entry[] = []
  const parts: string[] = []
  if (freshSession && seen > 0) {
    // Everything the new session has not heard, except the new messages themselves
    // (the bot's own replies come after lastSeenSeq, so they are picked up here too).
    const freshIds = new Set(fresh.map((e) => e.id))
    const earlier = store.entries
      .since(conversationId, 0)
      .filter((e) => e.seq <= turn.upToSeq && e.kind === 'message' && !isProjectHistory(e) && !freshIds.has(e.id))
      .slice(-HISTORY_FOR_NEW_SESSION)
    replayedEntries = earlier
    if (earlier.length > 0) {
      parts.push(`Earlier in this conversation:\n\n${entriesAsText(earlier, turn.nameOf, turn.bot.id)}`, '---', 'New messages:')
    }
  }
  const shown = fresh.slice(-MAX_NEW_MESSAGES)
  if (shown.length < fresh.length) parts.push(`(${fresh.length - shown.length} earlier messages are not shown.)`)
  parts.push(shown.length > 0 ? entriesAsText(shown, turn.nameOf, turn.bot.id) : NO_NEW_MESSAGES)
  if (turn.turnNote) parts.push(turn.turnNote)
  return { text: parts.join('\n\n'), newEntries: fresh, replayedEntries }
}

/** Folders holding the attachments of these entries (so the engine may read them without asking). */
export function attachmentDirs(entries: Entry[]): string[] {
  return [...new Set(entries.flatMap((e) => e.attachments.map((a) => dirname(a.path))))]
}

/** Tool card status from a tool's text result. */
export function statusFromText(isError: boolean, text: string, aborted: boolean): 'done' | 'error' | 'denied' | 'cancelled' {
  if (!isError) return 'done'
  if (aborted || text === 'Cancelled.') return 'cancelled'
  if (/^(The user declined this action|.+ is turned off for you)/.test(text)) return 'denied'
  return 'error'
}

/** A FaiBots ToolResult as an MCP CallToolResult. */
export function toCallToolResult(result: ToolResult) {
  return {
    content: result.content.map((c) =>
      c.type === 'text' ? { type: 'text' as const, text: c.text } : { type: 'image' as const, data: c.dataBase64, mimeType: c.mediaType }
    ),
    ...(result.isError && { isError: true })
  }
}

/** Plain text of an MCP-style tool_result content (string or blocks). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      if (c && typeof c === 'object' && 'type' in c) {
        const block = c as { type: string; text?: unknown }
        if (block.type === 'text' && typeof block.text === 'string') return block.text
        if (block.type === 'image') return '[image]'
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}
