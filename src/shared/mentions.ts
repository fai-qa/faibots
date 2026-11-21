// @mention parsing for conversations (ARCHITECTURE §5.2).
//
// Each member answers to four kinds of handle, case-insensitive: its @handle, its full name,
// its name without spaces, and the first word of its name. "@everyone" and "@all" address every
// member. A handle shared by two members at the same rank (two bots whose names both start with
// "Research", say) is ambiguous and addresses nobody; a better-ranked match wins over a worse one.
// A mention must start the text or follow a non-alphanumeric character (so e-mail addresses are
// not mentions) and must end at a non-alphanumeric character.

import type { Bot, Id } from './domain'

export const EVERYONE_HANDLES = ['everyone', 'all'] as const

export interface ParsedMentions {
  ids: Id[]
  everyone: boolean
}

type Member = Pick<Bot, 'id' | 'name' | 'handle'>

const ALNUM = /[\p{L}\p{N}]/u

/** Lower-case and strip accents, so "Zoë" matches "@zoe" as well as "@zoë". */
function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** The handles a member answers to, best rank first (0 = @handle, 3 = first word). */
export function handlesOf(member: Member): { handle: string; rank: number }[] {
  const name = fold(member.name.trim()).replace(/\s+/g, ' ')
  const candidates = [
    { handle: fold(member.handle.replace(/^@/, '')), rank: 0 },
    { handle: name, rank: 1 },
    { handle: name.replace(/\s+/g, ''), rank: 2 },
    { handle: name.split(' ')[0] ?? '', rank: 3 }
  ]
  const seen = new Set<string>()
  return candidates.filter((c) => {
    if (!c.handle || seen.has(c.handle)) return false
    seen.add(c.handle)
    return true
  })
}

/** handle -> the member it resolves to, or null when it is ambiguous. */
export function buildHandleIndex(members: Member[]): Map<string, Id | null> {
  const best = new Map<string, { rank: number; ids: Set<Id> }>()
  for (const member of members) {
    for (const { handle, rank } of handlesOf(member)) {
      const current = best.get(handle)
      if (!current || rank < current.rank) best.set(handle, { rank, ids: new Set([member.id]) })
      else if (rank === current.rank) current.ids.add(member.id)
    }
  }
  const index = new Map<string, Id | null>()
  for (const [handle, { ids }] of best) index.set(handle, ids.size === 1 ? [...ids][0]! : null)
  return index
}

function findMentions(text: string, members: Member[]): ParsedMentions {
  const index = buildHandleIndex(members)
  // @everyone and @all are reserved: they always address every member, even a bot named "All".
  for (const reserved of EVERYONE_HANDLES) index.delete(reserved)
  // Longest handles first, so "@research lead" wins over "@research".
  const handles = [...index.keys(), ...EVERYONE_HANDLES].sort((a, b) => b.length - a.length)
  // Folding can change lengths (e.g. "ﬁ"), so match on the folded text only.
  const folded = fold(text)
  const ids: Id[] = []
  let everyone = false

  for (let i = folded.indexOf('@'); i !== -1; i = folded.indexOf('@', i + 1)) {
    if (i > 0 && ALNUM.test(folded[i - 1]!)) continue
    const rest = folded.slice(i + 1)
    const handle = handles.find((h) => rest.startsWith(h) && (rest.length === h.length || !ALNUM.test(rest[h.length]!)))
    if (!handle) continue
    if ((EVERYONE_HANDLES as readonly string[]).includes(handle)) {
      everyone = true
      continue
    }
    const id = index.get(handle)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return { ids, everyone }
}

// Exclude examples from routing. Keep the original text untouched for the transcript.
function routingText(text: string): string {
  if (!text.includes('@')) return text
  let fence = ''
  let blockQuote = false
  let inlineTicks = ''
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (fence) {
        const closing = /^ {0,3}(\x60+|~+)[ \t]*$/.exec(line)?.[1]
        if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = ''
        return ''
      }
      const opener = /^ {0,3}(\x60{3,}|~{3,})/.exec(line)?.[1]
      if (opener) {
        fence = opener
        inlineTicks = ''
        blockQuote = false
        return ''
      }
      if (!line.trim()) {
        blockQuote = false
        inlineTicks = ''
        return ''
      }
      if (/^ {0,3}>/.test(line)) blockQuote = true
      if (blockQuote || /^(?: {4}|\t)/.test(line)) return ''
      // Markdown code spans close only on an equal-length backtick run.
      const parts = line.split(/(\x60+)/)
      const prose = parts
        .map((part, i) => {
          if (i % 2 === 0) return inlineTicks ? ' ' : part
          if (!inlineTicks) inlineTicks = part
          else if (inlineTicks === part) inlineTicks = ''
          return ' '
        })
        .join('')
      return prose
        .replace(/\\@/g, ' ')
        .replace(/“[^”]*”|‘[^’]*’|«[^»]*»|"(?:\\.|[^"\\])*"/g, ' ')
        .replace(/(^|[^\p{L}\p{N}])'[^'\n]+'(?=$|[^\p{L}\p{N}])/gu, '$1 ')
    })
    .join('\n')
}

export function parseMentions(text: string, members: Member[]): ParsedMentions {
  return findMentions(routingText(text), members)
}

// Older renderers sent IDs inferred from the entire message. Retain explicit ID-only routing
// used by callers, but a reference appearing solely inside a quotation cannot authorize a call.
export function resolveMentionHints(text: string, members: Member[], ids: Id[], everyone: boolean): ParsedMentions {
  const prose = routingText(text)
  const parsed = findMentions(prose, members)
  const all = prose !== text ? findMentions(text, members) : undefined
  const selected = ids.filter((id) => members.some((member) => member.id === id) && !all?.ids.includes(id))
  return { ids: [...new Set([...selected, ...parsed.ids])], everyone: parsed.everyone || (everyone && !all?.everyone) }
}
