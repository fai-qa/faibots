import type { ProjectInstruction } from '@shared/project-improvements'
import { type Db, str } from './db'
import { activeProjectInstruction } from './project-improvements'

/** Called within request admission. A null candidate preserves the original default. */
export function pinChatInstruction(db: Db, entryId: string, projectId: string): void {
  const active = activeProjectInstruction(db, projectId)
  db.prepare('insert into project_request_instructions(entry_id, project_id, candidate_id) values (?,?,?)')
    .run(entryId, projectId, active?.id ?? null)
}

/** A reply keeps its original checks, including no check for jobs that predate this migration. */
export function inheritChatInstruction(db: Db, entryId: string, origin: string): void {
  db.prepare(`insert into project_request_instructions(entry_id, project_id, candidate_id)
    select ?, project_id, candidate_id from project_request_instructions where entry_id=?`).run(entryId, origin)
}

/** Read only after rechecking the specific request and project grants. No current-version fallback. */
export function pinnedChatInstruction(db: Db, entryId: string, projectId: string): ProjectInstruction | undefined {
  const row = db.prepare(`select c.id,c.version,c.instruction,c.required_text
    from project_request_instructions p join improvement_candidates c on c.id=p.candidate_id and c.project_id=p.project_id
    where p.entry_id=? and p.project_id=?`).get(entryId, projectId)
  return row && { id: str(row.id), version: Number(row.version), instruction: str(row.instruction), requiredText: str(row.required_text) }
}
