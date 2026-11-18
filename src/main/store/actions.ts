import { randomUUID } from 'node:crypto'
import type { ActionRecord, ActionRepo } from '../contracts'
import { type Db, type Row, num, optStr, parseJson, str, transaction } from './db'

function read(row: Row): ActionRecord {
  return { id: str(row.id), botId: str(row.bot_id), conversationId: str(row.conversation_id),
    toolName: str(row.tool_name), inputDigest: str(row.input_digest), capability: str(row.capability),
    state: str(row.state) as ActionRecord['state'], attempt: optStr(row.attempt),
    approvedDigest: optStr(row.approved_digest), receipt: parseJson(row.receipt, undefined),
    createdAt: num(row.created_at), updatedAt: num(row.updated_at) }
}

export function createActionRepo(db: Db): ActionRepo {
  const get = (id: string) => {
    const row = db.prepare('select * from actions where id = ?').get(id) as Row | undefined
    return row ? read(row) : undefined
  }
  return {
    get,
    claim(intent, canRecover) {
      return transaction(db, () => {
        const now = Date.now()
        // A write first acquires SQLite's writer reservation before reading other claims.
        db.prepare(`insert into actions(id,bot_id,conversation_id,tool_name,input_digest,capability,state,created_at,updated_at)
          values (?,?,?,?,?,?,'prepared',?,?) on conflict(id) do nothing`).run(
          intent.id, intent.botId, intent.conversationId, intent.toolName, intent.inputDigest, intent.capability, now, now)
        const record = get(intent.id)!
        if (record.botId !== intent.botId || record.conversationId !== intent.conversationId ||
          record.toolName !== intent.toolName || record.inputDigest !== intent.inputDigest || record.capability !== intent.capability) {
          return { kind: 'blocked', reason: 'Action identity does not match the original input, scope or tool capability.' }
        }
        if (['completed', 'denied', 'cancelled'].includes(record.state)) return { kind: 'receipt', record }
        const other = db.prepare(`select id from actions where id != ? and bot_id = ? and conversation_id = ?
          and tool_name = ? and input_digest = ? and state in ('claimed','dispatched','recovering','unknown') limit 1`)
          .get(intent.id, intent.botId, intent.conversationId, intent.toolName, intent.inputDigest)
        if (other) return { kind: 'blocked', reason: 'An equivalent action is unresolved. Reconcile its original identity before starting another.' }
        const recovering = record.state === 'unknown'
        if (record.state !== 'prepared' && !(recovering && canRecover && record.approvedDigest === record.inputDigest)) {
          return { kind: 'blocked', reason: 'Action is in progress or its outcome is unknown. Automatic retry is blocked without supported reconciliation.' }
        }
        const attempt = randomUUID()
        db.prepare('update actions set state = ?, attempt = ?, updated_at = ? where id = ?')
          .run(recovering ? 'recovering' : 'claimed', attempt, now, intent.id)
        return { kind: 'claimed', record: get(intent.id)!, recovering }
      })
    },
    dispatch(id, attempt) {
      const changed = db.prepare(`update actions set state = 'dispatched', approved_digest = input_digest, updated_at = ?
        where id = ? and attempt = ? and state = 'claimed'`).run(Date.now(), id, attempt)
      if (changed.changes !== 1) throw new Error('Action claim is no longer valid; dispatch blocked.')
    },
    finish(id, attempt, state, receipt) {
      const changed = db.prepare(`update actions set state = ?, receipt = ?, attempt = null, updated_at = ?
        where id = ? and attempt = ? and state in ('claimed','dispatched','recovering')`)
        .run(state, receipt ? JSON.stringify(receipt) : null, Date.now(), id, attempt)
      if (changed.changes !== 1) throw new Error('Action claim is no longer valid; receipt not overwritten.')
    },
    recoverInterrupted() {
      return transaction(db, () => {
        const result = db.prepare(`update actions set state = case when state = 'claimed' then 'prepared' else 'unknown' end,
          attempt = null, updated_at = ? where state in ('claimed','dispatched','recovering')`).run(Date.now())
        return Number(result.changes)
      })
    }
  }
}
