import { randomUUID } from 'node:crypto'
import type { Entry } from '@shared/domain'
import type { EntryRepo, ToolResult } from '../contracts'
import { resultPreview } from '../agent/turn-recorder'
import { type Db, type Row, parseJson, str, transaction } from './db'

interface Identity {
  id: string
  callerId: string
  childId: string
  parentId: string
  inputHash: string
}

export interface DelegationLease {
  id: string
  token: string
}
export interface AssignmentRoot {
  turnId: string
  conversationId: string
  parentAssignmentId?: string
}

type Terminal = 'answered' | 'failed' | 'reconciliation_required'
interface Receipt {
  text: string
  partial?: string
  responder?: string
}

const interrupted = 'The app closed before the delegated task returned a confirmed result. Check the exchange before retrying.'
export const backgroundAnchor = (id: string) => `faibots:assignment:${id}`
const resultNonce = (id: string) => `faibots:assignment-result:${id}`

export function createDelegationRepo(db: Db, entries: EntryRepo) {
  const select = `select d.*, p.conversation_id as parent_id, q.conversation_id as exchange_id
    from delegations d join entries p on p.id = parent_entry_id join entries q on q.id = question_id`
  function read(row: Row) {
    return {
      id: str(row.id), callerId: str(row.caller_id), childId: str(row.child_id), parentId: str(row.parent_id),
      inputHash: str(row.input_hash), parentEntryId: str(row.parent_entry_id), exchangeId: str(row.exchange_id),
      state: str(row.state) as 'assigned' | Terminal, receipt: parseJson<Receipt | undefined>(row.receipt, undefined)
    }
  }
  function get(id: string) {
    const row = db.prepare(select + ' where d.id = ?').get(id)
    return row && read(row)
  }
  type Assignment = ReturnType<typeof read>

  // This is a transcript acknowledgement. The parent model may have exited before reading it.
  function present(work: Assignment, recoverAction: boolean) {
    const parent = entries.get(work.parentEntryId)
    if (!parent || work.state === 'assigned') return
    const body = work.receipt?.text ?? interrupted
    const text = work.state === 'answered' ? `${work.receipt?.responder ? work.receipt.responder + ' replied' : 'Delegated reply'}:\n\n${body}` :
      work.receipt?.partial ? `${body}\n\nUnfinished reply:\n\n${work.receipt.partial}` : body
    const result: ToolResult = {
      content: [{ type: 'text', text }], ...(work.state !== 'answered' && { isError: true }),
      display: { exchangeConversationId: work.exchangeId }
    }
    const detached = parent.kind === 'event' && parent.author.kind === 'system' && parent.clientNonce === backgroundAnchor(work.id)
    if (parent.toolCall?.toolName === 'send_to_agent') {
      // A live native turn may already have added a more specific denial or warning.
      if (parent.toolCall.status === 'running') entries.update(parent.id, { toolCall: {
        ...parent.toolCall, status: result.isError ? 'error' : 'done',
        exchangeConversationId: work.exchangeId, resultText: resultPreview(result)
      } })
    } else if (!detached && parent.kind === 'event') {
      entries.update(parent.id, { text: resultPreview(result) })
    }
    if (recoverAction && work.state === 'answered' && (parent.toolCall?.actionId === work.id || detached)) {
      db.prepare(`update actions set state = 'completed', receipt = ?, attempt = null, updated_at = ?
        where id = ? and bot_id = ? and conversation_id = ? and tool_name = 'send_to_agent'
        and state in ('dispatched','recovering','unknown')`)
        .run(JSON.stringify(result), Date.now(), work.id, work.callerId, work.parentId)
    }
    if (detached) {
      return entries.append({ conversationId: work.parentId, kind: 'message', author: { kind: 'system' },
        text: `Background assignment ${work.id} (${work.state}):\n\n${text}`, replyToId: parent.id,
        clientNonce: resultNonce(work.id), mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false })
    }
  }

  return {
    get,
    reserve(id: string, root: AssignmentRoot, limit: number) {
      const added = db.prepare(`insert into assignment_admissions(assignment_id,root_turn_id,root_conversation_id,parent_assignment_id,created_at)
        select ?,?,?,?,? where (select count(*) from assignment_admissions where root_turn_id = ?) < ?
        on conflict(assignment_id) do nothing`).run(id, root.turnId, root.conversationId, root.parentAssignmentId ?? null, Date.now(), root.turnId, limit)
      return added.changes === 1
    },
    groupSnapshot(groupId: string) {
      // A delegation from before root budgets can still be shown in its directly recorded room.
      const source = ` from delegations d join entries p on p.id = d.parent_entry_id
        left join assignment_admissions a on a.assignment_id = d.id where coalesce(a.root_conversation_id,p.conversation_id) = ?`
      const totals = db.prepare('select d.state,count(*) as n' + source + ' group by d.state').all(groupId)
      const latest = db.prepare('select d.id,d.state,d.child_id' + source + ' order by d.created_at desc,d.id limit 20').all(groupId)
      return { totals, latest }
    },
    list(callerId: string, parentId: string, activeOnly = false) {
      return db.prepare(select + ` where d.caller_id = ? and p.conversation_id = ? and p.kind = 'event'
        and p.client_nonce = 'faibots:assignment:' || d.id ${activeOnly ? "and d.state = 'assigned'" : ''}
        order by d.created_at desc, d.id limit 30`).all(callerId, parentId).map(read)
    },
    scoped(id: string, callerId: string, parentId: string) {
      const work = get(id)
      if (!work || work.callerId !== callerId || work.parentId !== parentId) return undefined
      const entry = entries.get(work.parentEntryId)
      return entry?.kind === 'event' && entry.author.kind === 'system' && entry.clientNonce === backgroundAnchor(id) ? work : undefined
    },
    assign(identity: Identity, createEntries: () => { parent: Entry; question: Entry }) {
      return transaction(db, () => {
        const existing = get(identity.id)
        if (existing) {
          if (existing.callerId !== identity.callerId || existing.childId !== identity.childId ||
              existing.parentId !== identity.parentId || existing.inputHash !== identity.inputHash) {
            throw new Error('The delegated task identity does not match the original request.')
          }
          return { existing } as const
        }
        const { parent, question } = createEntries()
        const lease: DelegationLease = { id: identity.id, token: randomUUID() }
        const now = Date.now()
        db.prepare(`insert into delegations(id,caller_id,child_id,input_hash,parent_entry_id,question_id,
          state,lease,created_at,updated_at) values(?,?,?,?,?,?,'assigned',?,?,?)`)
          .run(identity.id, identity.callerId, identity.childId, identity.inputHash, parent.id, question.id, lease.token, now, now)
        return { lease, parent, question } as const
      })
    },
    pin(lease: DelegationLease, engine: string, systemHash: string) {
      const result = db.prepare(`update delegations set engine = ?, system_hash = ?, updated_at = ?
        where id = ? and lease = ? and state = 'assigned' and engine is null`)
        .run(engine, systemHash, Date.now(), lease.id, lease.token)
      if (result.changes !== 1) throw new Error('The delegation lease is no longer available for dispatch.')
    },
    finish(lease: DelegationLease, state: Terminal, receipt: Receipt) {
      return transaction(db, () => {
        const updated = db.prepare(`update delegations set state = ?, receipt = ?, lease = null, updated_at = ?
          where id = ? and lease = ? and state = 'assigned'`).run(state, JSON.stringify(receipt), Date.now(), lease.id, lease.token)
        if (updated.changes !== 1) throw new Error('The delegation lease is no longer valid. Its result was not changed.')
        // External engines can call through the bridge before they supply a visible tool card.
        const work = get(lease.id)!
        if (entries.get(work.parentEntryId)?.kind === 'event') return present(work, false)
      })
    },
    acknowledge(id: string, parentEntryId: string) {
      db.prepare(`update delegations set delivered_at = ? where id = ? and parent_entry_id = ?
        and state != 'assigned' and delivered_at is null`).run(Date.now(), id, parentEntryId)
    },
    recover() {
      return transaction(db, () => {
        const now = Date.now()
        db.prepare(`update delegations set state = 'reconciliation_required', lease = null, receipt = ?, updated_at = ?
          where state = 'assigned'`).run(JSON.stringify({ text: interrupted }), now)
        const records = db.prepare(select + ' where d.delivered_at is null').all()
        for (const raw of records) {
          const work = read(raw)
          present(work, true)
          db.prepare('update delegations set delivered_at = ? where id = ?').run(now, work.id)
        }
      })
    }
  }
}
