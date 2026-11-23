import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkWait } from '@shared/work-brief'
import { createHarness, type Harness } from './testing/fakes'
import { workBriefTools } from './work-brief-tools'
import { backgroundAnchor, createDelegationRepo } from '../store/delegations'
import { workBriefs } from '../store/work-briefs'

let h: Harness
beforeEach(()=>{h=createHarness()})
afterEach(async()=>{await h.runtime.shutdown();h.cleanup()})

function fixture() {
  const {store}=h.services
  const chief=h.bot('fai',{isPrimary:true})
  const scout=h.bot('Scout')
  const room=h.runtime.openDm(chief.id)
  const exchange=store.conversations.create({kind:'exchange',title:'',botIds:[chief.id,scout.id]})
  const fields={mentions:[],mentionsEveryone:false,attachments:[],isStreaming:false}
  const request=store.entries.append({...fields,conversationId:room.id,kind:'message',text:'Review the returns.',author:{kind:'user'}})
  const work=workBriefs(store.db)
  const brief=work.start(room.id,request.id,'turn','Review the venue','A location','Check the location')
  const delegations=createDelegationRepo(store.db,store.entries)
  function admit(id:string) {
    expect(delegations.reserve(id,{turnId:'turn',conversationId:room.id},12)).toBe(true)
    return delegations.assign({id,callerId:chief.id,childId:scout.id,parentId:room.id,inputHash:id},()=>({
      parent:store.entries.append({...fields,conversationId:room.id,kind:'event',text:'Checking',author:{kind:'system'},clientNonce:backgroundAnchor(id)}),
      question:store.entries.append({...fields,conversationId:exchange.id,kind:'message',text:'Check the venue',author:{kind:'bot',botId:chief.id}})
    })).lease!
  }
  const wait=(condition:WorkWait)=>work.wait(room.id,brief.id,1,'turn',condition)
  return {store,chief,scout,room,work,brief,delegations,admit,wait,ready:()=>work.ready(store.entries)}
}

it('wakes on the named return and keeps unrelated obligations open',()=>{
  const {work,brief,room,delegations,admit,wait,ready}=fixture()
  const selected=admit('selected')
  admit('other')
  expect(()=>wait({kind:'assignment',assignmentId:'another-job'})).toThrow(/this brief/)
  delegations.finish(selected,'answered',{text:'Venue checked.'})
  expect(wait({kind:'assignment',assignmentId:selected.id}).waitingFor).toMatchObject({assignmentId:'selected'})
  const [wake]=ready()
  expect(wake).toBeDefined()
  expect(work.claimWake(wake!.id,wake!.revision,'next')).toEqual({cancel:[]})
  expect(()=>work.submit(room.id,brief.id,3,'result','Complete',[],'next',false)).toThrow(/still running/)
  expect(ready()).toEqual([])
})

it.each(['continue','cancel'] as const)('checks the exact answer before applying the %s policy',remaining=>{
  const {work,store,delegations,admit,wait,ready}=fixture()
  const first=admit('first'), winner=admit('winner')
  admit('remaining')
  admit('outside-pool')
  wait({kind:'first_match',assignmentIds:['first','winner','remaining'],expectedReply:'APPROVED',remaining})
  delegations.finish(first,'answered',{text:'NOT APPROVED'})
  expect(ready()).toEqual([])
  delegations.finish(winner,'answered',{text:'APPROVED'})
  const [wake]=ready()
  expect(store.entries.get(wake!.entryId)?.text).toContain('winner')
  expect(work.claimWake(wake!.id,wake!.revision,'next')?.cancel).toEqual(remaining==='cancel'?['remaining']:[])
  expect(work.claimWake(wake!.id,wake!.revision,'duplicate')).toBeUndefined()
})

it('observes only a new webhook on the selected owner-configured routine',()=>{
  const {store,room,chief,scout,wait,ready}=fixture()
  const routine=(botId:string)=>store.routines.insert({botId,name:'Shipping',prompt:'Record event',schedule:{kind:'manual'},enabled:true,webhookEnabled:true,createdBy:'user'})
  const own=routine(chief.id),other=routine(scout.id)
  for(const id of [own.id,other.id]) store.routines.setWebhookTokenHash(id,'fixture')
  const run=(r:typeof own,trigger:'webhook'|'manual')=>store.routines.startRun({routineId:r.id,botId:r.botId,trigger,status:'running',startedAt:Date.now(),summary:'private payload'})
  run(own,'webhook')
  expect(()=>wait({kind:'webhook',routineId:other.id})).toThrow(/belonging to this bot/)
  wait({kind:'webhook',routineId:own.id})
  run(other,'webhook')
  run(own,'manual')
  expect(ready()).toEqual([])
  run(own,'webhook')
  store.db.prepare("delete from routine_runs where routine_id=?").run(own.id)
  const [wake]=ready()
  const entry=store.entries.get(wake!.entryId)
  expect(entry?.conversationId).toBe(room.id)
  expect(entry?.text).toContain('received a webhook')
  expect(entry?.text).not.toContain('private payload')
})

it.each(['allowed','ask','revoked'] as const)('respects %s cancellation permission across a live wait',async mode=>{
  const {store,bus}=h.services
  for(const tool of [...h.runtime.assignments.tools(),...workBriefTools(store,bus)]) h.services.tools.register(tool)
  const chief=h.bot('fai',{isPrimary:true}), room=h.runtime.openDm(chief.id)
  h.bot('Reviewer');h.bot('Backup')
  let releaseReview!:()=>void, releaseBackup!:()=>void
  const review=new Promise<void>(r=>{releaseReview=r}), backup=new Promise<void>(r=>{releaseBackup=r})
  const work=workBriefs(store.db)
  if(mode==='ask') store.bots.update(chief.id,{toolPermissions:{cancel_assignment:'ask'}})
  let calls=0,registration=''
  h.engine.script('reviewer',async api=>{await review;api.say('Pass')})
    .script('backup',async api=>{await Promise.race([backup,api.untilAborted()]);api.say('Backup observation')})
    .script('fai',async api=>{
      if(++calls===1) {
        await api.tool('plan_work',{objective:'Compare reviews',deliverable:'Checked answer',checks:'Exact reviewer reply'})
        for(const to of ['reviewer','backup']) await api.tool('assign_to_agent',{to,message:'Check the fixture'})
        const brief=work.list(room.id)[0]!
        const assigned=work.assignments(brief.id).map(row=>row.id)
        const saved=await api.tool('review_work',{action:'wait',id:brief.id,revision:brief.revision,
          waitFor:{kind:'first_match',assignmentIds:assigned,expectedReply:'Pass',remaining:'cancel'}})
        registration=saved.isError?'refused':'waiting'
      }
      api.say('Checked the work state.')
    })
  await h.runtime.send({conversationId:room.id,text:'Start the reviews',clientNonce:'review',attachmentPaths:[],mentions:[],mentionsEveryone:false})
  try {
    await vi.waitFor(()=>expect(registration).toBe(mode==='ask'?'refused':'waiting'))
    if(mode==='revoked') store.bots.update(chief.id,{toolPermissions:{cancel_assignment:'never'}})
    releaseReview()
    if(mode!=='ask') await vi.waitFor(()=>expect(calls).toBe(2))
    const statuses=work.assignments(work.list(room.id)[0]!.id).map(child=>child.state)
    expect(statuses).toContain(mode==='allowed'?'reconciliation_required':'assigned')
  } finally { releaseReview(); releaseBackup();await h.runtime.idle() }
})

it('wakes on time with no incoming message or worker, once',async()=>{
  for(const tool of workBriefTools(h.services.store,h.services.bus)) h.services.tools.register(tool)
  const chief=h.bot('fai',{isPrimary:true}),room=h.runtime.openDm(chief.id)
  const work=workBriefs(h.services.store.db)
  let calls=0
  h.engine.script('fai',async api=>{
    if (++calls===1) {
      await api.tool('plan_work',{objective:'Return at the agreed time',deliverable:'Reminder',checks:'Check the time'})
      const brief=work.list(room.id)[0]!
      const response=await api.tool('review_work',{action:'wait',id:brief.id,revision:brief.revision,waitFor:{kind:'time',at:new Date(Date.now()+150).toISOString()}})
      expect(response.isError).not.toBe(true)
    }
    api.say(calls===1?'Scheduled.':'The time has arrived.')
  })
  await h.send(room.id,'Set a reminder.')
  await vi.waitFor(()=>expect(calls).toBe(2))
  await h.runtime.idle()
  expect(h.services.store.entries.since(room.id,0).filter(entry=>entry.clientNonce?.startsWith('work-wake-'))).toHaveLength(1)
})

it('reports an expired deadline without cancelling work, and ignores a stale wake after an owner cancellation',()=>{
  const {work,store,room,brief,admit,wait,ready}=fixture()
  admit('unfinished')
  wait({kind:'assignment',assignmentId:'unfinished',deadline:new Date(Date.now()+60_000).toISOString()})
  store.db.prepare('update chief_wakes set due_at=?').run(Date.now()-1)
  const [wake]=ready()
  expect(store.entries.get(wake!.entryId)?.text).toContain('deadline expired')
  work.decide(room.id,{id:brief.id,revision:3,decision:'cancel',note:''})
  expect(work.claimWake(brief.id,wake!.revision,'obsolete')).toBeUndefined()
})

it('delivers an overdue scheduled brief once across two desktop restarts',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'faibots-overdue-'))
  let disk=createHarness({diskProfile:dir})
  try {
    const chief=disk.bot('fai',{isPrimary:true}),chat=disk.runtime.openDm(chief.id)
    const entry=disk.services.store.entries.append({conversationId:chat.id,kind:'message',author:{kind:'user'},text:'Follow up later',
      mentions:[],mentionsEveryone:false,attachments:[],isStreaming:false})
    const work=workBriefs(disk.services.store.db)
    const brief=work.start(chat.id,entry.id,'initial','Follow up','A reminder','At the selected time')
    const at=new Date(Date.now()+60_000).toISOString()
    work.wait(chat.id,brief.id,1,'initial',{kind:'time',at})
    await disk.runtime.shutdown()
    // Model elapsed wall time while the app was closed, without sleeping for a minute.
    disk.services.store.db.prepare('update chief_wakes set due_at=? where work_id=?').run(Date.now()-1,brief.id)
    disk.cleanup()
    let calls=0
    for(let boot=0;boot<2;boot++) {
      disk=createHarness({diskProfile:dir})
      disk.engine.script('fai',api=>{calls++;api.say('Here is the reminder.')})
      await Promise.resolve()
      await disk.runtime.idle()
      expect(calls).toBe(1)
      expect(disk.services.store.entries.since(chat.id,0).filter(e=>e.clientNonce?.startsWith('work-wake-'))).toHaveLength(1)
      if(boot===0) {await disk.runtime.shutdown();disk.cleanup()}
    }
  } finally {await disk.runtime.shutdown();disk.cleanup();rmSync(dir,{recursive:true,force:true})}
})
