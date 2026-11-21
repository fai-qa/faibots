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

type Terminal = 'answered' | 'failed' | 'reconciliation_required'
interface Receipt {
  text: string
  partial?: string
  responder?: string
}

const interrupted = 'The app closed before the delegated task returned a confirmed result. Check the exchange before retrying.'

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
    if (parent.toolCall?.toolName === 'send_to_agent') {
      // A live native turn may already have added a more specific denial or warning.
      if (parent.toolCall.status === 'running') entries.update(parent.id, { toolCall: {
        ...parent.toolCall, status: result.isError ? 'error' : 'done',
        exchangeConversationId: work.exchangeId, resultText: resultPreview(result)
      } })
      if (recoverAction && work.state === 'answered' && parent.toolCall.actionId === work.id) {
        // The local child already returned. Close only this caller's exact action, without replay.
        db.prepare(`update actions set state = 'completed', receipt = ?, attempt = null, updated_at = ?
          where id = ? and bot_id = ? and conversation_id = ? and tool_name = 'send_to_agent'
          and state in ('dispatched','recovering','unknown')`)
          .run(JSON.stringify(result), Date.now(), work.id, work.callerId, work.parentId)
      }
    } else if (parent.kind === 'event') {
      entries.update(parent.id, { text: resultPreview(result) })
    }
  }

  return {
    get,
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
      transaction(db, () => {
        const updated = db.prepare(`update delegations set state = ?, receipt = ?, lease = null, updated_at = ?
          where id = ? and lease = ? and state = 'assigned'`).run(state, JSON.stringify(receipt), Date.now(), lease.id, lease.token)
        if (updated.changes !== 1) throw new Error('The delegation lease is no longer valid. Its result was not changed.')
        // External engines can call through the bridge before they supply a visible tool card.
        const work = get(lease.id)!
        if (entries.get(work.parentEntryId)?.kind === 'event') present(work, false)
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
