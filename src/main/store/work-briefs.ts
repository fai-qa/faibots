import { randomUUID } from 'node:crypto'
import type { WorkBrief, WorkReply, WorkState } from '@shared/work-brief'
import { num, parseJson, str, transaction, type Db, type Row } from './db'

export const workBriefSchema = `
  create table chief_work (
    id text primary key, conversation_id text not null, user_entry_id text not null unique,
    objective text not null, deliverable text not null, checks text not null,
    state text not null, revision integer not null, question text not null default '',
    result text not null default '', evidence_ids text not null default '[]', updated_at integer not null
  );
  create index chief_work_chat on chief_work(conversation_id, updated_at);
  create table chief_decisions (
    work_id text not null references chief_work(id), revision integer not null, decision text not null,
    note text not null, created_at integer not null, pending_reply integer not null,
    primary key(work_id, revision)
  );`

function read(row: Row): WorkBrief {
  return { id: str(row.id), conversationId: str(row.conversation_id), userEntryId: str(row.user_entry_id),
    objective: str(row.objective), deliverable: str(row.deliverable), checks: str(row.checks),
    state: str(row.state) as WorkState, revision: num(row.revision), question: str(row.question),
    result: str(row.result), evidenceIds: parseJson<string[]>(row.evidence_ids, []), updatedAt: num(row.updated_at) }
}

export function workBriefs(db: Db) {
  function get(id: string, chat: string): WorkBrief {
    const row = db.prepare('select * from chief_work where id=? and conversation_id=?').get(id, chat)
    if (!row) throw new Error('No such work in this chat.')
    return read(row)
  }
  return {
    get,
    list(chat: string) {
      return db.prepare('select * from chief_work where conversation_id=? order by updated_at desc, rowid desc').all(chat).map(read)
    },
    start(chat: string, entry: string, objective: string, deliverable: string, checks: string) {
      const now = Date.now()
      return transaction(db, () => {
        const source = db.prepare("select id from entries where id=? and conversation_id=? and kind='message' and json_extract(author,'$.kind')='user'").get(entry, chat)
        if (!source) throw new Error('A work brief needs the original user request from this chat.')
        db.prepare(`insert into chief_work(id,conversation_id,user_entry_id,objective,deliverable,checks,state,revision,updated_at)
          values(?,?,?,?,?,?,'active',1,?) on conflict(user_entry_id) do nothing`).run(randomUUID(), chat, entry, objective, deliverable, checks, now)
        return read(db.prepare('select * from chief_work where user_entry_id=?').get(entry)!)
      })
    },
    submit(chat: string, id: string, revision: number, kind: 'question' | 'result', text: string, evidenceIds: string[]) {
      return transaction(db, () => {
        const current = get(id, chat)
        if (current.state !== 'active' || current.revision !== revision) throw new Error('This brief changed. Read its current state before updating it.')
        for (const evidence of evidenceIds) {
          if (!db.prepare('select id from entries where id=? and conversation_id=?').get(evidence, chat)) throw new Error('The evidence is unavailable in this chat.')
        }
        const result = db.prepare(`update chief_work set state=?, question=?, result=?, evidence_ids=?, revision=revision+1, updated_at=?
          where id=? and revision=? and state='active'`).run(kind === 'question' ? 'needs_input' : 'review',
          kind === 'question' ? text : '', kind === 'result' ? text : current.result, JSON.stringify(evidenceIds), Date.now(), id, revision)
        if (!result.changes) throw new Error('The brief was updated in another session.')
        return get(id, chat)
      })
    },
    decide(chat: string, reply: WorkReply) {
      return transaction(db, () => {
        const current = get(reply.id, chat)
        const note = reply.note.trim()
        if (note.length > 8000) throw new Error('Keep the decision under 8000 characters.')
        const old = db.prepare('select decision,note from chief_decisions where work_id=? and revision=?').get(reply.id, reply.revision)
        if (old && old.decision === reply.decision && old.note === note) return current
        if (current.revision !== reply.revision) throw new Error('This work has changed. Review its latest version.')
        const resume = reply.decision === 'answer' || reply.decision === 'request_changes'
        const allowed = reply.decision === 'cancel' ? ['active','needs_input','review'] :
          reply.decision === 'answer' ? ['needs_input'] : ['review']
        if (!['answer','accept','request_changes','cancel'].includes(reply.decision) || !allowed.includes(current.state)) throw new Error('This decision does not apply to the current work.')
        if (resume && !note) throw new Error('Enter your answer or requested change.')
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
