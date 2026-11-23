import { randomUUID } from 'node:crypto'
import type { ArtifactRevision, JourneyRun } from '@shared/domain'
import type { ImprovementCandidate, ImprovementTrial, Improvements, ProjectInstruction, TrialCase } from '@shared/project-improvements'
import type { PlatformStore } from './index'
import { type Db, type Row, str, transaction } from './db'

function instruction(row: Row): ProjectInstruction {
  return { id: str(row.id), version: Number(row.version), instruction: str(row.instruction), requiredText: str(row.required_text) }
}
export function activeProjectInstruction(db: Db, projectId: string): ProjectInstruction | undefined {
  const row = db.prepare(`select c.* from improvement_candidates c where c.project_id=? and c.id=(
    select after_id from improvement_history where project_id=? order by seq desc limit 1)`).get(projectId, projectId)
  return row && instruction(row)
}

export function createProjectImprovements(store: PlatformStore, readRevision: (projectId: string, revision: ArtifactRevision) => string) {
  const { db } = store
  const get = (projectId: string, id: string): ImprovementCandidate => {
    const row = db.prepare('select * from improvement_candidates where project_id=? and id=?').get(projectId, id)
    if (!row) throw new Error('Correction not found in this project.')
    return { ...instruction(row), decision: str(row.decision) as ImprovementCandidate['decision'],
      matched: str(row.matched), heldout: str(row.heldout), base: row.base ? str(row.base) : null }
  }
  function checkedRun(projectId: string, runId: string) {
    const run = store.journeyRuns.get(runId)
    if (!run || run.projectId !== projectId || run.status !== 'complete' || !run.artifactId) throw new Error('This case needs a completed, reviewed run in the same project.')
    const revision = store.artifacts.revisions(run.artifactId).sort((a,b) => b.revisionNo - a.revisionNo)[0]
    const context = db.prepare('select rubric,sources from project_context where run_id=?').get(runId)
    if (!revision || !context) throw new Error('The case has no pinned revision and rubric.')
    const review = db.prepare('select decision,rubric from review_decisions where artifact_revision_id=? order by created_at desc,rowid desc limit 1').get(revision.id)
    if (review?.decision !== 'accepted' || review.rubric !== context.rubric) throw new Error('The case must pass the independent review against its pinned rubric.')
    return { body: readRevision(projectId, revision), sha256: revision.sha256, context }
  }
  function cases(projectId: string, matched: string, heldout: string, required: string) {
    if (matched === heldout) throw new Error('Choose two different reviewed runs.')
    for (const id of [matched, heldout]) {
      if (!db.prepare('select 1 from space_pages where run_id=?').get(id)) throw new Error('Choose previously reviewed project Pages as the two baseline cases.')
    }
    const original = checkedRun(projectId, matched)
    const unseen = checkedRun(projectId, heldout)
    const pins = (id: string) => store.projectContent.pins(projectId, id).map((pin) => pin.sha256)
    const known = new Set(pins(matched))
    const held = pins(heldout)
    if (!known.size || !held.length || held.some((sha) => known.has(sha)) || original.context.rubric !== unseen.context.rubric) {
      throw new Error('The held-out case needs different source notes and the same rubric.')
    }
    if (original.body.includes(required)) throw new Error('The matched baseline already passes this check. Choose a case that demonstrates the correction.')
  }
  function inspectTrial(projectId: string, candidate: ImprovementCandidate, lane: TrialCase, trialId: string) {
    const baseline = checkedRun(projectId, candidate[lane])
    const trial = checkedRun(projectId, trialId)
    if (baseline.context.rubric !== trial.context.rubric || baseline.context.sources !== trial.context.sources) throw new Error('The trial used different notes or rubric from its assigned case.')
    if (!trial.body.includes(candidate.requiredText)) throw new Error('The reviewed trial output does not contain the required text.')
    return trial.sha256
  }
  function overview(projectId: string): Improvements {
    if (!store.projects.get(projectId)) throw new Error('Project not found.')
    const candidates = db.prepare('select id from improvement_candidates where project_id=? order by version desc').all(projectId).map((row) => get(projectId, str(row.id)))
    const trials = db.prepare(`select i.*,r.status from improvement_runs i join journey_runs r on r.id=i.run_id
      where r.project_id=? and i.lane!='production' order by i.created_at desc,i.rowid desc`).all(projectId).map((row): ImprovementTrial => ({
      runId: str(row.run_id), candidateId: str(row.candidate_id), lane: str(row.lane) as TrialCase, baselineId: str(row.baseline_id),
      status: str(row.status), observed: str(row.observed) as ImprovementTrial['observed'], reason: str(row.reason), sha256: row.sha256 ? str(row.sha256) : null
    }))
    const history = db.prepare(`select h.action,h.created_at,c.version from improvement_history h left join improvement_candidates c on c.id=h.after_id
      where h.project_id=? order by h.seq desc`).all(projectId).map((row) => ({ action: str(row.action), at: Number(row.created_at), version: row.version ? Number(row.version) : null }))
    const production = db.prepare(`select i.run_id,i.observed,i.reason,c.version from improvement_runs i join improvement_candidates c on c.id=i.candidate_id
      where c.project_id=? and i.lane='production' order by i.created_at desc,i.rowid desc limit 10`).all(projectId).map((r) =>
      ({ runId:str(r.run_id), version:Number(r.version), observed:str(r.observed), reason:str(r.reason) }))
    return { active: activeProjectInstruction(db,projectId) ?? null, cases: store.projectContent.pages(projectId).map((page) =>
      ({ runId: page.runId, name: page.name + ' · ' + page.runId.slice(0,8) })), candidates, trials, history, production }
  }
  return {
    overview, get,
    propose(projectId: string, change: string, literal: string, matched: string, heldout: string) {
      const note = change.trim(), required = literal.trim()
      if (note.length < 3 || note.length > 2000 || !required || required.length > 400) throw new Error('Enter the project instruction (3–2000 characters) and required output text (up to 400 characters).')
      return transaction(db, () => {
        cases(projectId,matched,heldout,required)
        const id = randomUUID()
        const next = Number(db.prepare('select coalesce(max(version),0)+1 n from improvement_candidates where project_id=?').get(projectId)!.n)
        db.prepare(`insert into improvement_candidates(id,project_id,version,instruction,required_text,matched,heldout,base,decision,created_at)
          values(?,?,?,?,?,?,?,?,'proposed',?)`).run(id,projectId,next,note,required,matched,heldout,activeProjectInstruction(db,projectId)?.id ?? null,Date.now())
        return id
      })
    },
    review(projectId: string, id: string, decision: 'approved' | 'rejected') {
      if (!['approved','rejected'].includes(decision)) throw new Error('Choose approve or reject.')
      const changed = db.prepare("update improvement_candidates set decision=?,reviewed_at=? where id=? and project_id=? and decision='proposed'").run(decision,Date.now(),id,projectId)
      if (changed.changes !== 1) throw new Error('Only a proposed correction in this project can be reviewed.')
    },
    pin(run: JourneyRun, baselineId?: string, trialCandidateId?: string): ProjectInstruction | undefined {
      const candidate = trialCandidateId ? get(run.projectId,trialCandidateId) : undefined
      if (candidate && (candidate.decision !== 'approved' || !baselineId || ![candidate.matched,candidate.heldout].includes(baselineId))) {
        throw new Error('Approve the correction and choose one of its pinned trial cases first.')
      }
      let pinned: ProjectInstruction | undefined
      if (candidate) {
        pinned = candidate
      } else if (baselineId) {
        const original = db.prepare(`select i.candidate_id from journey_runs r
          left join improvement_runs i on i.run_id=r.id where r.project_id=? and r.id=?`).get(run.projectId, baselineId)
        if (!original) throw new Error('Evaluation case not found in this project.')
        // Absence is the original default, including runs created before project instructions existed.
        if (original.candidate_id) pinned = get(run.projectId, str(original.candidate_id))
      } else {
        pinned = activeProjectInstruction(db,run.projectId)
      }
      if (pinned) db.prepare(`insert into improvement_runs values (?,?,?,?, 'pending','',null,?)`).run(
        run.id,pinned.id,candidate ? candidate.matched === baselineId ? 'matched' : 'heldout' : 'production',candidate ? baselineId! : null,Date.now())
      return pinned
    },
    isTrial(runId: string) { return !!db.prepare("select 1 from improvement_runs where run_id=? and lane!='production'").get(runId) },
    observe(run: JourneyRun) {
      const pin = db.prepare('select candidate_id,lane from improvement_runs where run_id=?').get(run.id)
      if (!pin || !run.endedAt) return
      let sha: string | null = null, reason = ''
      try {
        const candidate = get(run.projectId,str(pin.candidate_id))
        if (pin.lane === 'production') {
          const result = checkedRun(run.projectId,run.id)
          if (!result.body.includes(candidate.requiredText)) throw new Error('The published instruction check failed.')
          sha = result.sha256
        } else sha = inspectTrial(run.projectId,candidate,str(pin.lane) as TrialCase,run.id)
        reason = 'Independent review accepted the revision. The verified output contains the required text.'
      } catch (err) { reason = run.error || (err instanceof Error ? err.message : String(err)) }
      db.prepare('update improvement_runs set observed=?,reason=?,sha256=? where run_id=?').run(sha ? 'passed' : 'failed',reason,sha,run.id)
    },
    publish(projectId: string,id: string) {
      transaction(db, () => {
        const c = get(projectId,id)
        const before = activeProjectInstruction(db,projectId)?.id ?? null
        if (before === id) return
        if (c.decision !== 'approved' || before !== c.base) throw new Error('This correction needs review against the currently active version.')
        cases(projectId,c.matched,c.heldout,c.requiredText)
        for (const lane of ['matched','heldout'] as const) {
          const trial = db.prepare('select * from improvement_runs where candidate_id=? and lane=? order by created_at desc,rowid desc limit 1').get(id,lane)
          if (trial?.observed !== 'passed' || inspectTrial(projectId,c,lane,str(trial.run_id)) !== trial.sha256) throw new Error('A passing, verified ' + lane + ' trial is required.')
        }
        db.prepare("insert into improvement_history(project_id,before_id,after_id,action,created_at) values(?,?,?,'publish',?)").run(projectId,before,id,Date.now())
      })
    },
    rollback(projectId: string,id: string) {
      transaction(db, () => {
        if (activeProjectInstruction(db,projectId)?.id !== id) throw new Error('Only the currently active project version may be rolled back.')
        const publication = db.prepare("select before_id from improvement_history where project_id=? and after_id=? and action='publish' order by seq desc limit 1").get(projectId,id)
        if (!publication) throw new Error('This version has no publication history.')
        db.prepare("insert into improvement_history(project_id,before_id,after_id,action,created_at) values(?,?,?,'rollback',?)").run(projectId,id,publication.before_id ?? null,Date.now())
      })
    }
  }
}
