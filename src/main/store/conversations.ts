import { randomUUID } from 'node:crypto'
import type { Conversation, GroupSettings, Id } from '@shared/domain'
import type { ConversationRepo } from '../contracts'
import { defined, jsonOrNull, num, parseJson, str, type Db, type Row } from './db'

function toConversation(r: Row): Conversation {
  const group = parseJson<GroupSettings | null>(r['group_settings'], null)
  const origin = parseJson<Conversation['origin'] | null>(r['origin'], null)
  return {
    id: str(r['id']),
    kind: str(r['kind']) as Conversation['kind'],
    title: str(r['title']),
    botIds: parseJson<Id[]>(r['bot_ids'], []),
    ...(group && { group }),
    ...(origin && { origin }),
    notes: str(r['notes']),
    lastEntryAt: num(r['last_entry_at']),
    unreadCount: num(r['unread_count']),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

function checkMembers(c: Pick<Conversation, 'kind' | 'botIds'>): void {
  if (new Set(c.botIds).size !== c.botIds.length) throw new Error('A bot can only be in a conversation once')
  if (c.kind === 'dm' && c.botIds.length !== 1) throw new Error('A dm has exactly one bot')
  if (c.kind === 'exchange' && c.botIds.length !== 2) throw new Error('An exchange has exactly two bots')
}

export function createConversationRepo(db: Db): ConversationRepo {
  const selectOne = db.prepare('select * from conversations where id = ?')

  const get = (id: Id) => {
    const row = selectOne.get(id)
    return row ? toConversation(row) : undefined
  }

  const write = (c: Conversation) => {
    db.prepare(
      `insert into conversations (id, kind, title, bot_ids, group_settings, origin, notes, last_entry_at,
         unread_count, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set title = excluded.title, bot_ids = excluded.bot_ids,
         group_settings = excluded.group_settings, origin = excluded.origin, notes = excluded.notes,
         last_entry_at = excluded.last_entry_at, unread_count = excluded.unread_count, updated_at = excluded.updated_at`
    ).run(
      c.id, c.kind, c.title, JSON.stringify(c.botIds), jsonOrNull(c.group), jsonOrNull(c.origin), c.notes,
      c.lastEntryAt, c.unreadCount, c.createdAt, c.updatedAt
    )
  }

  return {
    list: () =>
      db.prepare('select * from conversations order by last_entry_at desc, created_at desc').all().map(toConversation),
    get,

    findDm(botId) {
      const row = db
        .prepare(`select * from conversations where kind = 'dm' and json_extract(bot_ids, '$[0]') = ? limit 1`)
        .get(botId)
      return row ? toConversation(row) : undefined
    },

    findExchange(botA, botB) {
      const row = db
        .prepare(
          `select * from conversations where kind = 'exchange'
             and ((json_extract(bot_ids, '$[0]') = ? and json_extract(bot_ids, '$[1]') = ?)
               or (json_extract(bot_ids, '$[0]') = ? and json_extract(bot_ids, '$[1]') = ?))
           order by created_at limit 1`
        )
        .get(botA, botB, botB, botA)
      return row ? toConversation(row) : undefined
    },

    create(input) {
      checkMembers(input)
      const now = Date.now()
      const conversation: Conversation = {
        id: randomUUID(),
        kind: input.kind,
        title: input.title,
        botIds: [...input.botIds],
        ...(input.group && { group: { ...input.group } }),
        ...(input.origin && { origin: { ...input.origin } }),
        notes: input.notes ?? '',
        lastEntryAt: now,
        unreadCount: 0,
        createdAt: now,
        updatedAt: now
      }
      write(conversation)
      return conversation
    },

    update(id, patch) {
      const current = get(id)
      if (!current) throw new Error('Conversation not found')
      const next: Conversation = { ...current, ...defined(patch), id, kind: current.kind, createdAt: current.createdAt }
      // unreadCount and lastEntryAt are bookkeeping, not edits.
      const isEdit = Object.keys(defined(patch)).some((k) => k !== 'unreadCount' && k !== 'lastEntryAt')
      if (isEdit) next.updatedAt = Date.now()
      checkMembers(next)
      write(next)
      return next
    },

    delete(id) {
      // entries and bot_context go with it (foreign keys cascade).
      db.prepare('delete from conversations where id = ?').run(id)
    }
  }
}
