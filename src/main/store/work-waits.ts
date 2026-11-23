import type { WorkWait } from '@shared/work-brief'
import { parseJson, str, type Db, type Row } from './db'

export function waitDueAt(wait: WorkWait): number | null {
  const date = wait.kind === 'time' ? wait.at : wait.deadline
  return date ? Date.parse(date) : null
}

function ownsWebhook(db: Db, chat: string, routineId: string) {
  return db.prepare(`select r.id from routines r join conversations c on c.id=? and c.kind='dm'
    and json_extract(c.bot_ids,'$[0]')=r.bot_id where r.id=? and r.created_by='user'
    and r.enabled=1 and r.webhook_enabled=1 and r.webhook_token_hash is not null`).get(chat,routineId)
}

export function invalidWait(db: Db, chat: string, wait: WorkWait, jobs: Row[], now: number) {
  const due = waitDueAt(wait)
  if (due !== null && (!Number.isFinite(due) || due <= now)) return 'Choose a future time including the time zone.'
  if (wait.kind === 'time') return
  if (wait.kind === 'webhook') {
    if (!ownsWebhook(db,chat,wait.routineId)) return 'Choose an enabled owner-configured webhook routine belonging to this bot.'
    return
  }
  if (!jobs.length) return 'This brief has no admitted specialist assignments.'
  const selected = wait.kind === 'assignment' ? [wait.assignmentId] : wait.kind === 'first_match' ? wait.assignmentIds : []
  if (new Set(selected).size !== selected.length || selected.some(id => !jobs.some(job => job.id === id)))
    return 'Choose distinct assignment IDs from this brief.'
  if (wait.kind === 'first_match' && wait.remaining === 'cancel' &&
      selected.some(id => !jobs.some(job=>job.id===id && job.client_nonce==='faibots:assignment:'+id)))
    return 'Cancellation after a match is available only for selected background assignments.'
}

interface Resume {
  message: string
  cancel?: string[]
}

/** Only durable local receipts can satisfy a wait. Never interpret a reply as an instruction. */
export function evaluateWait(db: Db, row: Row, wait: WorkWait, jobs: Row[], now: number): Resume | undefined {
  const deadline = row.due_at === null ? undefined : Number(row.due_at)
  // Ignore receipts arriving after the deadline, including when evaluation resumes after a restart.
  const inTime = (at: unknown) => deadline === undefined || Number(at) <= deadline
  if (wait.kind === 'time') {
    if (deadline !== undefined && now >= deadline) return { message: 'The scheduled time arrived.' }
    return
  }
  if (wait.kind === 'webhook') {
    if (!ownsWebhook(db,str(row.conversation_id),wait.routineId)) return { message: 'The selected webhook is no longer available.' }
    if (row.signaled_at != null && inTime(row.signaled_at)) return { message: 'The selected routine received a webhook. Its work has a separate result.' }
  } else if (wait.kind === 'first_match') {
    const pool = jobs.filter(job => wait.assignmentIds.includes(str(job.id)))
    const winner = pool.filter(job => job.state === 'answered' && inTime(job.updated_at) &&
      parseJson<{text?:string}>(job.receipt,{}).text?.trim() === wait.expectedReply)
      .sort((a,b) => Number(a.updated_at)-Number(b.updated_at) || String(a.id).localeCompare(String(b.id)))[0]
    if (winner) return { message: `Assignment ${winner.id} returned the exact expected reply. Review its evidence before submitting work.`,
      cancel: wait.remaining === 'cancel' ? pool.filter(job => job.state === 'assigned').map(job=>str(job.id)) : [] }
    if (pool.length && pool.every(job => job.state !== 'assigned' && inTime(job.updated_at))) return { message:'Every selected assignment ended. None returned the expected reply.' }
  } else {
    const selected = wait.kind === 'assignment' ? jobs.filter(job=>job.id===wait.assignmentId) : jobs
    if (selected.length && selected.every(job=>job.state !== 'assigned' && inTime(job.updated_at))) {
      return {message: `Specialist returns: ${selected.map(job=>job.id+' '+job.state).join(', ')}. Read the receipts and review the result.`}
    }
  }
  if (deadline !== undefined && now >= deadline) return { message:'The deadline expired before the requested condition was met. Check outstanding work.' }
}
