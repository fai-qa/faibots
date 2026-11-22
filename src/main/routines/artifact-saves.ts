// Keep the delivery receipt in SQLite before writing its immutable snapshot. A restart can
// finish linking the same bytes to the same project without asking a model to draft again.
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ArtifactProvenance, ArtifactRevision, JourneyRun } from '@shared/domain'
import type { PlatformStore } from '../store'
import { parseJson, str, transaction } from '../store/db'
import { observeFile } from './acceptance'

const filename = 'proposal.md'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export function artifactSaves(store: PlatformStore, dataDir: string) {
  const db = store.db
  function intent(run: JourneyRun, root: string, provenance: ArtifactProvenance) {
    if (!run.artifactId || provenance.projectId !== run.projectId) throw Error('The draft has no matching project destination.')
    db.prepare(`insert into artifact_saves(run_id,artifact_id,project_id,pinned_root,provenance,state)
      values(?,?,?,?,?,'expected')`).run(run.id,run.artifactId,run.projectId,root,JSON.stringify(provenance))
  }

  function capture(runId: string, bytes: Buffer, sha: string) {
    if (!bytes.length || bytes.length > 1024 * 1024 || digest(bytes) !== sha) throw Error('The draft bytes do not match the observed file.')
    const saved = db.prepare("update artifact_saves set sha256=?,body=?,state='captured' where run_id=? and state='expected'").run(sha,bytes,runId)
    if (!saved.changes) {
      const old = db.prepare('select sha256 from artifact_saves where run_id=?').get(runId)
      if (old?.sha256 !== sha) throw Error('Another draft is recorded for this run.')
    }
  }

  function link(runId: string): ArtifactRevision {
    const row = db.prepare(`select s.* from artifact_saves s join journey_runs r on r.id=s.run_id and r.artifact_id=s.artifact_id and r.project_id=s.project_id
      join artifacts a on a.id=s.artifact_id and a.project_id=s.project_id where s.run_id=?`).get(runId)
    if (!row) throw Error('The original draft destination is unavailable.')
    const artifactId = str(row.artifact_id)
    if (row.state === 'linked') {
      const existing = store.artifacts.revisions(artifactId).find(rev => rev.id === row.revision_id)
      if (!existing) throw Error('The recorded draft revision is unavailable.')
      return existing
    }
    if (row.state !== 'captured' || !(row.body instanceof Uint8Array)) throw Error('The draft has no verified capture.')
    const bytes = Buffer.from(row.body)
    const sha = str(row.sha256)
    if (digest(bytes) !== sha) throw Error('The captured draft no longer matches its receipt.')
    const parent = realpathSync(dataDir)
    const base = join(parent,'artifact-revisions')
    mkdirSync(base,{recursive:true})
    if (realpathSync(base) !== resolve(base)) throw Error('The draft snapshot directory changed.')
    const path = join(base,runId)
    mkdirSync(path,{recursive:true})
    if (realpathSync(path) !== resolve(path)) throw Error('The draft snapshot directory changed.')
    // If a previous write stopped halfway, keep that file and write the verified bytes to their hash-addressed path.
    const snapshotName = [filename,sha+'.md'].find(name => {
      try { writeFileSync(join(path,name),bytes,{flag:'wx'}) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      const saved = observeFile(path,name,path)
      return saved.kind === 'ok' && saved.sha256 === sha
    })
    if (!snapshotName) throw Error('The saved files differ from the receipt. The original files have been preserved.')
    return transaction(db,() => {
      const again = db.prepare('select revision_id from artifact_saves where run_id=?').get(runId)
      if (again?.revision_id) return store.artifacts.revisions(artifactId).find(rev=>rev.id===again.revision_id)!
      const provenance = parseJson<ArtifactProvenance>(row.provenance,{})
      if (provenance.projectId !== row.project_id) throw Error('The original draft project changed.')
      const revision = store.artifacts.createRevision({artifactId,sha256:sha,provenance:{...provenance,file:{workspace:path,path:snapshotName}}})
      db.prepare("update artifact_saves set state='linked',revision_id=?,body=null where run_id=?").run(revision.id,runId)
      return revision
    })
  }

  function recover(at: number) {
    const pending = db.prepare(`select s.run_id,s.pinned_root,s.state from artifact_saves s join journey_runs r on r.id=s.run_id
      where s.state in ('expected','captured') or (s.state='linked' and r.status in ('working','waiting_review'))`).all()
    for (const row of pending) {
      const id = str(row.run_id)
      try {
        const run = store.journeyRuns.get(id)
        if (!run) continue
        for (const pin of store.projectContent.pins(run.projectId,id)) store.projectContent.check(run.projectId,pin)
        if (row.state === 'expected') {
          const root = str(row.pinned_root)
          const observation = observeFile(root,`mission-${id}/${filename}`,root)
          if (observation.kind !== 'ok' || !observation.data.toString('utf8').trim()) {
            db.prepare("update artifact_saves set state='unavailable' where run_id=? and state='expected'").run(id)
            continue
          }
          capture(id,observation.data,observation.sha256)
        }
        transaction(db,() => {
          const revision = link(id)
          const updated = store.journeyRuns.finish(id,{status:'partial',endedAt:at,error:'Draft recovered after an interrupted save. Review the saved revision before using it.'})
          store.projectContent.recordOutcome(updated)
          return revision
        })
      } catch (error) {
        // The bytes and intent remain available on retry. A failed recovery never marks the draft reviewed.
        console.warn('[artifacts] Could not reconcile draft',id,error instanceof Error ? error.message : 'unknown')
      }
    }
  }
  return { intent,capture,link,recover }
}
