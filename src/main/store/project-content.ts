import { randomUUID } from 'node:crypto'
import type { ArtifactRevision, Id, JourneyRun, ProjectSource, ReviewDecision } from '@shared/domain'
import type { LibrarySource, ProjectContent, ProjectEvaluation, SpacePage } from '@shared/project-content'
import { num, str, transaction, type Db } from './db'
import type { ProjectSourceRepo } from './projects'

interface PinnedSource {
  sourceId: Id
  itemId: Id
  revision: number
  sha256: string
}
const LIBRARY = `select i.id item_id, i.owner_id, r.source_id, r.revision, g.selected,
  (not g.revoked and not owner.revoked) readable
  from library_access g join library_items i on i.id=g.item_id
  join library_access owner on owner.item_id=i.id and owner.project_id=i.owner_id
  join library_revisions r on r.item_id=i.id where g.project_id=?`
const PAGES = `select p.*, c.space_id, a.name, v.sha256, d.reviewer from space_pages p
  join project_context c on c.run_id=p.run_id join project_spaces s on s.id=c.space_id
  join artifact_revisions v on v.id=p.revision_id join artifacts a on a.id=v.artifact_id
  join review_decisions d on d.id=p.review_id where s.project_id=?`

export function linkLibraryRevision(db: Db, source: ProjectSource, existingItem?: Id) {
  const itemId = existingItem ?? source.id
  if (existingItem) {
    const writable = db
      .prepare(
        'select 1 from library_items i join library_access g on g.item_id=i.id and g.project_id=i.owner_id where i.id=? and i.owner_id=? and g.revoked=0'
      )
      .get(itemId, source.projectId)
    if (!writable) throw new Error('Only the owning project can revise an accessible Library item.')
  } else {
    db.prepare('insert into library_items values (?,?)').run(itemId, source.projectId)
    db.prepare('insert into library_access values (?,?,1,0)').run(source.projectId, itemId)
  }
  db.prepare(
    'insert into library_revisions select ?,coalesce(max(revision),0)+1,? from library_revisions where item_id=?'
  ).run(itemId, source.id, itemId)
}

export function createProjectContentRepo(db: Db, sources: ProjectSourceRepo) {
  const space = (projectId: Id) => {
    const row = db.prepare('select id,name from project_spaces where project_id=?').get(projectId)
    if (!row) throw new Error('Project space not found.')
    return { id: str(row.id), name: str(row.name) }
  }
  const library = (projectId: Id): LibrarySource[] =>
    db
      .prepare(
        LIBRARY +
          ` and (i.owner_id=g.project_id or (g.revoked=0 and owner.revoked=0)) and r.revision=(select max(revision) from library_revisions where item_id=i.id) order by i.rowid`
      )
      .all(projectId)
      .map((row) => ({
        itemId: str(row.item_id),
        ownerProjectId: str(row.owner_id),
        revision: num(row.revision),
        selected: !!row.selected,
        readable: !!row.readable,
        sharedWith:
          row.owner_id !== projectId
            ? []
            : db
                .prepare('select project_id from library_access where item_id=? and project_id<>? and revoked=0')
                .all(row.item_id!, projectId)
                .map((grant) => str(grant.project_id)),
        source: sources.get(str(row.source_id))!,
        versions: db
          .prepare(
            `select r.source_id,r.revision,s.name,s.sha256 from library_revisions r
      join project_sources s on s.id=r.source_id where r.item_id=? order by r.revision desc`
          )
          .all(row.item_id!)
          .map((v) => ({
            sourceId: str(v.source_id),
            revision: num(v.revision),
            name: str(v.name),
            sha256: str(v.sha256)
          }))
      }))
  const pin = (projectId: Id, sourceId: Id): PinnedSource => {
    const row = db.prepare(LIBRARY + ' and r.source_id=? and g.revoked=0 and owner.revoked=0').get(projectId, sourceId)
    const source = row && sources.get(sourceId)
    if (!row || !source) throw new Error('The project no longer has access to a selected source.')
    return { sourceId, itemId: str(row.item_id), revision: num(row.revision), sha256: source.sha256 }
  }
  const pins = (projectId: Id, runId: Id): PinnedSource[] => {
    const row = db
      .prepare(
        'select c.sources from project_context c join project_spaces s on s.id=c.space_id where c.run_id=? and s.project_id=?'
      )
      .get(runId, projectId)
    if (!row) throw new Error('No context manifest for this project and run.')
    return JSON.parse(str(row.sources)) as PinnedSource[]
  }
  const check = (projectId: Id, pinned: PinnedSource) => {
    const current = pin(projectId, pinned.sourceId)
    if (current.itemId !== pinned.itemId || current.revision !== pinned.revision || current.sha256 !== pinned.sha256)
      throw new Error('A pinned source revision has changed.')
    return sources.get(current.sourceId)!
  }
  const pages = (projectId: Id): SpacePage[] =>
    db
      .prepare(PAGES + ' order by p.created_at desc,p.rowid desc')
      .all(projectId)
      .map((r) => ({
        id: str(r.id),
        spaceId: str(r.space_id),
        name: str(r.name),
        runId: str(r.run_id),
        revisionId: str(r.revision_id),
        sha256: str(r.sha256),
        reviewer: str(r.reviewer),
        createdAt: num(r.created_at)
      }))
  const readableReview = (projectId: Id, runId: Id, reason: string) => {
    try {
      for (const pinned of pins(projectId, runId)) check(projectId, pinned)
      return reason
    } catch {
      return 'A source used in this review is no longer accessible.'
    }
  }
  const evaluations = (projectId: Id): ProjectEvaluation[] =>
    db
      .prepare(
        `select e.*,c.rubric,t.candidate_id,t.outcome,t.integrity,t.contract,t.reason report_reason,t.created_at reported
    from project_evaluations e join project_context c on c.run_id=e.run_id join project_spaces s on s.id=c.space_id
    left join evaluation_trials t on t.id=(select max(id) from evaluation_trials where run_id=e.run_id)
    where s.project_id=? order by e.created_at desc,e.rowid desc`
      )
      .all(projectId)
      .map((r) => ({
        runId: str(r.run_id),
        status: str(r.observed),
        reason: readableReview(projectId, str(r.run_id), str(r.reason)),
        rubric: str(r.rubric),
        turns: num(r.turns),
        ...(r.revision_id && { revisionId: str(r.revision_id) }),
        ...(r.reviewer && { reviewer: str(r.reviewer) }),
        ...(r.outcome && {
          report: {
            candidateId: str(r.candidate_id),
            status: str(r.outcome) as 'passed' | 'failed',
            integrity: str(r.integrity) as 'verified' | 'unavailable' | 'unknown',
            contract: str(r.contract) as 'accepted' | 'unmet',
            reason: readableReview(projectId, str(r.candidate_id), str(r.report_reason)),
            at: num(r.reported)
          }
        })
      }))
  return {
    space,
    library,
    pin,
    pins,
    check,
    pages,
    evaluations,
    overview(projectId: Id): ProjectContent {
      return {
        space: space(projectId),
        library: library(projectId),
        pages: pages(projectId),
        evaluations: evaluations(projectId)
      }
    },
    select(projectId: Id, itemId: Id, selected: boolean) {
      if (typeof selected !== 'boolean') throw new Error('Choose whether to use this source.')
      const item = library(projectId).find((i) => i.itemId === itemId)
      if (!item?.readable) throw new Error('This source is unavailable in the project.')
      db.prepare('update library_access set selected=? where project_id=? and item_id=?').run(
        Number(selected),
        projectId,
        itemId
      )
    },
    share(ownerId: Id, itemId: Id, targetId: Id) {
      const item = library(ownerId).find((i) => i.itemId === itemId && i.ownerProjectId === ownerId && i.readable)
      if (!item || targetId === ownerId) throw new Error('Choose an owned source and a different destination project.')
      space(targetId)
      db.prepare(
        `insert into library_access values (?,?,0,0) on conflict(project_id,item_id)
        do update set revoked=0, selected=case when revoked=1 then 0 else selected end`
      ).run(targetId, itemId)
    },
    restore(projectId: Id, itemId: Id) {
      const granted = db
        .prepare(
          `update library_access set revoked=0 where project_id=? and item_id=?
        and exists (select 1 from library_items where id=? and owner_id=?)`
        )
        .run(projectId, itemId, itemId, projectId)
      if (!granted.changes) throw new Error('Only the owner can restore this source.')
    },
    revoke(projectId: Id, itemId: Id, targetProjectId = projectId) {
      const owned = db.prepare('select 1 from library_items where id=? and owner_id=?').get(itemId, projectId)
      if (targetProjectId !== projectId && !owned) throw new Error('Only the owner can revoke another project’s grant.')
      if (owned && targetProjectId === projectId) {
        db.prepare('update library_access set revoked=1,selected=0 where item_id=?').run(itemId)
        return
      }
      if (
        !db
          .prepare('update library_access set revoked=1,selected=0 where project_id=? and item_id=?')
          .run(targetProjectId, itemId).changes
      )
        throw new Error('No source grant for this project.')
    },
    recordContext(run: JourneyRun, selected: ProjectSource[], rubric: string, baselineRunId?: Id) {
      const manifest = selected.map((s) => pin(run.projectId, s.id))
      db.prepare('insert into project_context values (?,?,?,?,?)').run(
        run.id,
        space(run.projectId).id,
        rubric,
        JSON.stringify(manifest),
        baselineRunId ?? null
      )
      return manifest
    },
    publish(run: JourneyRun, revision: ArtifactRevision, review: ReviewDecision) {
      for (const source of pins(run.projectId, run.id)) check(run.projectId, source)
      const rubric = db.prepare('select rubric from project_context where run_id=?').get(run.id)?.rubric
      if (
        review.rubric !== rubric ||
        review.decision !== 'accepted' ||
        review.artifactRevisionId !== revision.id ||
        revision.artifactId !== run.artifactId
      )
        throw new Error('A Page needs a reviewed revision from this run.')
      db.prepare('insert into space_pages values (?,?,?,?,?) on conflict(run_id) do nothing').run(
        randomUUID(),
        run.id,
        revision.id,
        review.id,
        Date.now()
      )
    },
    recordTurn(runId: Id, turnId: Id | undefined, phase: string) {
      if (turnId) db.prepare('insert or ignore into project_run_turns values (?,?,?)').run(runId, turnId, phase)
    },
    recordOutcome(run: JourneyRun) {
      if (run.endedAt === undefined || !db.prepare('select 1 from project_context where run_id=?').get(run.id)) return
      const row = db
        .prepare(
          `select v.id,d.reviewer,d.explanation from artifact_revisions v
        left join review_decisions d on d.artifact_revision_id=v.id where v.artifact_id=?
        order by v.revision_no desc,d.created_at desc limit 1`
        )
        .get(run.artifactId ?? '')
      const recorded = db
        .prepare('insert into project_evaluations values (?,?,?,?,?,?,?) on conflict(run_id) do nothing')
        .run(
          run.id,
          run.status,
          run.error ?? String(row?.explanation ?? 'Completed'),
          row?.id ?? null,
          row?.reviewer ?? null,
          num(
            db
              .prepare('select count(*) n from project_run_turns t join turns on turns.id=t.turn_id where t.run_id=?')
              .get(run.id)?.n
          ),
          run.endedAt
        )
      const baseline = db.prepare('select baseline_run_id from project_context where run_id=?').get(run.id)?.baseline_run_id
      if (baseline && recorded.changes) {
        const published = run.status === 'complete' && !!db.prepare('select 1 from space_pages where run_id=?').get(run.id)
        db.prepare(
          'insert into evaluation_trials(run_id,candidate_id,outcome,reason,created_at,integrity,contract) values (?,?,?,?,?,?,?)'
        ).run(
          baseline,
          run.id,
          published ? 'passed' : 'failed',
          run.error ?? String(row?.explanation ?? 'Review completed.'),
          run.endedAt,
          published ? 'verified' : 'unknown',
          published ? 'accepted' : 'unmet'
        )
      }
    },
    reevaluate(projectId: Id, runId: Id, verify: (candidateId: Id) => void) {
      return transaction(db, () => {
        const original = evaluations(projectId).find((e) => e.runId === runId)
        if (!original) throw new Error('No evaluation for this project and run.')
        // Compare only a later reviewed run with exactly the same pinned inputs and rubric.
        const matched = db
          .prepare(
            `select trial.run_id from project_context baseline join project_context trial
          on trial.space_id=baseline.space_id and trial.sources=baseline.sources and trial.rubric=baseline.rubric
          join journey_runs r on r.id=trial.run_id join journey_runs b on b.id=baseline.run_id
          where baseline.run_id=? and r.status='complete' and r.started_at>=b.started_at order by r.started_at desc,r.rowid desc limit 1`
          )
          .get(runId)
        const candidateId = matched ? str(matched.run_id) : runId
        let outcome = 'passed',
          reason = 'Verified the accepted review, the pinned inputs and the published revision.'
        try {
          if (!matched) throw new Error('No accepted review for these inputs and rubric. ' + original.reason)
          verify(candidateId)
        } catch (error) {
          outcome = 'failed'
          reason = error instanceof Error ? error.message : String(error)
        }
        db.prepare(
          'insert into evaluation_trials(run_id,candidate_id,outcome,reason,created_at,integrity,contract) values (?,?,?,?,?,?,?)'
        ).run(
          runId,
          candidateId,
          outcome,
          reason,
          Date.now(),
          !matched ? 'unknown' : outcome === 'passed' ? 'verified' : 'unavailable',
          matched ? 'accepted' : 'unmet'
        )
        return evaluations(projectId).find((e) => e.runId === runId)!
      })
    }
  }
}
