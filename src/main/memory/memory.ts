// Per-bot memory: one profile document plus dated facts, searchable with FTS5.
// A bot only ever sees its own memory; every query is scoped by bot id.

import { randomUUID } from 'node:crypto'
import type { BotMemoryProfile, Id, MemoryFact } from '@shared/domain'
import type { EventBus, MemoryService } from '../contracts'
import { bool, jsonOrNull, num, parseJson, str, type Db, type Row } from '../store/db'

export const PROFILE_PROMPT_CHARS = 4000
export const PROMPT_BLOCK_CHARS = 8000
export const RECENT_FACTS_IN_PROMPT = 20
const MAX_PROFILE_CHARS = 20_000
const MAX_FACT_CHARS = 4000

function toFact(r: Row): MemoryFact {
  const source = parseJson<MemoryFact['source'] | null>(r['source'], null)
  return {
    id: str(r['id']),
    botId: str(r['bot_id']),
    tier: 'log',
    text: str(r['text']),
    pinned: bool(r['pinned']),
    ...(source && { source }),
    createdBy: str(r['created_by']) === 'user' ? 'user' : 'bot',
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

function checkFactText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('A memory needs some text')
  if (trimmed.length > MAX_FACT_CHARS) throw new Error(`A single memory is at most ${MAX_FACT_CHARS} characters`)
  return trimmed
}

/**
 * Turn free text into a safe FTS5 query: each word becomes a quoted prefix term, OR-ed together
 * so partial matches still rank (bm25). Raw user or model text would otherwise hit FTS syntax errors.
 */
export function ftsQuery(text: string): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const unique = [...new Set(words)].slice(0, 16)
  return unique.length ? unique.map((w) => `"${w}"*`).join(' OR ') : undefined
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const factLine = (f: MemoryFact) => `- [${day(f.createdAt)}] ${f.text.replace(/\s+/g, ' ')} (id: ${f.id})`

export interface PlatformMemoryService extends MemoryService {
  /** Recipe import keeps the original dates. */
  add(input: Parameters<MemoryService['add']>[0] & { createdAt?: number }): MemoryFact
  getFact(id: Id): MemoryFact | undefined
}

export function createMemoryService(db: Db, opts: { bus?: EventBus } = {}): PlatformMemoryService {
  const changed = (botId: Id) => opts.bus?.emit('memory:changed', { botId })
  const getFact = (id: Id) => {
    const row = db.prepare('select * from memory_facts where id = ?').get(id)
    return row ? toFact(row) : undefined
  }

  const search = (botId: Id, query: string, limit = 20): MemoryFact[] => {
    const match = ftsQuery(query)
    if (!match) return []
    return db
      .prepare(
        `select f.* from memory_fts join memory_facts f on f.rid = memory_fts.rowid
         where memory_fts match ? and f.bot_id = ?
         order by bm25(memory_fts), f.created_at desc limit ?`
      )
      .all(match, botId, Math.max(1, limit))
      .map(toFact)
  }

  const getProfile = (botId: Id): BotMemoryProfile => {
    const row = db.prepare('select * from memory_profiles where bot_id = ?').get(botId)
    return { botId, content: str(row?.['content']), updatedAt: num(row?.['updated_at']) }
  }

  return {
    list(botId, opts = {}) {
      if (opts.query?.trim()) return search(botId, opts.query, opts.limit ?? 100)
      return db
        .prepare('select * from memory_facts where bot_id = ? order by pinned desc, created_at desc, rid desc limit ?')
        .all(botId, opts.limit ?? -1)
        .map(toFact)
    },

    add(input) {
      const text = checkFactText(input.text)
      if (!db.prepare('select 1 from bots where id = ?').get(input.botId)) throw new Error('Bot not found')
      const now = Date.now()
      const createdAt = input.createdAt ?? now
      const id = randomUUID()
      db.prepare(
        `insert into memory_facts (id, bot_id, text, pinned, source, created_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, input.botId, text, input.pinned ? 1 : 0, jsonOrNull(input.source), input.createdBy, createdAt, now)
      changed(input.botId)
      return getFact(id)!
    },

    update(id, patch) {
      const current = getFact(id)
      if (!current) throw new Error('Memory not found')
      const text = patch.text !== undefined ? checkFactText(patch.text) : current.text
      const pinned = patch.pinned ?? current.pinned
      db.prepare('update memory_facts set text = ?, pinned = ?, updated_at = ? where id = ?')
        .run(text, pinned ? 1 : 0, Date.now(), id)
      changed(current.botId)
      return getFact(id)!
    },

    delete(id) {
      const fact = getFact(id)
      db.prepare('delete from memory_facts where id = ?').run(id)
      if (fact) changed(fact.botId)
    },

    getFact,
    getProfile,

    setProfile(botId, content) {
      if (content.length > MAX_PROFILE_CHARS) {
        throw new Error(`The memory profile is at most ${MAX_PROFILE_CHARS} characters; move details into facts`)
      }
      if (!db.prepare('select 1 from bots where id = ?').get(botId)) throw new Error('Bot not found')
      db.prepare(
        `insert into memory_profiles (bot_id, content, updated_at) values (?, ?, ?)
         on conflict (bot_id) do update set content = excluded.content, updated_at = excluded.updated_at`
      ).run(botId, content, Date.now())
      changed(botId)
      return getProfile(botId)
    },

    search,

    promptBlock(botId) {
      const lines: string[] = ['## Your memory', '']
      let size = lines.join('\n').length
      const push = (line: string) => {
        lines.push(line)
        size += line.length + 1
      }

      const profile = getProfile(botId).content.trim()
      push('### Profile')
      if (profile) {
        push(profile.length > PROFILE_PROMPT_CHARS
          ? `${profile.slice(0, PROFILE_PROMPT_CHARS)}\n…(profile cut at ${PROFILE_PROMPT_CHARS} characters; keep it shorter)`
          : profile)
      } else {
        push('(empty)')
      }

      const footer = 'Only part of your memory is shown here. Use recall_memory to search older facts, and update_memory to save, fix or forget one.'
      const budget = PROMPT_BLOCK_CHARS - footer.length - 2

      const section = (title: string, facts: MemoryFact[]) => {
        if (facts.length === 0) return
        const header = `\n### ${title}`
        if (size + header.length > budget) return
        push(header)
        for (const fact of facts) {
          const line = factLine(fact)
          if (size + line.length + 1 > budget) break
          push(line)
        }
      }

      const pinned = db
        .prepare('select * from memory_facts where bot_id = ? and pinned = 1 order by created_at desc, rid desc')
        .all(botId)
        .map(toFact)
      const recent = db
        .prepare('select * from memory_facts where bot_id = ? and pinned = 0 order by created_at desc, rid desc limit ?')
        .all(botId, RECENT_FACTS_IN_PROMPT)
        .map(toFact)
      section('Pinned facts', pinned)
      section('Recent facts', recent)

      push('')
      push(footer)
      return lines.join('\n')
    }
  }
}
