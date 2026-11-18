// The "router" group policy: one cheap model call (on settings.defaultModel) picks which members
// should answer a message nobody @mentioned. Any failure returns undefined and the group falls
// back to the "open" policy.

import type { Bot, Id } from '@shared/domain'
import type { ModelAdapter } from '../providers/types'

const ROUTER_MAX_TOKENS = 2_000

export async function routeMessage(input: {
  adapter: ModelAdapter
  modelId: string
  members: Bot[]
  userName: string
  text: string
  signal: AbortSignal
}): Promise<Id[] | undefined> {
  const roster = input.members
    .map((b) => `- @${b.handle}: ${b.name}${b.label ? `, ${b.label}` : ''}${b.description ? `. ${b.description}` : ''}`)
    .join('\n')
  const system =
    'You route messages in a group chat of AI assistants. Decide which assistants should answer. ' +
    'Pick the fewest that are clearly relevant, at least one. Reply with JSON only, like {"handles": ["writer"]}.'
  const prompt = `Assistants:\n${roster}\n\nMessage from ${input.userName || 'the user'}:\n"""\n${input.text.slice(0, 8_000)}\n"""`
  let reply: string
  try {
    reply = await input.adapter.complete({ modelId: input.modelId, system, prompt, maxTokens: ROUTER_MAX_TOKENS, signal: input.signal })
  } catch (err) {
    if (!input.signal.aborted) console.warn('[runtime] router call failed:', err instanceof Error ? err.message : String(err))
    return undefined
  }
  return parseRouterReply(reply, input.members)
}

/** Read {"handles": [...]} (or a bare array) from the router's reply. */
export function parseRouterReply(reply: string, members: Bot[]): Id[] | undefined {
  const match = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(reply)
  if (!match) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return undefined
  }
  const handles = Array.isArray(parsed) ? parsed : (parsed as { handles?: unknown })?.handles
  if (!Array.isArray(handles)) return undefined
  const ids: Id[] = []
  for (const h of handles) {
    if (typeof h !== 'string') continue
    const handle = h.trim().replace(/^@/, '').toLowerCase()
    const bot = members.find((b) => b.handle === handle)
    if (bot && !ids.includes(bot.id)) ids.push(bot.id)
  }
  return ids.length > 0 ? ids : undefined
}
