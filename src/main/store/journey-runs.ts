// Mission run rows (first journey, migration 7): one row per start-mission run, with the
// honest state it reached and the B1-B11 budgets computed when it ended. Budgets are stored
// as JSON because their keys only appear once measured (first-journey.md FJ-10).

import { randomUUID } from 'node:crypto'
import type { Id, JourneyRun, JourneyRunBudgets, JourneyRunStatus } from '@shared/domain'
import { num, parseJson, str, type Db, type Row } from './db'

export const RUNNING_STATUSES: readonly JourneyRunStatus[] = ['working', 'waiting_review']

export interface JourneyRunRepo {
  start(input: { projectId: Id; artifactId?: Id; status: JourneyRunStatus; budgets?: JourneyRunBudgets; startedAt: number }): JourneyRun
  finish(id: Id, patch: { status?: JourneyRunStatus; error?: string; budgets?: JourneyRunBudgets; artifactId?: Id; endedAt?: number }): JourneyRun
  get(id: Id): JourneyRun | undefined
  /** Newest first. */
  listByProject(projectId: Id, limit?: number): JourneyRun[]
  /**
   * After a crash or forced quit, runs still marked working/waiting_review are unknown, not
   * success: close them as failed (A20). Called once at startup.
   */
  closeInterrupted(now: number): number
}

const toRun = (r: Row): JourneyRun => ({
  id: str(r['id']),
  projectId: str(r['project_id']),
  ...(r['artifact_id'] != null && { artifactId: str(r['artifact_id']) }),
  status: str(r['status']) as JourneyRunStatus,
  ...(r['error'] != null && { error: str(r['error']) }),
  budgets: parseJson<JourneyRunBudgets>(r['budgets'], {}),
  startedAt: num(r['started_at']),
  ...(r['ended_at'] != null && { endedAt: num(r['ended_at']) })
})

export function createJourneyRunRepo(db: Db): JourneyRunRepo {
  const legacyCodex = db.prepare(`select 1 from project_run_turns r join turns t on t.id=r.turn_id
    join providers p on p.id=t.provider_id where r.run_id=? and p.kind='codex' and t.codex_usage_state is null limit 1`)
  const decode = (row: Row) => {
    const run = toRun(row)
    if (run.budgets.b3 && legacyCodex.get(run.id)) run.budgets.b3.legacyCodex = true
    return run
  }
  const get = (id: Id) => {
    const row = db.prepare('select * from journey_runs where id = ?').get(id)
    return row ? decode(row) : undefined
  }
  return {
    start(input) {
      const run: JourneyRun = {
        id: randomUUID(),
        projectId: input.projectId,
        ...(input.artifactId && { artifactId: input.artifactId }),
        status: input.status,
        budgets: input.budgets ?? {},
        startedAt: input.startedAt
      }
      db.prepare(`insert into journey_runs (id, project_id, artifact_id, status, budgets, started_at)
        values (?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.projectId, run.artifactId ?? null, run.status, JSON.stringify(run.budgets), run.startedAt)
      return run
    },
    finish(id, patch) {
      const current = get(id)
      if (!current) throw new Error('Mission run not found')
      const artifactId = patch.artifactId !== undefined ? patch.artifactId : current.artifactId
      const error = patch.error !== undefined ? patch.error : current.error
      const next: JourneyRun = {
        ...current,
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.artifactId !== undefined && { artifactId: patch.artifactId }),
        ...(patch.error !== undefined && { error: patch.error }),
        ...(patch.budgets !== undefined && { budgets: patch.budgets }),
        ...(patch.endedAt !== undefined && { endedAt: patch.endedAt })
      }
      db.prepare('update journey_runs set artifact_id = ?, status = ?, error = ?, budgets = ?, ended_at = ? where id = ?')
        .run(artifactId ?? null, next.status, error ?? null, JSON.stringify(next.budgets), next.endedAt ?? null, id)
      return next
    },
    get,
    listByProject(projectId, limit = 30) {
      const rows = db.prepare('select * from journey_runs where project_id = ? order by started_at desc, rowid desc limit ?')
        .all(projectId, Math.max(1, Math.min(Math.round(limit), 100)))
      return rows.map(decode)
    },
    closeInterrupted(now) {
      return Number(db.prepare(`update journey_runs set status = 'failed', error = 'Interrupted: faibots stopped before the run finished.', ended_at = ? where status in ('working', 'waiting_review')`)
        .run(now).changes)
    }
  }
}
