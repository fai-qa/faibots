import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type PlatformStore } from '../store'
import { pinWorkspace } from './acceptance'
import { artifactSaves } from './artifact-saves'

describe('interrupted artifact association', () => {
  let dir: string
  let store: PlatformStore
  beforeEach(() => {
    dir=mkdtempSync(join(tmpdir(),'faibots-artifact-save-'))
    store=openStore(join(dir,'test.db'),{homeDir:dir})
  })
  afterEach(() => { store.close(); rmSync(dir,{recursive:true,force:true,maxRetries:5}) })

  it.each(['workspace-written','bytes-captured','file-written','revision-inserted','already-linked'])(
    'recovers after %s exactly once, preserving the original project, content and review state', (boundary) => {
      const {id: projectId}=store.projects.create({name:'Pickup'})
      const artifact=store.artifacts.create({projectId,name:'Pickup draft',kind:'proposal'})
      const run=store.journeyRuns.start({projectId,artifactId:artifact.id,status:'working',startedAt:1})
      store.projectContent.recordContext(run,[],'Gate is stated.')
      const workspace=join(dir,'workspace')
      const task=join(workspace,'mission-'+run.id)
      mkdirSync(task,{recursive:true})
      const saves=artifactSaves(store,dir)
      saves.intent(run,pinWorkspace(workspace),{projectId,sources:[]})
      const bytes=Buffer.from('Collect at gate 4.')
      const sha=createHash('sha256').update(bytes).digest('hex')
      writeFileSync(join(task,'proposal.md'),bytes)
      if (boundary!=='workspace-written') saves.capture(run.id,bytes,sha)
      if (boundary==='file-written' || boundary==='revision-inserted') {
        const table=boundary==='file-written'?'before insert on artifact_revisions':"before update of revision_id on artifact_saves"
        store.db.exec(`create trigger interrupt_save ${table} begin select raise(abort,'interrupted association'); end;`)
        expect(()=>saves.link(run.id)).toThrow(/interrupted association/)
        expect(store.artifacts.revisions(artifact.id)).toHaveLength(0)
        store.db.exec('drop trigger interrupt_save')
      }
      if(boundary==='already-linked') saves.link(run.id)
      store.close()
      store=openStore(join(dir,'test.db'),{homeDir:dir})
      const restart=artifactSaves(store,dir)
      restart.recover(20)
      restart.recover(21)
      const revisions=store.artifacts.revisions(artifact.id)
      expect(revisions).toHaveLength(1)
      const rev=revisions[0]!
      expect(rev).toMatchObject({sha256:sha,provenance:{projectId},revisionNo:1})
      expect(readFileSync(join(rev.provenance.file!.workspace,rev.provenance.file!.path))).toEqual(bytes)
      expect(store.artifacts.reviews(rev.id)).toEqual([])
      expect(store.journeyRuns.get(run.id)).toMatchObject({status:'partial',artifactId:artifact.id})
      expect(store.db.prepare('select state,body,revision_id from artifact_saves').get()).toEqual({state:'linked',body:null,revision_id:rev.id})
    })
})
