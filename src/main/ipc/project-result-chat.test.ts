import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../agent/testing/fakes'
import { projectResultTool } from '../agent/project-result-tool'
import { workBriefTools } from '../agent/work-brief-tools'
import { turnPrompt } from '../agent/external-common'
import { createAttachmentStore } from '../attachments/attachments'
import { createSnapshotService } from '../attachments/snapshots'
import { type PlatformStore } from '../store'
import { pinnedChatInstruction } from '../store/project-request-instructions'
import {
  projectResultForEntry,
  projectResultOrigin,
  queueProjectResult
} from '../store/project-result-requests'
import { workScope } from '../store/work-scope'
import { workBriefs } from '../store/work-briefs'
import { projectSessionHandlers } from './project-sessions'

let root: string, h: Harness
function boot() {
  h = createHarness({ diskProfile: root, attachments: (dataDir) => createAttachmentStore({ dataDir }) })
  mkdirSync(h.services.dataDir, { recursive: true })
  h.services.tools.register(projectResultTool(h.services.store, h.services))
  for (const tool of workBriefTools(h.services.store,h.services.bus,h.services)) h.services.tools.register(tool)
  return projectSessionHandlers(
    { ...h.services, providers: h.providers, runtime: h.runtime },
    h.services.store
  )
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'faibots-project-chat-'))
})
afterEach(async () => {
  await h.runtime.shutdown()
  h.cleanup()
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 30 })
})
async function fixture() {
  const ipc = boot(),
    store = h.services.store
  const chief = h.bot('fai', { isPrimary: true }),
    dm = h.runtime.openDm(chief.id)
  const project = store.projects.create({ name: 'Synthetic project' })
  const path = join(root, 'fixture-notes.md')
  writeFileSync(path, 'Gate: West entrance\nUnrelated: Blue marker')
  const [source] = createSnapshotService({
    projects: store.projects,
    projectSources: store.projectSources,
    attachments: h.services.attachments
  }).attach(project.id, [path])
  const scope = ipc['session:project']({ projectId: project.id }).address
  const start = ipc['session:open']({ ...scope, mode: 'fresh' }).session
  const ask = (query: string) =>
    ipc['session:lookup']({ ...scope, sessionId: start.id, query, requestId: randomUUID() })
  const answer = await ask('Gate'),
    unrelated = await ask('Unrelated')
  const request = {
    ...scope,
    sessionId: start.id,
    answerId: answer.id,
    requestId: randomUUID(),
    instruction: 'Tell me where to enter.'
  }
  return { ipc, store, chief, dm, project, source: source!, scope, start, answer, unrelated, request }
}

// The publishing gate has its own production-path tests. Seed its durable published outcome here
// so changes to the current version can be timed precisely between chat admission and dispatch.
function publishFixtureVersion(store: PlatformStore, projectId: string, version: number) {
  const run = () => store.journeyRuns.start({ projectId, status: 'complete', startedAt: 1 }).id
  const policy = { id: randomUUID(), version, instruction: 'Use the routing rule for version ' + version, requiredText: 'Cutoff V' + version }
  store.db.prepare(`insert into improvement_candidates(id,project_id,version,instruction,required_text,matched,heldout,decision,created_at)
    values(?,?,?,?,?,?,?,'approved',1)`).run(policy.id,projectId,version,policy.instruction,policy.requiredText,run(),run())
  store.db.prepare("insert into improvement_history(project_id,after_id,action,created_at) values(?,?,'publish',1)").run(projectId,policy.id)
  return policy
}

it('pins only the chosen project at admission and retains that version or the original default through explicit replies', async () => {
  const { ipc, store, chief, dm, request, source } = await fixture()
  const before = queueProjectResult(store,h.services,dm.id,request)
  const v1 = publishFixtureVersion(store,request.projectId,1)
  const linked = queueProjectResult(store,h.services,dm.id,{ ...request, requestId: randomUUID() })
  const other = store.projects.create({ name: 'Other project' })
  const foreign = publishFixtureVersion(store,other.id,17)
  const v2 = publishFixtureVersion(store,request.projectId,2)
  expect(pinnedChatInstruction(store.db,linked.id,other.id)).toBeUndefined()
  const seen: unknown[] = []
  h.engine.script(chief.handle,async ({ turn, tool, say }) => {
    expect(turnPrompt(turn,store,true).text).not.toContain(v1.instruction)
    const result = await tool('read_project_result',{})
    const body = result.content[0]
    if (!body || body.type !== 'text') throw Error('Expected project result')
    expect(body.text).not.toContain(foreign.instruction)
    seen.push(result.isError ? 'unavailable' : JSON.parse(body.text).projectInstruction ?? null)
    say('Checked.')
  })
  const sendPointer = async (entry: typeof before) => {
    await h.runtime.send({conversationId:dm.id,text:entry.text,clientNonce:entry.clientNonce!,attachmentPaths:[],mentions:[],mentionsEveryone:false})
    await h.runtime.idle()
  }
  const reply = async (id: string) => {
    await h.runtime.send({conversationId:dm.id,text:'Follow up.',replyToId:id,clientNonce:randomUUID(),attachmentPaths:[],mentions:[],mentionsEveryone:false})
    await h.runtime.idle()
  }
  await sendPointer(before)
  await sendPointer(linked)
  await reply(before.id)
  await reply(linked.id)
  const fresh = await ipc['session:ask-fai']({...request,requestId:randomUUID()})
  await h.runtime.idle()
  await h.send(dm.id,'An unrelated question.')
  expect(seen).toEqual([null,v1,null,v1,v2,'unavailable'])
  expect(JSON.stringify(store.entries.since(dm.id,0))).not.toContain(v1.instruction)
  expect(JSON.stringify(store.db.prepare("select * from actions where tool_name='read_project_result'").all())).not.toContain(v1.instruction)
  store.projectContent.select(request.projectId,store.projectContent.pin(request.projectId,source.id).itemId,false)
  await expect(reply(fresh.entryId)).rejects.toThrow(/unavailable|granted|selected/i)
})

it('keeps the full owner card while limiting the model’s work directory to the active request',async()=>{
  const {ipc,store,chief,dm,request}=await fixture()
  let selectedId=''
  const received:string[]=[]
  h.engine.script(chief.handle,async ({turn,tool,say})=>{
    const textOf=(r:Awaited<ReturnType<typeof tool>>)=>r.content.map(p=>p.type==='text'?p.text:'').join('')
    if(turn.toolContext.projectResultTrigger) {
      const plan=JSON.parse(textOf(await tool('plan_work',{objective:'Private delivery gate',deliverable:'Gate note',checks:'Check this gate'})))
      selectedId=plan.id
      received.push(textOf(await tool('review_work',{action:'list'})))
    } else {
      received.push(textOf(await tool('review_work',{action:'list'})))
      expect((await tool('review_work',{action:'resume',id:selectedId})).isError).toBe(true)
    }
    say('Recorded.')
  })
  await ipc['session:ask-fai'](request)
  await h.runtime.idle()
  await h.send(dm.id,'Separate job')
  expect(JSON.parse(received[0]!)).toEqual([expect.objectContaining({id:selectedId,state:'active'})])
  expect(received.join(' ')).not.toContain('Private delivery gate')
  expect(JSON.parse(received[1]!)).toEqual([])
  expect(workBriefs(store.db).get(selectedId,dm.id).objective).toBe('Private delivery gate')
})

it('keeps a result pending when the completed project brief omits its pinned output check', async () => {
  const { ipc, store, chief, dm, request } = await fixture()
  const version = publishFixtureVersion(store,request.projectId,1)
  const states: string[] = []
  h.engine.script(chief.handle,async ({ tool, say }) => {
    const plan = await tool('plan_work',{objective:'Check the cutoff',deliverable:'Cutoff note',checks:'Quote the cutoff.'})
    const body = plan.content[0]
    if (!body || body.type !== 'text') throw Error('Expected work brief')
    const {id,revision} = JSON.parse(body.text)
    const submit = (text: string) => tool('review_work',{action:'result',id,revision,text})
    const refused = await submit('An incomplete result.')
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused)).not.toContain(version.requiredText)
    states.push(workBriefs(store.db).get(id,dm.id).state)
    const acceptedForReview = await submit('Confirmed. ' + version.requiredText)
    expect(acceptedForReview.isError).toBeFalsy()
    states.push(workBriefs(store.db).get(id,dm.id).state)
    say('Ready to review.')
  })
  await ipc['session:ask-fai'](request)
  await h.runtime.idle()
  expect(states).toEqual(['active','review'])
})

it('delivers the same DM entry on retry, checks each live read and excludes other result text from model history and receipts', async () => {
  const { ipc, store, chief, dm, request, scope, source, unrelated } = await fixture()
  await h.send(dm.id, 'Ordinary earlier message')
  const context = store.botContext.get(dm.id, chief.id)
  store.botContext.set({
    ...context,
    engineSessionId: 'ordinary-private-thread',
    summary: 'unrelated summary'
  })
  let first = '',
    second = ''
  let deniedWrite = false
  h.engine.script(chief.handle, async ({ turn, tool, say }) => {
    expect(turn.tools.map((t) => t.name)).toContain('read_project_result')
    expect(turn.context.engineSessionId).toBeUndefined()
    expect(turn.context.summary).toBe('')
    expect(turnPrompt(turn, store, true).text).not.toMatch(/ordinary earlier|unrelated summary|blue marker/i)
    first = JSON.stringify(await tool('read_project_result', {}))
    say('First fragment with West entrance.')
    const work = workBriefs(store.db).start(dm.id,turn.toolContext.userEntryId!,turn.turnId,'Entrance','Direction','Cite the note')
    expect(JSON.stringify(h.services.bus.events)).not.toContain('West entrance')
    expect(JSON.stringify(store.entries.since(dm.id,0))).not.toContain('West entrance')
    store.projectContent.select(
      scope.projectId,
      store.projectContent.pin(scope.projectId, source.id).itemId,
      false
    )
    second = JSON.stringify(await tool('read_project_result', {}))
    deniedWrite = !!(await tool('review_work',{action:'result',id:work.id,revision:work.revision,text:'West entrance.'})).isError
    turn.saveContext({ engineSessionId: 'restricted-thread', summary: 'restricted summary' })
    say('The selected answer quoted West entrance.')
    throw new Error('Provider failed: West entrance.')
  })
  const [one, two] = await Promise.all([ipc['session:ask-fai'](request), ipc['session:ask-fai'](request)])
  expect(one).toEqual(two)
  await h.runtime.idle()
  expect(first).toContain('Gate: West entrance')
  expect(first).not.toMatch(/blue marker/i)
  expect(second).toContain('"isError":true')
  expect(second).not.toMatch(/fixture-notes|west entrance/)
  expect(deniedWrite).toBe(true)
  expect(store.db.prepare('select state,result from chief_work').get()).toMatchObject({state:'active',result:''})
  expect(JSON.stringify(h.services.bus.events)).not.toContain('West entrance')
  expect(JSON.stringify(store.entries.since(dm.id,0))).not.toContain('West entrance')
  expect(JSON.stringify(store.db.prepare('select error from turns').all())).not.toContain('West entrance')
  expect(store.entries.since(dm.id,0).some(e=>e.text.includes('selected project result is unavailable'))).toBe(true)
  expect(h.engine.turns).toHaveLength(2)
  expect(store.botContext.get(dm.id, chief.id)).toMatchObject({
    engineSessionId: 'ordinary-private-thread',
    summary: 'unrelated summary'
  })
  const entries = store.entries.since(dm.id, 0)
  expect(entries.filter((e) => e.toolCall?.toolName === 'read_project_result').map((e) => e.toolCall?.resultText)).toEqual([
    'The selected result was checked against current access.',
    'The selected result could not be read.'
  ])
  expect(store.db.prepare('select count(*) as n from project_result_requests').get()?.n).toBe(1)
  expect(store.entries.get(one.entryId)?.text).not.toMatch(/west entrance|tell me where/i)
  expect(
    projectResultForEntry(store, h.services.dataDir, h.services.attachments, dm.id, one.entryId)
  ).toEqual({ status: 'withheld' })
  h.engine.script(chief.handle, async ({ turn, tool, say }) => {
    expect(turn.tools.map((t) => t.name)).not.toContain('read_project_result')
    expect(turnPrompt(turn, store, true).text).not.toMatch(/west entrance|blue marker/i)
    expect((await tool('read_project_result', {})).isError).toBe(true)
    say('ordinary answer')
  })
  await h.send(dm.id, 'A different job')
  expect(
    store.db.prepare("select count(*) as n from actions where tool_name='read_project_result'").get()?.n
  ).toBe(0)
  await expect(ipc['session:ask-fai']({ ...request, answerId: unrelated.id })).rejects.toThrow()
})

it('checks visible fork membership, original owner, live source bytes, and exact brief linkage', async () => {
  const { ipc, store, chief, dm, project, scope, start, answer, unrelated, request, source } = await fixture()
  const other = store.projects.create({ name: 'Other project' })
  const item = store.projectContent.pin(project.id, source.id).itemId
  store.projectContent.share(project.id, item, other.id)
  store.projectContent.select(other.id, item, true)
  const address = ipc['session:project']({ projectId: other.id }).address
  const fork = ipc['session:open']({
    ...address,
    mode: 'fork',
    parentId: start.id,
    parentProjectId: project.id,
    answerIds: [answer.id]
  }).session
  const selection = { ...request, ...address, sessionId: fork.id }
  const queue = (args: typeof request) => queueProjectResult(store, h.services, dm.id, args)
  expect(() => queue({ ...selection, answerId: unrelated.id })).toThrow(/visible/)
  expect(() => queue({ ...selection, hostId: randomUUID() })).toThrow(/host/)
  expect(() => queue({ ...selection, projectId: scope.projectId })).toThrow(/different project/)
  const entry = queue(selection)
  expect(() => queue({ ...selection, instruction: 'A different job' })).toThrow(/another selection/)
  const inspect = () =>
    projectResultForEntry(store, h.services.dataDir, h.services.attachments, dm.id, entry.id)
  expect(inspect()).toMatchObject({
    status: 'available',
    projectId: other.id,
    sessionId: fork.id,
    answerId: answer.id,
    evidence: [{ sha256: source.sha256, line: 1 }]
  })
  const briefs = workBriefs(store.db)
  const work = briefs.start(dm.id, entry.id, randomUUID(), 'Find entrance', 'Direction', 'Verified citation')
  const user = (text: string, clientNonce: string) =>
    store.entries.append({
      conversationId: dm.id,
      kind: 'message',
      author: { kind: 'user' },
      text,
      mentions: [],
      mentionsEveryone: false,
      attachments: [],
      isStreaming: false,
      clientNonce
    })
  const otherUser = user('Work ' + work.id + ' selected result?', randomUUID())
  expect(projectResultOrigin(store, dm.id, otherUser)).toBeUndefined()
  expect(
    projectResultForEntry(store, h.services.dataDir, h.services.attachments, dm.id, otherUser.id)
  ).toBeUndefined()
  briefs.decide(dm.id, {
    id: work.id,
    revision: work.revision,
    decision: 'steer',
    note: 'Include the line number'
  })
  const decision = user(
    `Updated instruction for work ${work.id} (${work.objective}): Include the line number`,
    `work-${work.id}-${work.revision}`
  )
  expect(projectResultOrigin(store, dm.id, decision)).toBe(entry.id)
  h.services.tools.setPermission('read_project_result', 'never', chief.id)
  expect(inspect()).toEqual({ status: 'withheld' })
  h.services.tools.setPermission('read_project_result', 'always', chief.id)
  writeFileSync(
    join(h.services.dataDir, 'attachments', source.sha256.slice(0, 16) + '-' + source.name),
    'corrupt'
  )
  expect(inspect()).toEqual({ status: 'withheld' })
})

it('recovers a committed unsent selection after reopening, and preserves an interrupted started turn without redispatch', async () => {
  const { store, request, chief, dm } = await fixture()
  const queued = queueProjectResult(store, h.services, dm.id, request)
  const started = queueProjectResult(store, h.services, dm.id, { ...request, requestId: randomUUID() })
  store.db
    .prepare("update project_result_requests set state='started', turn_id=? where entry_id=?")
    .run(randomUUID(), started.id)
  await h.runtime.shutdown()
  h.cleanup()
  const ipc = boot()
  let evidence = ''
  h.engine.script(chief.handle, async ({ tool, say }) => {
    evidence = JSON.stringify(await tool('read_project_result', {}))
    say('Checked.')
  })
  await Promise.resolve()
  await h.runtime.idle()
  expect(evidence).toContain('West entrance')
  const retry = await ipc['session:ask-fai'](request)
  expect(retry).toEqual({ conversationId: dm.id, entryId: queued.id })
  await h.runtime.idle()
  expect(h.engine.turns).toHaveLength(1)
  expect(
    h.services.store.db.prepare('select state from project_result_requests where entry_id=?').get(started.id)
      ?.state
  ).toBe('interrupted')
  expect(
    h.services.store.entries
      .since(dm.id, 0)
      .filter((e) => e.kind === 'event')
      .map((e) => e.text)
      .join(' ')
  ).toContain('app closed')
})

it('uses the owner’s explicit Reply action for a new instruction and live evidence without carrying the first answer into the model', async () => {
  const { ipc, store, chief, dm, request, source } = await fixture()
  const observations: string[] = []
  h.engine.script(chief.handle, async ({ turn, tool, say }) => {
    if (!turn.isolatedTrigger) {
      observations.push('ordinary')
      say('Other matter.')
      return
    }
    const result = await tool('read_project_result', {})
    const content = result.content[0]!
    if (content.type !== 'text') throw new Error('Expected text evidence')
    const selected = JSON.parse(content.text)
    expect(selected.citations[0].excerpt).toBe('Gate: West entrance')
    observations.push(selected.instruction)
    expect(turnPrompt(turn, store, true).text).not.toContain(
      'The earlier answer was written in a particular way.'
    )
    say('The earlier answer was written in a particular way.')
  })
  const original = await ipc['session:ask-fai'](request)
  await h.runtime.idle()
  const answer = store.entries.since(dm.id, 0).find((e) => e.kind === 'message' && e.author.kind === 'bot')!
  expect(answer.meta?.selectedResultEntryId).toBe(original.entryId)
  const follow = (id: string, text: string, nonce: string) =>
    h.runtime.send({
      conversationId: dm.id,
      replyToId: id,
      text,
      clientNonce: nonce,
      mentions: [],
      mentionsEveryone: false,
      attachmentPaths: []
    })
  const nonce = randomUUID()
  const [one, two] = await Promise.all([follow(answer.id, 'Why?', nonce), follow(answer.id, 'Why?', nonce)])
  expect(one.id).toBe(two.id)
  await h.runtime.idle()
  await h.send(dm.id, 'Different job')
  expect(observations).toEqual([request.instruction, 'Why?', 'ordinary'])
  expect(
    projectResultForEntry(store, h.services.dataDir, h.services.attachments, dm.id, one.id)
  ).toMatchObject({ answerId: request.answerId })
  store.projectContent.select(
    request.projectId,
    store.projectContent.pin(request.projectId, source.id).itemId,
    false
  )
  await expect(follow(answer.id, 'Try again?', randomUUID())).rejects.toThrow(
    /selection|permissions|selected/i
  )
  await h.runtime.idle()
  expect(h.engine.turns).toHaveLength(3)
})

it('keeps a selected project request out of later chat history, including after upgrading an old request', async () => {
  const { ipc, store, request, chief, dm } = await fixture()
  const selected = await ipc['session:ask-fai'](request)
  await h.runtime.idle()
  const pointer = store.entries.get(selected.entryId)!
  expect(pointer.meta?.selectedResultEntryId).toBe(pointer.id)
  store.db.prepare('update entries set meta=null where id=?').run(pointer.id)
  const neverStarted = queueProjectResult(store, h.services, dm.id, { ...request, requestId: randomUUID() })
  store.db.prepare("update project_result_requests set state='finished' where entry_id=?").run(neverStarted.id)
  await h.runtime.shutdown()
  h.cleanup()
  boot()
  await Promise.resolve()
  await h.runtime.idle()
  expect(h.services.store.db.prepare('select state from project_result_requests where entry_id=?').get(neverStarted.id)?.state).toBe('interrupted')
  let prompt: string | undefined
  h.engine.script(chief.handle, ({ turn, say }) => {
    prompt = turnPrompt(turn, h.services.store, true).text
    say('An ordinary reply.')
  })
  await h.send(dm.id, 'Another job.')
  expect(prompt).toContain('Another job.')
  expect(prompt).not.toContain(pointer.text)
  expect(h.services.store.entries.get(pointer.id)?.meta?.selectedResultEntryId).toBe(pointer.id)
})

it('records a stopped queued project request as interrupted and lets the owner ask again', async () => {
  const { ipc, store, request, chief, dm } = await fixture()
  let started!: () => void, release!: () => void
  const running = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  h.engine.script(chief.handle, async () => { started(); await gate })
  await h.runtime.send({ conversationId: dm.id, text: 'Separate task', clientNonce: randomUUID(), mentions: [], mentionsEveryone: false, attachmentPaths: [] })
  await running
  const selected = await ipc['session:ask-fai'](request)
  h.runtime.stop(dm.id)
  release()
  await h.runtime.idle()
  const state = () => store.db.prepare('select state,turn_id from project_result_requests where entry_id=?').get(selected.entryId)
  expect(state()).toMatchObject({ state: 'interrupted', turn_id: null })
  expect(store.entries.since(dm.id, 0).some((entry) => entry.kind === 'event' && entry.text.includes('ask again'))).toBe(true)
  const count = h.engine.turns.length
  await ipc['session:ask-fai'](request)
  await h.runtime.idle()
  expect(h.engine.turns).toHaveLength(count)
  h.engine.script(chief.handle, ({ say }) => say('New answer.'))
  const again = await ipc['session:ask-fai']({ ...request, requestId: randomUUID() })
  await h.runtime.idle()
  expect(again.entryId).not.toBe(selected.entryId)
  expect(store.db.prepare('select state from project_result_requests where entry_id=?').get(again.entryId)?.state).toBe('finished')
})

it('shows only the linked project inputs on the work card and withdraws their titles when access changes', async () => {
  const { ipc, store, dm, project, request, source, start } = await fixture()
  const entry = queueProjectResult(store, h.services, dm.id, request)
  const work = workBriefs(store.db).start(dm.id, entry.id, 'test-turn', 'Check the entrance', 'One sentence', 'Matches the selected source')
  const display = () => workScope(store, h.services, dm.id, work.id)
  const instruction = () => ipc['session:instruction']({ conversationId: dm.id, entryId: entry.id })
  expect(instruction()).toBe(request.instruction)
  expect(ipc['session:instruction']({ conversationId: 'another-chat', entryId: entry.id })).toBeNull()
  expect(display()).toEqual({ inputs: ['Your original message', project.name + ' / ' + start.label, 'fixture-notes.md · revision 1, line 1'], withheld: false })
  expect(() => workScope(store, h.services, 'another-chat', work.id)).toThrow(/this chat/)
  store.projectContent.select(project.id, store.projectContent.pin(project.id, source.id).itemId, false)
  expect(display()).toEqual({ inputs: ['Your original message'], withheld: true })
  expect(instruction()).toBeNull()
})

it('withholds a revoked queued selection on restart before opening any provider turn', async () => {
  const { store, dm, request, source } = await fixture()
  queueProjectResult(store, h.services, dm.id, request)
  store.projectContent.select(request.projectId, store.projectContent.pin(request.projectId, source.id).itemId, false)
  await h.runtime.shutdown()
  h.cleanup()
  boot()
  await Promise.resolve()
  await h.runtime.idle()
  expect(h.engine.turns).toHaveLength(0)
  const entries = h.services.store.entries.since(dm.id, 0)
  expect(entries.some(e => e.kind === 'event' && e.text.includes('selected project result is unavailable'))).toBe(true)
  expect(JSON.stringify(entries)).not.toContain('West entrance')
})

it('withholds all completed text segments when source bytes change after the last successful read', async () => {
  const { ipc, store, chief, dm, request, source } = await fixture()
  let lateDelta: (() => void) | undefined
  h.engine.script(chief.handle, async ({ turn, tool, say }) => {
    const evidence = await tool('read_project_result', {})
    expect(JSON.stringify(evidence)).toContain('West entrance')
    say('Draft segment: West entrance.')
    expect(store.entries.since(dm.id,0).some(e=> e.text.includes('West entrance'))).toBe(false)
    writeFileSync(join(h.services.dataDir, 'attachments',source.sha256.slice(0,16)+'-'+source.name), 'new content')
    say('Final segment: West entrance.')
    lateDelta = () => { turn.recorder.textDelta('Late West entrance.'); turn.recorder.endText() }
  })
  await ipc['session:ask-fai'](request)
  await h.runtime.idle()
  expect(lateDelta).toBeTypeOf('function')
  lateDelta!()
  const entries = store.entries.since(dm.id,0)
  expect(entries.some(e=>e.text.includes('selected project result is unavailable'))).toBe(true)
  expect(JSON.stringify(entries)).not.toContain('West entrance')
  expect(JSON.stringify(h.services.bus.events)).not.toContain('West entrance')
  expect(store.db.prepare("select status,error from turns where conversation_id=?").get(dm.id))
    .toMatchObject({status:'error',error:expect.stringContaining('selected project result is unavailable')})
})
