// Routines and their run history. Scheduling lives in src/main/routines; this is storage only.

import { randomUUID } from 'node:crypto'
import type { Id, Routine, RoutineRun, RoutineSchedule } from '@shared/domain'
import type { RoutineRepo } from '../contracts'
import type { SQLOutputValue } from 'node:sqlite'
import { bool, num, optStr, parseJson, str, type Db, type Row } from './db'

/** Runs kept per routine; older ones are pruned when a new run starts. */
export const RUNS_KEPT_PER_ROUTINE = 100

const optNum = (v: SQLOutputValue | undefined) => (v === null || v === undefined ? undefined : num(v))

function toRoutine(r: Row): Routine {
  const lastRunAt = optNum(r['last_run_at'])
  const nextRunAt = optNum(r['next_run_at'])
  return {
    id: str(r['id']),
    botId: str(r['bot_id']),
    name: str(r['name']),
    prompt: str(r['prompt']),
    acceptance: parseJson(r['acceptance'], null),
    schedule: parseJson<RoutineSchedule>(r['schedule'], { kind: 'manual' }),
    enabled: bool(r['enabled']),
    webhookEnabled: bool(r['webhook_enabled']),
    hasWebhookToken: !!optStr(r['webhook_token_hash']),
    createdBy: str(r['created_by']) === 'bot' ? 'bot' : 'user',
    ...(lastRunAt !== undefined && { lastRunAt }),
    ...(nextRunAt !== undefined && { nextRunAt }),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

function toRun(r: Row): RoutineRun {
  const endedAt = optNum(r['ended_at'])
  const conversationId = optStr(r['conversation_id'])
  const entryId = optStr(r['entry_id'])
  const error = optStr(r['error'])
  return {
    id: str(r['id']),
    routineId: str(r['routine_id']),
    botId: str(r['bot_id']),
    trigger: str(r['trigger']) as RoutineRun['trigger'],
    status: str(r['status']) as RoutineRun['status'],
    startedAt: num(r['started_at']),
    ...(endedAt !== undefined && { endedAt }),
    ...(conversationId && { conversationId }),
    ...(entryId && { entryId }),
    summary: str(r['summary']),
    acceptance: parseJson<RoutineRun['acceptance']>(r['acceptance'], undefined) ?? { status: 'unverified', reason: 'No acceptance evidence was recorded.', checks: [] },
    ...(error && { error })
  }
}

export function createRoutineRepo(db: Db): RoutineRepo {
  const selectOne = db.prepare('select * from routines where id = ?')
  const get = (id: Id) => {
    const row = selectOne.get(id)
    return row ? toRoutine(row) : undefined
  }
  const getRun = (id: Id) => {
    const row = db.prepare('select * from routine_runs where id = ?').get(id)
    return row ? toRun(row) : undefined
  }

  const write = (r: Routine) => {
    db.prepare(
      `insert into routines (id, bot_id, name, prompt, schedule, enabled, webhook_enabled, created_by, last_run_at,
         next_run_at, created_at, updated_at, acceptance)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set name = excluded.name, prompt = excluded.prompt, schedule = excluded.schedule,
         enabled = excluded.enabled, webhook_enabled = excluded.webhook_enabled, last_run_at = excluded.last_run_at,
         next_run_at = excluded.next_run_at, updated_at = excluded.updated_at, acceptance = excluded.acceptance`
    ).run(
      r.id, r.botId, r.name, r.prompt, JSON.stringify(r.schedule), r.enabled ? 1 : 0, r.webhookEnabled ? 1 : 0,
      r.createdBy, r.lastRunAt ?? null, r.nextRunAt ?? null, r.createdAt, r.updatedAt, JSON.stringify(r.acceptance ?? null)
    )
  }

  return {
    list(botId?: Id) {
      const rows = botId
        ? db.prepare('select * from routines where bot_id = ? order by created_at, rowid').all(botId)
        : db.prepare('select * from routines order by created_at, rowid').all()
      return rows.map(toRoutine)
    },
    get,
    insert(input) {
      const now = Date.now()
      const routine: Routine = { ...input, id: input.id ?? randomUUID(), hasWebhookToken: false, createdAt: now, updatedAt: now }
      write(routine)
      return routine
    },
    update(id, patch) {
      const current = get(id)
      if (!current) throw new Error('Routine not found')
      const next: Routine = { ...current, ...patch, id, botId: current.botId, createdAt: current.createdAt, updatedAt: Date.now() }
      // Explicit undefined clears the planned run (disabled or manual routines have none).
      if ('nextRunAt' in patch && patch.nextRunAt === undefined) delete next.nextRunAt
      write(next)
      return next
    },
    delete(id) {
      db.prepare('delete from routines where id = ?').run(id)
    },
    webhookTokenHash(id) {
      return optStr(db.prepare('select webhook_token_hash from routines where id = ?').get(id)?.['webhook_token_hash'])
    },
    setWebhookTokenHash(id, hash) {
      db.prepare('update routines set webhook_token_hash = ?, updated_at = ? where id = ?').run(hash, Date.now(), id)
    },

    startRun(input) {
      const run: RoutineRun = { ...input, id: randomUUID(), summary: input.summary ?? '' }
      db.prepare(
        `insert into routine_runs (id, routine_id, bot_id, trigger, status, started_at, ended_at, conversation_id,
           entry_id, summary, error, acceptance)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        run.id, run.routineId, run.botId, run.trigger, run.status, run.startedAt, run.endedAt ?? null,
        run.conversationId ?? null, run.entryId ?? null, run.summary, run.error ?? null, JSON.stringify(run.acceptance ?? null)
      )
      db.prepare(
        `delete from routine_runs where routine_id = ? and id not in
           (select id from routine_runs where routine_id = ? order by started_at desc, rowid desc limit ?)`
      ).run(run.routineId, run.routineId, RUNS_KEPT_PER_ROUTINE)
      return run
    },
    finishRun(id, patch) {
      const current = getRun(id)
      if (!current) throw new Error('Run not found')
      const next: RoutineRun = { ...current, ...patch }
      db.prepare(
        `update routine_runs set status = ?, ended_at = ?, conversation_id = ?, entry_id = ?, summary = ?, error = ?, acceptance = ?
         where id = ?`
      ).run(next.status, next.endedAt ?? null, next.conversationId ?? null, next.entryId ?? null, next.summary, next.error ?? null, JSON.stringify(next.acceptance ?? null), id)
      return next
    },
    runs(filter) {
      const limit = Math.min(Math.max(filter.limit ?? 30, 1), RUNS_KEPT_PER_ROUTINE)
      const rows = filter.routineId
        ? db.prepare('select * from routine_runs where routine_id = ? order by started_at desc, rowid desc limit ?').all(filter.routineId, limit)
        : filter.botId
          ? db.prepare('select * from routine_runs where bot_id = ? order by started_at desc, rowid desc limit ?').all(filter.botId, limit)
          : db.prepare('select * from routine_runs order by started_at desc, rowid desc limit ?').all(limit)
      return rows.map(toRun)
    },
    /** Runs left 'running' by a crash or forced quit: nothing runs at startup, so close them. */
    closeInterruptedRuns(now) {
      const pending = db.prepare("select * from routine_runs where status = 'running'").all()
      for (const row of pending) {
        const evidence = toRun(row).acceptance!
        db.prepare('update routine_runs set acceptance = ? where id = ?').run(JSON.stringify({ ...evidence,
          status: 'unverified', checkedAt: now, reason: 'Execution was interrupted; acceptance was not established.',
          checks: evidence.checks.map((check) => ({ ...check, status: 'unverified' })) }), str(row.id))
      }
      return Number(
        db.prepare(`update routine_runs set status = 'cancelled', ended_at = ?, error = 'FaiBots closed during the run' where status = 'running'`)
          .run(now).changes
      )
    }
  }
}
