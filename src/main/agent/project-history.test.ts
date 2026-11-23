import { expect, it } from 'vitest'
import { turnPrompt } from './external-common'
import { isProjectHistory } from './history'
import { createHarness } from './testing/fakes'
import { PROJECT_HISTORY_SCHEMA } from '../store/project-history-schema'

it('isolates the mission and its specialist from other work while preserving the ordinary chat session', async () => {
  const h = createHarness()
  try {
    const chief = h.bot('fai', {isPrimary:true}), editor = h.bot('Editor')
    const dm = h.runtime.openDm(chief.id)
    const { store } = h.services
    const ownerOnly = 'Ordinary private marker'
    const missionOnly = 'Private project cutoff'
    const specialistOnly = 'Project reviewer finding'
    let phase: 'before' | 'project' | 'after' = 'before'
    const observed: string[] = []
    h.engine.script(chief.handle, async ({turn,tool,say}) => {
      const outbound = turnPrompt(turn,store,true)
      if (phase === 'before') {
        turn.saveContext({engineSessionId:'ordinary-session',summary:'ordinary-summary'})
        say('Received.')
      } else if (phase === 'project') {
        expect(outbound.text).toContain(missionOnly)
        expect(outbound.text).not.toContain(ownerOnly)
        expect(turn.context).toMatchObject({lastSeenSeq:0,summary:''})
        expect(turn.context.engineSessionId).toBeUndefined()
        turn.saveContext({engineSessionId:'private-session',summary:missionOnly})
        const child = await tool('send_to_agent',{to:editor.handle,message:'Review this: '+missionOnly})
        expect(JSON.stringify(child)).toContain(specialistOnly)
        say('Reviewed '+missionOnly)
      } else {
        expect(outbound.text).toContain(ownerOnly)
        expect(outbound.text).not.toContain(missionOnly)
        expect(outbound.text).not.toContain(specialistOnly)
        expect(turn.context).toMatchObject({engineSessionId:'ordinary-session',summary:'ordinary-summary'})
        await tool('send_to_agent',{to:editor.handle,message:'Ordinary review request'})
        say('Finished')
      }
      observed.push('chief-'+phase)
    })
    h.engine.script(editor.handle, ({turn,say}) => {
      const outbound = turnPrompt(turn,store,true)
      if (phase === 'project') {
        expect(outbound.text).toContain(missionOnly)
        expect(outbound.replayedEntries).toHaveLength(0)
        turn.saveContext({engineSessionId:'project-reviewer-session', summary:specialistOnly})
        say(specialistOnly)
      } else {
        expect(outbound.text).not.toContain(missionOnly)
        expect(outbound.text).not.toContain(specialistOnly)
        expect(turn.context.engineSessionId).toBeUndefined()
        say('Ordinary review')
      }
      observed.push('editor-'+phase)
    })
    await h.send(dm.id,ownerOnly)
    phase = 'project'
    const run = await h.runtime.runAutomated({botId:chief.id,text:missionOnly,
      trigger:{kind:'mission',projectId:'project',projectName:'Synthetic',artifactName:'Cutoff'},
      projectRun:{projectId:'project',runId:'synthetic-run'}})
    expect(run.status).toBe('done')
    phase = 'after'
    await h.send(dm.id,'Ordinary follow-up')
    expect(observed).toEqual(['chief-before','editor-project','chief-project','editor-after','chief-after'])
    const exchange = store.conversations.findExchange(chief.id,editor.id)!
    const saved = store.entries.since(exchange.id,0).filter(e=>e.kind==='message')
    expect(saved.filter(isProjectHistory).map(e=>e.text)).toEqual(['Review this: '+missionOnly,specialistOnly])
    expect(saved.filter(e=>!isProjectHistory(e)).map(e=>e.text)).toEqual(['Ordinary review request','Ordinary review'])
    expect(store.entries.since(dm.id,0).filter(isProjectHistory).some(e=>e.text === missionOnly)).toBe(true)
  } finally { await h.runtime.shutdown(); h.cleanup() }
})

it('retires only mixed summaries and provider threads when upgrading an older mission transcript', async () => {
  const h = createHarness()
  try {
    const store=h.services.store, chief=h.bot('fai',{isPrimary:true}), editor=h.bot('Editor')
    const mixed=h.runtime.openDm(chief.id), clean=h.runtime.openDm(editor.id)
    const message = {kind:'message' as const,mentions:[],attachments:[],isStreaming:false,mentionsEveryone:false}
    const step=store.entries.append({...message,conversationId:mixed.id,author:{kind:'system'},text:'Legacy project instruction',
      trigger:{kind:'mission',projectId:'project',projectName:'Legacy project',artifactName:'Report'}})
    const reply=store.entries.append({...message,conversationId:mixed.id,author:{kind:'bot',botId:chief.id},text:'Legacy project answer'})
    const normal=store.entries.append({...message,conversationId:mixed.id,author:{kind:'user'},text:'A private conversation'})
    for(const [chat,bot] of [[mixed,chief],[clean,editor]] as const){
      store.botContext.set({...store.botContext.get(chat.id,bot.id),lastSeenSeq:3,summarizedUpToSeq:3,
        engineSessionId:'previous-'+chat.id,engineBinding:'old-binding',systemHash:'old-hash',summary:'Existing summary'})
    }
    store.db.exec(PROJECT_HISTORY_SCHEMA)
    expect(store.entries.since(mixed.id,0).map(e=>[e.id,e.text,isProjectHistory(e)])).toEqual([
      [step.id,step.text,true],[reply.id,reply.text,true],[normal.id,normal.text,false]])
    const after=store.botContext.get(mixed.id,chief.id)
    expect(after).toMatchObject({lastSeenSeq:3,summarizedUpToSeq:0,summary:''})
    expect(after.engineSessionId).toBeUndefined()
    expect(after.engineBinding).toBeUndefined()
    expect(after.systemHash).toBeUndefined()
    expect(store.botContext.get(clean.id,editor.id)).toMatchObject({lastSeenSeq:3,summarizedUpToSeq:3,
      engineSessionId:'previous-'+clean.id,summary:'Existing summary'})
  } finally { await h.runtime.shutdown(); h.cleanup() }
})
