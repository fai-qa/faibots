// Builds the conversation as one bot sees it (native engines), and the plain-text form the
// external engines (Claude Code, Codex) receive.
//
// The bot's own messages become assistant turns. Everyone else's messages become user turns that
// start with the speaker's name, "[Alex] …", "[Researcher] …"; consecutive ones are merged into
// one user turn. A rolling summary of older messages, when there is one, comes first. Tool calls,
// approval cards and event lines are not part of the view: what a bot did shows in what it said.

import type { Attachment, Bot, Entry, Id, RoutineRunTrigger } from '@shared/domain'
import type { ChatMessage, ChatPart } from '../providers/types'

export interface ViewInput {
  botId: Id
  /** Message entries (and others, which are skipped), oldest first. */
  entries: Entry[]
  summary: string
  nameOf(author: Entry['author']): string
  /** Loads an image attachment for the model; undefined = describe it in text instead. */
  loadImage?(attachment: Attachment): { mediaType: string; dataBase64: string } | undefined
  /** How many of the newest image attachments are sent as images (default 8). */
  maxImages?: number
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i
export const NO_NEW_MESSAGES = '(No new messages since your last reply.)'

export function speakerName(author: Entry['author'], bots: (id: Id) => Bot | undefined, userName: string): string {
  if (author.kind === 'user') return userName.trim() || 'User'
  if (author.kind === 'system') return 'FaiBots'
  return bots(author.botId)?.name ?? 'A deleted bot'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function attachmentNote(a: Attachment): string {
  return `[Attached file: ${a.name} (${a.mimeType}, ${formatSize(a.sizeBytes)}) at ${a.path}]`
}

function replyNote(entry: Entry, byId: Map<Id, Entry>, nameOf: ViewInput['nameOf']): string {
  if (!entry.replyToId) return ''
  const original = byId.get(entry.replyToId)
  if (!original) return ''
  const quote = original.text.replace(/\s+/g, ' ').trim()
  return ` (replying to ${nameOf(original.author)}: "${quote.length > 120 ? `${quote.slice(0, 117)}…` : quote}")`
}

const isMessage = (e: Entry) => e.kind === 'message'

const STARTED_BY: Record<RoutineRunTrigger, string> = {
  schedule: 'on its schedule',
  manual: 'by the user with Run now',
  webhook: 'by a webhook call from another app',
  'catch-up': 'late, because FaiBots was closed at the planned time'
}

/** A message as the bot reads it. A routine's message also says who started it and how. */
export function messageBody(entry: Entry): string {
  const text = entry.text.trim()
  if (!entry.trigger) return text
  if (entry.trigger.kind === 'mission') {
    return `Mission run for the project "${entry.trigger.projectName}", started automatically by FaiBots (deliverable "${entry.trigger.artifactName}"). Nobody is watching live, so finish the task and report the result in your reply.\n\n${text}`
  }
  return `Routine "${entry.trigger.routineName}", started automatically ${STARTED_BY[entry.trigger.via]}. Nobody is watching live, so finish the task and report the result in your reply.\n\n${text}`
}

export function buildBotView(input: ViewInput): ChatMessage[] {
  const messages = input.entries.filter(isMessage)
  const byId = new Map(messages.map((e) => [e.id, e]))

  // Only the newest few images go to the model as pictures; older ones are described.
  const imageBudget = new Set<Id>()
  let budget = input.maxImages ?? 8
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    for (const a of [...messages[i]!.attachments].reverse()) {
      if (budget > 0 && IMAGE_MIME.test(a.mimeType)) {
        imageBudget.add(a.id)
        budget--
      }
    }
  }

  const out: ChatMessage[] = []
  const pushUser = (parts: ChatPart[]) => {
    const last = out[out.length - 1]
    if (last?.role === 'user') {
      for (const part of parts) {
        const tail = last.content[last.content.length - 1]
        if (part.type === 'text' && tail?.type === 'text') tail.text = `${tail.text}\n\n${part.text}`
        else last.content.push(part)
      }
    } else {
      out.push({ role: 'user', content: parts })
    }
  }

  if (input.summary.trim()) {
    pushUser([{ type: 'text', text: `Summary of the earlier conversation, written by you:\n\n${input.summary.trim()}` }])
  }

  for (const entry of messages) {
    const own = entry.author.kind === 'bot' && entry.author.botId === input.botId
    if (own) {
      if (!entry.text.trim()) continue
      const last = out[out.length - 1]
      if (last?.role === 'assistant') last.text = `${last.text}\n\n${entry.text}`
      else out.push({ role: 'assistant', text: entry.text })
      continue
    }
    const parts: ChatPart[] = []
    const notes: string[] = []
    for (const a of entry.attachments) {
      const image = imageBudget.has(a.id) ? input.loadImage?.(a) : undefined
      if (image) parts.push({ type: 'image', mediaType: image.mediaType, dataBase64: image.dataBase64 })
      else notes.push(attachmentNote(a))
    }
    const body = [messageBody(entry), ...notes].filter(Boolean).join('\n')
    parts.unshift({ type: 'text', text: `[${input.nameOf(entry.author)}]${replyNote(entry, byId, input.nameOf)} ${body}`.trimEnd() })
    pushUser(parts)
  }

  // The API needs a user turn first and last (no assistant prefill).
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(Earlier messages are not shown.)' }] })
  if (out.length === 0 || out[out.length - 1]!.role === 'assistant') pushUser([{ type: 'text', text: NO_NEW_MESSAGES }])
  return out
}

/** Add the per-turn note to the end of the newest user message. */
export function withTurnNote(messages: ChatMessage[], note: string): ChatMessage[] {
  if (!note) return messages
  const last = messages[messages.length - 1]
  if (last?.role !== 'user') return [...messages, { role: 'user', content: [{ type: 'text', text: note }] }]
  return [...messages.slice(0, -1), { role: 'user', content: [...last.content, { type: 'text', text: note }] }]
}

/** Messages as plain text, "[Name] text" per message, for engines that take one prompt string. */
export function entriesAsText(entries: Entry[], nameOf: ViewInput['nameOf'], selfId?: Id): string {
  const byId = new Map(entries.map((e) => [e.id, e]))
  return entries
    .filter(isMessage)
    .map((e) => {
      const self = e.author.kind === 'bot' && e.author.botId === selfId
      const notes = e.attachments.map(attachmentNote)
      const body = [messageBody(e), ...notes].filter(Boolean).join('\n')
      return `[${self ? `${nameOf(e.author)} (you)` : nameOf(e.author)}]${replyNote(e, byId, nameOf)} ${body}`.trimEnd()
    })
    .join('\n\n')
}

/** Rough size of a view in characters, images counted at ~1600 tokens each. */
export function viewChars(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.role === 'assistant') chars += m.text.length
    else for (const p of m.content) chars += p.type === 'text' ? p.text.length : 1600 * 3.5
  }
  return chars
}
