// Context management for native engines (ARCHITECTURE §6): estimate the prompt size as
// characters / 3.5; once it passes `compactAt` of the model's context window, the bot summarises
// the older messages with its own model into BotContextState.summary and keeps the newest 12
// message entries verbatim. External engines (Claude Code, Codex) manage their own context.
//
// This is "simple compaction": the next request starts from the summary plus the kept messages
// and replays nothing else, so no thinking block from before the summary is ever sent again.

import type { Entry } from '@shared/domain'
import type { ModelAdapter } from '../providers/types'
import { entriesAsText, type ViewInput } from './history'

export const CHARS_PER_TOKEN = 3.5
export const KEEP_VERBATIM = 12
export const DEFAULT_CONTEXT_WINDOW = 200_000
const SUMMARY_MAX_TOKENS = 8_000
/** The transcript handed to the summariser is capped; a summary of a summary keeps the rest. */
const SUMMARY_INPUT_CHARS = 400_000

export const estimateTokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

export function needsCompaction(input: { promptChars: number; contextWindow?: number; compactAt: number }): boolean {
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : DEFAULT_CONTEXT_WINDOW
  return estimateTokens(input.promptChars) > input.compactAt * window
}

/**
 * Split the message entries into the part to summarise and the part kept verbatim.
 * Undefined when there is too little to fold away.
 */
export function planCompaction(entries: Entry[], keep = KEEP_VERBATIM): { older: Entry[]; kept: Entry[]; upToSeq: number } | undefined {
  const messages = entries.filter((e) => e.kind === 'message')
  if (messages.length <= keep) return undefined
  const older = messages.slice(0, messages.length - keep)
  const last = older[older.length - 1]!
  return { older, kept: entries.filter((e) => e.seq > last.seq), upToSeq: last.seq }
}

export interface SummaryInput {
  adapter: ModelAdapter
  modelId: string
  botName: string
  previousSummary: string
  older: Entry[]
  nameOf: ViewInput['nameOf']
  selfId: string
  /** The model's context window; the transcript sent for summary must fit in it. */
  contextWindow?: number
  signal: AbortSignal
}

export async function summarize(input: SummaryInput): Promise<string> {
  return (await summarizeCovered(input)).summary
}

/**
 * Summarise the OLDEST entries that fit the input cap. `coveredUpToSeq` is the last entry that
 * went into the notes; later entries stay unsummarised. Only a single entry larger than the cap
 * is cut (start and end kept, with a marker), and the notes then say so.
 */
export async function summarizeCovered(input: SummaryInput): Promise<{ summary: string; coveredUpToSeq: number }> {
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : DEFAULT_CONTEXT_WINDOW
  const maxChars = Math.min(SUMMARY_INPUT_CHARS, Math.floor(window * CHARS_PER_TOKEN * 0.6))
  let transcript = entriesAsText(input.older, input.nameOf, input.selfId)
  let coveredUpToSeq = input.older[input.older.length - 1]!.seq
  let cutNote = ''
  if (transcript.length > maxChars) {
    const parts: { seq: number; text: string }[] = []
    for (const e of input.older) {
      const text = entriesAsText([e], input.nameOf, input.selfId)
      if (text) parts.push({ seq: e.seq, text })
    }
    const included: string[] = []
    let used = 0
    coveredUpToSeq = input.older[0]!.seq
    for (const p of parts) {
      const need = p.text.length + (included.length ? 2 : 0)
      if (used + need > maxChars) break
      included.push(p.text)
      used += need
      coveredUpToSeq = p.seq
    }
    if (!included.length && parts.length) {
      const first = parts[0]!
      const omitted = first.text.length - maxChars
      const head = Math.ceil(maxChars / 2)
      const marker = `\n[… ${omitted} characters omitted …]\n`
      included.push(first.text.slice(0, head) + marker + first.text.slice(first.text.length - (maxChars - head)))
      coveredUpToSeq = first.seq
      cutNote = '\n\n- Note: one message was too long to summarize fully; only its start and end were read.'
    }
    transcript = included.join('\n\n')
  }
  const system =
    `You are ${input.botName}. You are writing notes for your future self, because the older part of a ` +
    'conversation is about to be removed from your context. Write in the first person.'
  const prompt = [
    input.previousSummary.trim() ? `Your notes so far:\n\n${input.previousSummary.trim()}\n\n---\n` : '',
    `Messages to fold into the notes (names in brackets are the speakers):\n\n${transcript}\n\n---\n`,
    'Write the updated notes. Keep: who asked for what, decisions and why, facts and numbers, files and links, ' +
      'what you promised or still owe, open questions, and anything the user said about their preferences. ' +
      'Drop greetings and small talk. Use short Markdown bullet points, at most about 1500 words. Reply with the notes only.'
  ].join('\n')
  const text = await input.adapter.complete({
    modelId: input.modelId,
    system,
    prompt,
    maxTokens: SUMMARY_MAX_TOKENS,
    signal: input.signal
  })
  if (!text.trim()) throw new Error('The summary came back empty.')
  return { summary: text.trim() + cutNote, coveredUpToSeq }
}
