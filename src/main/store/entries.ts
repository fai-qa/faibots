import { randomUUID } from 'node:crypto'
import type { ApprovalInfo, Attachment, Author, Entry, EntryTrigger, Id, ToolCallInfo } from '@shared/domain'
import type { EntryRepo } from '../contracts'
import { bool, defined, jsonOrNull, num, optStr, parseJson, str, transaction, type Db, type Row } from './db'

function toEntry(r: Row): Entry {
  const toolCall = parseJson<ToolCallInfo | null>(r['tool_call'], null)
  const approval = parseJson<ApprovalInfo | null>(r['approval'], null)
  const meta = parseJson<Entry['meta'] | null>(r['meta'], null)
  const trigger = parseJson<EntryTrigger | null>(r['trigger'], null)
  const replyToId = optStr(r['reply_to_id'])
  const clientNonce = optStr(r['client_nonce'])
  return {
    id: str(r['id']),
    conversationId: str(r['conversation_id']),
    seq: num(r['seq']),
    kind: str(r['kind']) as Entry['kind'],
    author: parseJson<Author>(r['author'], { kind: 'system' }),
    text: str(r['text']),
    mentions: parseJson<Id[]>(r['mentions'], []),
    mentionsEveryone: bool(r['mentions_everyone']),
    ...(replyToId && { replyToId }),
    attachments: parseJson<Attachment[]>(r['attachments'], []),
    ...(toolCall && { toolCall }),
    ...(approval && { approval }),
    isStreaming: bool(r['is_streaming']),
    ...(clientNonce && { clientNonce }),
    ...(meta && { meta }),
    ...(trigger && { trigger }),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

/** Bot posts that should light up the unread badge. */
const countsAsUnread = (e: Pick<Entry, 'author' | 'kind'>) =>
  e.author.kind === 'bot' && (e.kind === 'message' || e.kind === 'approval')

export interface PlatformEntryRepo extends EntryRepo {
  /** Approval entries still marked pending (used to expire them after a restart). */
  pendingApprovals(): Entry[]
  /** Entries carrying this approval id (an exchange's card is mirrored into the root chat). */
  byApprovalId(approvalId: Id): Entry[]
}

export function createEntryRepo(db: Db): PlatformEntryRepo {
  const selectOne = db.prepare('select * from entries where id = ?')

  const get = (id: Id) => {
    const row = selectOne.get(id)
    return row ? toEntry(row) : undefined
  }

  const write = (e: Entry) => {
    db.prepare(
      `insert into entries (id, conversation_id, seq, kind, author, text, mentions, mentions_everyone, reply_to_id,
         attachments, tool_call, approval, is_streaming, client_nonce, meta, trigger, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set kind = excluded.kind, author = excluded.author, text = excluded.text,
         mentions = excluded.mentions, mentions_everyone = excluded.mentions_everyone,
         reply_to_id = excluded.reply_to_id, attachments = excluded.attachments, tool_call = excluded.tool_call,
         approval = excluded.approval, is_streaming = excluded.is_streaming, client_nonce = excluded.client_nonce,
         meta = excluded.meta, trigger = excluded.trigger, updated_at = excluded.updated_at`
    ).run(
      e.id, e.conversationId, e.seq, e.kind, JSON.stringify(e.author), e.text, JSON.stringify(e.mentions),
      e.mentionsEveryone ? 1 : 0, e.replyToId ?? null, JSON.stringify(e.attachments), jsonOrNull(e.toolCall),
      jsonOrNull(e.approval), e.isStreaming ? 1 : 0, e.clientNonce ?? null, jsonOrNull(e.meta), jsonOrNull(e.trigger), e.createdAt,
      e.updatedAt
    )
  }

  return {
    append(input) {
      return transaction(db, () => {
        const conv = db.prepare('select id from conversations where id = ?').get(input.conversationId)
        if (!conv) throw new Error('Conversation not found')
        if (input.clientNonce) {
          // Idempotent: a retried send returns the entry the first attempt stored.
          const existing = db
            .prepare('select * from entries where conversation_id = ? and client_nonce = ?')
            .get(input.conversationId, input.clientNonce)
          if (existing) return toEntry(existing)
        }
        const last = db.prepare('select max(seq) as seq from entries where conversation_id = ?').get(input.conversationId)
        const now = Date.now()
        const entry: Entry = {
          ...input,
          id: input.id ?? randomUUID(),
          seq: num(last?.['seq']) + 1,
          createdAt: now,
          updatedAt: now
        }
        write(entry)
        db.prepare(
          `update conversations set last_entry_at = ?, unread_count = unread_count + ? where id = ?`
        ).run(now, countsAsUnread(entry) ? 1 : 0, entry.conversationId)
        return entry
      })
    },

    update(id, patch) {
      const current = get(id)
      if (!current) throw new Error('Entry not found')
      const next: Entry = {
        ...current,
        ...defined(patch),
        id,
        conversationId: current.conversationId,
        seq: current.seq,
        createdAt: current.createdAt,
        updatedAt: Date.now()
      }
      write(next)
      return next
    },

    get,

    findByNonce(conversationId, clientNonce) {
      const row = db
        .prepare('select * from entries where conversation_id = ? and client_nonce = ?')
        .get(conversationId, clientNonce)
      return row ? toEntry(row) : undefined
    },

    page(conversationId, { beforeSeq, limit }) {
      const size = Math.max(1, Math.floor(limit))
      const rows = db
        .prepare('select * from entries where conversation_id = ? and seq < ? order by seq desc limit ?')
        .all(conversationId, beforeSeq ?? Number.MAX_SAFE_INTEGER, size + 1)
      const hasMore = rows.length > size
      return { entries: rows.slice(0, size).reverse().map(toEntry), hasMore }
    },

    since(conversationId, afterSeq, limit) {
      return db
        .prepare('select * from entries where conversation_id = ? and seq > ? order by seq limit ?')
        .all(conversationId, afterSeq, limit ?? -1)
        .map(toEntry)
    },

    clear(conversationId) {
      db.prepare('delete from entries where conversation_id = ?').run(conversationId)
      db.prepare('update conversations set unread_count = 0 where id = ?').run(conversationId)
    },

    interrupted() {
      return db.prepare(`select * from entries where is_streaming = 1
        or (kind = 'tool-call' and json_extract(tool_call, '$.status') = 'running')`).all().map(toEntry)
    },

    pendingApprovals() {
      return db
        .prepare(`select * from entries where kind = 'approval' and json_extract(approval, '$.status') = 'pending'`)
        .all()
        .map(toEntry)
    },

    byApprovalId(approvalId) {
      return db
        .prepare(`select * from entries where kind = 'approval' and json_extract(approval, '$.approvalId') = ?`)
        .all(approvalId)
        .map(toEntry)
    }
  }
}
