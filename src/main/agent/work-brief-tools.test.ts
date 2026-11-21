import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkBrief } from '@shared/work-brief'
import type { ToolResult } from '../contracts'
import { workBriefs } from '../store/work-briefs'
import { deliverWorkReplies, workBriefTools } from './work-brief-tools'
import { createHarness, type Harness } from './testing/fakes'

const briefInput = { objective: 'Prepare delivery instructions', deliverable: 'A pickup note', checks: 'Use the selected gate' }
const body = (result: ToolResult) => result.content.map(p => p.type === 'text' ? p.text : '').join('')
function asBrief(result: ToolResult): WorkBrief {
  if (result.isError) throw new Error(body(result))
  return JSON.parse(body(result))
}

describe('fai work briefs', () => {
  let h: Harness
  beforeEach(() => {
    h = createHarness()
    for (const tool of [...h.runtime.assignments.tools(), ...workBriefTools(h.services.store,h.services.bus)]) h.services.tools.register(tool)
  })
  afterEach(async () => { await h.runtime.shutdown(); h.cleanup() })

  it('asks once, resumes the same brief after an owner answer, and requires the owner to accept', async () => {
    const chief = h.bot('fai', {isPrimary:true})
    const dm = h.runtime.openDm(chief.id)
    const other = h.runtime.openDm(h.bot('Editor').id)
    const work = workBriefs(h.services.store.db)
    h.engine.script('fai', async api => {
      const brief=asBrief(await api.tool('plan_work', briefInput))
      if (brief.revision === 1) {
        asBrief(await api.tool('review_work',{action:'question',id:brief.id,revision:1,text:'Which gate?'}))
        api.say('Which gate?')
      } else {
        asBrief(await api.tool('review_work',{action:'result',id:brief.id,revision:brief.revision,text:'Meet at Gate 4.'}))
        api.say('Your pickup note is ready.')
      }
    })
    await h.send(dm.id,'Write our pickup note.')
    const first=work.list(dm.id)[0]!
    expect(first).toMatchObject({state:'needs_input',question:'Which gate?',revision:2})
    expect(work.list(other.id)).toEqual([])
    const answer = {id:first.id,revision:2,decision:'answer' as const,note:'Gate 4'}
    expect(() => work.decide(other.id,answer)).toThrow(/this chat/)
    expect(work.decide(dm.id,answer).state).toBe('active')
    expect(work.decide(dm.id,answer).revision).toBe(3)
    await expect(deliverWorkReplies(h.services.store,{send:async()=>{throw Error('offline')}})).rejects.toThrow('offline')
    expect(work.pending()).toHaveLength(1)
    await Promise.all([deliverWorkReplies(h.services.store,h.runtime),deliverWorkReplies(h.services.store,h.runtime)])
    await h.runtime.idle()
    expect(work.pending()).toHaveLength(0)
    const entry = h.services.store.entries.findByNonce(dm.id,`work-${first.id}-2`)
    expect(entry?.text).toContain('Gate 4')
    expect(h.engine.turns.filter(t=>t.handle==='fai')).toHaveLength(2)
    const review=work.list(dm.id)
    expect(review).toHaveLength(1)
    expect(review[0]).toMatchObject({id:first.id,revision:4,state:'review',result:'Meet at Gate 4.'})
    expect(() => work.decide(dm.id,{...answer,decision:'accept'})).toThrow(/changed/)
    expect(work.decide(dm.id,{id:first.id,revision:4,decision:'accept',note:''}).state).toBe('accepted')
    expect(() => work.resume(dm.id,first.id,'new-turn')).toThrow(/closed/)
  })

  it('keeps a failed assignment unresolved until the result explicitly says partial', async () => {
    const chief=h.bot('fai',{isPrimary:true})
    h.bot('Editor')
    const dm=h.runtime.openDm(chief.id)
    const results: string[]=[]
    h.engine.script('editor',api=>{api.say('Checked the first sentence.');throw Error('Service interrupted')})
      .script('fai',async api=>{
        const brief=asBrief(await api.tool('plan_work',briefInput))
        await api.tool('send_to_agent',{to:'editor',message:'Check the note'})
        const submit={action:'result',id:brief.id,revision:brief.revision,text:'Only the first sentence was checked.'}
        results.push(body(await api.tool('review_work',submit)))
        const partial=asBrief(await api.tool('review_work',{...submit,partial:true}))
        results.push(partial.result)
        api.say(partial.result)
      })
    await h.send(dm.id,'Check the note.')
    expect(results[0]).toMatch(/failed or is uncertain/)
    expect(workBriefs(h.services.store.db).list(dm.id)[0]).toMatchObject({partial:true,state:'review'})
  })

  it('keeps a busy job update separate from a new request and links each reply to its own message', async () => {
    const chief = h.bot('fai',{isPrimary:true})
    const dm = h.runtime.openDm(chief.id)
    const work = workBriefs(h.services.store.db)
    let proceed!: () => void
    const gate = new Promise<void>(resolve=>{proceed=resolve})
    const send = (text:string) => h.runtime.send({conversationId:dm.id,text,mentions:[],mentionsEveryone:false,attachmentPaths:[],clientNonce:text})
    const failures:string[]=[]
    h.engine.script('fai',async api=>{
      const request = h.engine.turns.at(-1)!.newTexts.at(-1) ?? ''
      const brief = asBrief(await api.tool('plan_work',{...briefInput,objective:request.includes('Separate')?'Check travel dates':briefInput.objective}))
      if(request==='Start the pickup note') {
        await gate
        const obsolete = await api.tool('review_work',{action:'result',id:brief.id,revision:brief.revision,text:'Old gate.'})
        failures.push(body(obsolete))
      } else {
        const result = request.includes('Gate 8') ? 'Pickup at Gate 8.' : 'Check the travel dates.'
        asBrief(await api.tool('review_work',{action:'result',id:brief.id,revision:brief.revision,text:result}))
        api.say(result)
      }
    })
    await send('Start the pickup note')
    await vi.waitFor(()=>expect(work.list(dm.id)).toHaveLength(1))
    const original=work.list(dm.id)[0]!
    work.decide(dm.id,{id:original.id,revision:1,decision:'steer',note:'Use Gate 8'})
    try {
      await deliverWorkReplies(h.services.store,h.runtime)
      await send('Separate job: travel dates')
    } finally { proceed() }
    await h.runtime.idle()
    const briefs=work.list(dm.id)
    expect(briefs).toHaveLength(2)
    expect(briefs.find(item=>item.id===original.id)).toMatchObject({lastInstruction:'Use Gate 8',result:'Pickup at Gate 8.',state:'review'})
    expect(failures[0]).toMatch(/changed|updated/)
    const entries=h.services.store.entries.since(dm.id,0)
    for(const [reply,nonce] of [['Pickup at Gate 8.',`work-${original.id}-1`],['Check the travel dates.','Separate job: travel dates']] as const) {
      expect(entries.find(entry=>entry.text===reply)?.replyToId).toBe(entries.find(entry=>entry.clientNonce===nonce)?.id)
    }
  })

  it('wakes one parent after background completion and ignores later duplicate notifications', async () => {
    const chief=h.bot('fai',{isPrimary:true})
    h.bot('Editor')
    const dm=h.runtime.openDm(chief.id)
    const work=workBriefs(h.services.store.db)
    let proceed!:()=>void
    const gate=new Promise<void>(resolve=>{proceed=resolve})
    let turns=0
    h.engine.script('editor',async api=>{await gate;api.say('The check passed.')})
      .script('fai',async api=>{
        turns++
        if(turns===1){
          const brief=asBrief(await api.tool('plan_work',briefInput))
          await api.tool('assign_to_agent',{to:'editor',message:'Check it'})
          const waiting=asBrief(await api.tool('review_work',{action:'wait',id:brief.id,revision:brief.revision}))
          api.say('The editor is checking it.')
          expect(waiting.state).toBe('waiting')
        } else {
          const brief=work.list(dm.id)[0]!
          asBrief(await api.tool('review_work',{action:'result',id:brief.id,revision:brief.revision,text:'The editor checked it.'}))
          api.say('Check complete.')
        }
      })
    await h.runtime.send({conversationId:dm.id,text:'Ask the editor.',mentions:[],mentionsEveryone:false,attachmentPaths:[],clientNonce:'user-request'})
    try {await vi.waitFor(()=>expect(work.list(dm.id)[0]?.state).toBe('waiting'))} finally {proceed()}
    await h.runtime.idle()
    expect(work.list(dm.id)[0]).toMatchObject({state:'review',result:'The editor checked it.'})
    expect(h.services.store.db.prepare('select state from chief_wakes').all()).toEqual([{state:'finished'}])
    expect(work.ready(h.services.store.entries)).toEqual([])
    expect(turns).toBe(2)
  })
})
