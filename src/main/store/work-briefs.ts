import { randomUUID } from 'node:crypto'
import type { EntryRepo } from '../contracts'
import { MAX_ASKS_PER_CHAIN, type WorkBrief, type WorkConstraints, type WorkReply, type WorkState, type WorkWait } from '@shared/work-brief'
import { num, parseJson, str, transaction, type Db, type Row } from './db'
import { evaluateWait, invalidWait, waitDueAt } from './work-waits'

export class WorkRefusal extends Error {}

function read(row: Row): WorkBrief {
  return { id: str(row.id), conversationId: str(row.conversation_id), userEntryId: str(row.user_entry_id),
    objective: str(row.objective), deliverable: str(row.deliverable), checks: str(row.checks),
    exclusions: str(row.exclusions), stopWhen: str(row.stop_when), assignmentLimit: num(row.assignment_limit),
    state: str(row.state) as WorkState, revision: num(row.revision), question: str(row.question), lastInstruction: str(row.last_instruction ?? ''),
    choices: parseJson<string[]>(row.question_choices, []),
    ...(row.state === 'waiting' && { waitingFor: parseJson<WorkWait>(row.predicate, {kind:'all'}) }),
    result: str(row.result), partial: Boolean(row.partial), evidenceIds: parseJson<string[]>(row.evidence_ids, []), updatedAt: num(row.updated_at) }
}

export function workBriefs(db: Db) {
  const selected = `select w.*, (select k.predicate from chief_wakes k where k.work_id=w.id and k.revision=w.revision-1) as predicate,
    (select d.note from chief_decisions d where d.work_id=w.id and d.decision in ('answer','steer','request_changes')
    order by d.revision desc limit 1) as last_instruction from chief_work w`
  function superseded(turnId: string) {
    return Boolean(db.prepare(`select 1 from chief_work_turns t join chief_decisions d on d.work_id=t.work_id
      where t.turn_id=? and d.decision='steer' and d.revision>=t.work_revision`).get(turnId))
  }
  function get(id: string, chat: string): WorkBrief {
    const row = db.prepare(selected+' where w.id=? and w.conversation_id=?').get(id, chat)
    if (!row) throw new WorkRefusal('No such work in this chat.')
    return read(row)
  }
  function bindTurn(id: string, turnId: string) {
    db.prepare('insert into chief_work_turns(turn_id,work_id,work_revision) select ?,id,revision from chief_work where id=? on conflict(turn_id) do nothing').run(turnId,id)
    if (superseded(turnId)) throw new WorkRefusal('The owner updated this brief. The next turn will handle the new instruction.')
    const row = db.prepare('select work_id from chief_work_turns where turn_id=?').get(turnId)
    if (row?.work_id !== id) throw new WorkRefusal('This turn already belongs to another brief.')
  }
  function children(id: string) {
    return db.prepare(`select d.id,d.state,d.receipt,d.updated_at,p.client_nonce from chief_work_turns t
      join assignment_admissions a on a.root_turn_id=t.turn_id join delegations d on d.id=a.assignment_id
      join entries p on p.id=d.parent_entry_id where t.work_id=? order by d.created_at,d.id`).all(id)
  }
  return {
    get, superseded,
    rootForTurn(turnId: string) {
      const bound = db.prepare(`select w.id,w.state,w.assignment_limit,t.turn_id from chief_work_turns b join chief_work w on w.id=b.work_id
        join chief_work_turns t on t.work_id=w.id where b.turn_id=? order by t.rowid limit 1`).get(turnId)
      return bound && { id: str(bound.id), state: str(bound.state), rootTurnId: str(bound.turn_id), assignmentLimit: num(bound.assignment_limit) }
    },
    assignments(id: string) { return children(id).map(row => ({ id: str(row.id), state: str(row.state) })) },
    wait(chat: string, id: string, revision: number, turnId: string, predicate: WorkWait = {kind:'all'}) {
      return transaction(db, () => {
        const current = get(id,chat)
        if (current.state !== 'active' || current.revision !== revision) throw new WorkRefusal('Review the current brief before waiting.')
        bindTurn(id,turnId)
        const reason = invalidWait(db,chat,predicate,children(id),Date.now())
        if (reason) throw new WorkRefusal(reason)
        const cursor = predicate.kind === 'webhook' ? db.prepare('select coalesce(max(rowid),0) as last from routine_runs').get()?.last : null
        db.prepare("insert into chief_wakes(work_id,revision,state,predicate,due_at,signal_after) values(?,?,'pending',?,?,?)")
          .run(id,revision,JSON.stringify(predicate),waitDueAt(predicate),cursor ?? null)
        db.prepare("update chief_work set state='waiting',revision=revision+1,updated_at=? where id=?").run(Date.now(),id)
        return get(id,chat)
      })
    },
    ready(entries: EntryRepo) {
      return transaction(db, () => {
        const waits = db.prepare(`select k.*,w.conversation_id from chief_wakes k join chief_work w on w.id=k.work_id
          where k.state='pending' and w.state='waiting' and w.revision=k.revision+1`).all()
        for (const row of waits) {
          const id = str(row.work_id)
          const jobs = children(id)
          const outcome = evaluateWait(db,row,parseJson<WorkWait>(row.predicate,{kind:'all'}),jobs,Date.now())
          if (!outcome) continue
          const entry = entries.append({ conversationId: str(row.conversation_id), kind: 'message', author: {kind:'system'},
            text: `Work brief ${id}. ${outcome.message}`,
            clientNonce: `work-wake-${id}-${row.revision}`, mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false })
          db.prepare("update chief_wakes set state='ready',entry_id=?,cancel_ids=? where work_id=? and revision=?")
            .run(entry.id,JSON.stringify(outcome.cancel ?? []),id,row.revision!)
          db.prepare("update chief_work set state='active',revision=revision+1,updated_at=? where id=?").run(Date.now(),id)
        }
        return db.prepare(`select k.work_id,k.revision,k.entry_id,w.conversation_id from chief_wakes k join chief_work w on w.id=k.work_id
          where k.state='ready' and w.state='active' and w.revision=k.revision+2`).all()
          .map(row => ({ id:str(row.work_id), revision:num(row.revision), entryId:str(row.entry_id), chat:str(row.conversation_id) }))
      })
    },
    nextCheckAt(now: number): number | undefined {
      const pending = ` from chief_wakes k join chief_work w on w.id=k.work_id where k.state='pending'
        and w.state='waiting' and w.revision=k.revision+1`
      const due = db.prepare('select min(k.due_at) as at'+pending).get()?.at
      const external = db.prepare('select 1'+pending+" and json_extract(k.predicate,'$.kind')='webhook' limit 1").get()
      if (external) return Math.min(now+1000, due == null ? Infinity : num(due))
      return due == null ? undefined : num(due)
    },
    claimWake(id: string, revision: number, turnId: string) {
      return transaction(db,() => {
        const changed = db.prepare(`update chief_wakes set state='started' where work_id=? and revision=? and state='ready'
          and exists(select 1 from chief_work where id=? and state='active' and revision=?+2)`).run(id,revision,id,revision)
        if (!changed.changes) return undefined
        bindTurn(id,turnId)
        const row = db.prepare('select cancel_ids from chief_wakes where work_id=? and revision=?').get(id,revision)
        return { cancel: parseJson<string[]>(row?.cancel_ids,[]) }
      })
    },
    finishWake(id: string, revision: number, ok: boolean) {
      db.prepare("update chief_wakes set state=? where work_id=? and revision=? and state='started'").run(ok?'finished':'interrupted',id,revision)
    },
    interrupted() {
      return transaction(db,() => {
        const rows = db.prepare(`select k.work_id,w.conversation_id from chief_wakes k join chief_work w on w.id=k.work_id where k.state='started'`).all()
        db.prepare("update chief_wakes set state='interrupted' where state='started'").run()
        return rows.map(r=>({ id:str(r.work_id), chat:str(r.conversation_id) }))
      })
    },
    resume(chat: string, id: string, turnId: string) {
      const current = get(id, chat)
      if (current.state !== 'active') throw new WorkRefusal('This brief is waiting for the owner or is closed.')
      bindTurn(id, turnId)
      return current
    },
    list(chat: string) {
      return db.prepare(selected+' where w.conversation_id=? order by w.updated_at desc, w.rowid desc').all(chat).map(read)
    },
    start(chat: string, entry: string, turnId: string, objective: string, deliverable: string, checks: string, constraints: Partial<WorkConstraints> = {}) {
      const now = Date.now()
      return transaction(db, () => {
        const source = db.prepare("select id,client_nonce from entries where id=? and conversation_id=? and kind='message' and json_extract(author,'$.kind')='user'").get(entry, chat)
        if (!source) throw new WorkRefusal('A work brief needs the original user request from this chat.')
        const resumed = db.prepare(`select w.* from chief_decisions d join chief_work w on w.id=d.work_id
          where w.conversation_id=? and 'work-'||w.id||'-'||d.revision=?`).get(chat, source.client_nonce ?? null)
        if (resumed) {
          if (resumed.state !== 'active') throw new WorkRefusal('This brief has already changed.')
          bindTurn(str(resumed.id),turnId)
          return get(str(resumed.id),chat)
        }
        const recorded = db.prepare('select * from chief_work where user_entry_id=?').get(entry)
        if (recorded) {
          bindTurn(str(recorded.id), turnId)
          return get(str(recorded.id), chat)
        }
        const limit = constraints.assignmentLimit ?? MAX_ASKS_PER_CHAIN
        const admitted = db.prepare('select count(*) as n from assignment_admissions where root_turn_id=?').get(turnId)!
        if (num(admitted.n) > limit) throw new WorkRefusal('More specialist assignments have already started than this limit allows. Report that to the owner.')
        const id = randomUUID()
        db.prepare(`insert into chief_work(id,conversation_id,user_entry_id,objective,deliverable,checks,exclusions,stop_when,assignment_limit,state,revision,updated_at)
          values(?,?,?,?,?,?,?,?,?,'active',1,?)`).run(id, chat, entry, objective, deliverable, checks,
            constraints.exclusions ?? '', constraints.stopWhen ?? '', limit, now)
        bindTurn(id, turnId)
        return get(id, chat)
      })
    },
    submit(chat: string, id: string, revision: number, kind: 'question' | 'result', text: string, evidenceIds: string[], turnId: string, partial: boolean, choices: string[] = []) {
      return transaction(db, () => {
        const current = get(id, chat)
        if (current.state !== 'active' || current.revision !== revision) throw new WorkRefusal('This brief changed. Read its current state before updating it.')
        bindTurn(id,turnId)
        if (kind === 'result') {
          const assigned = children(id)
          if (assigned.some((child) => child.state === 'assigned')) throw new WorkRefusal('A required assignment is still running.')
          if (!partial && assigned.some((child) => child.state !== 'answered')) throw new WorkRefusal('An assignment failed or is uncertain. Submit the useful partial result with its limit.')
        }
        for (const evidence of evidenceIds) {
          if (!db.prepare('select id from entries where id=? and conversation_id=?').get(evidence, chat)) throw new WorkRefusal('The evidence is unavailable in this chat.')
        }
        const result = db.prepare(`update chief_work set state=?, question=?, question_choices=?, result=?, partial=?, evidence_ids=?, revision=revision+1, updated_at=?
          where id=? and revision=? and state='active'`).run(kind === 'question' ? 'needs_input' : 'review',
          kind === 'question' ? text : '', JSON.stringify(kind === 'question' ? choices : []),
          kind === 'result' ? text : current.result, partial ? 1 : 0, JSON.stringify(evidenceIds), Date.now(), id, revision)
        if (!result.changes) throw new WorkRefusal('The brief was updated in another session.')
        return get(id, chat)
      })
    },
    decide(chat: string, reply: WorkReply) {
      return transaction(db, () => {
        const current = get(reply.id, chat)
        const note = reply.note.trim()
        if (note.length > 8000) throw new WorkRefusal('Keep the decision under 8000 characters.')
        const old = db.prepare('select decision,note from chief_decisions where work_id=? and revision=?').get(reply.id, reply.revision)
        if (old && old.decision === reply.decision && old.note === note) return current
        if (current.revision !== reply.revision) throw new WorkRefusal('This work has changed. Review its latest version.')
        const resume = reply.decision === 'steer' || reply.decision === 'answer' || reply.decision === 'request_changes'
        const allowed = reply.decision === 'cancel' ? ['active','waiting','needs_input','review'] :
          reply.decision === 'steer' ? ['active','waiting'] : reply.decision === 'answer' ? ['needs_input'] : ['review']
        if (!['steer','answer','accept','request_changes','cancel'].includes(reply.decision) || !allowed.includes(current.state)) throw new WorkRefusal('This decision does not apply to the current work.')
        if (resume && !note) throw new WorkRefusal('Enter your answer or requested change.')
        const next = resume ? 'active' : reply.decision === 'cancel' ? 'cancelled' : 'accepted'
        const now = Date.now()
        db.prepare('insert into chief_decisions(work_id,revision,decision,note,created_at,pending_reply) values(?,?,?,?,?,?)')
          .run(current.id, current.revision, reply.decision, note, now, resume ? 1 : 0)
        db.prepare('update chief_work set state=?,revision=revision+1,updated_at=? where id=? and revision=?').run(next, now, current.id, current.revision)
        return get(current.id, chat)
      })
    },
    pending() {
      return db.prepare(`select w.id,w.conversation_id,w.objective,d.revision,d.note,d.decision from chief_decisions d
        join chief_work w on w.id=d.work_id where d.pending_reply=1 and w.state='active' and w.revision=d.revision+1 order by d.created_at`).all()
        .map((r) => ({ id: str(r.id), conversationId: str(r.conversation_id), objective: str(r.objective), revision: num(r.revision), note: str(r.note), decision: str(r.decision) }))
    },
    acknowledge(id: string, revision: number) {
      db.prepare('update chief_decisions set pending_reply=0 where work_id=? and revision=?').run(id, revision)
    }
  }
}
