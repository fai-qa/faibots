import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAttachmentStore } from '../attachments/attachments'
import { createHarness, type Harness } from '../agent/testing/fakes'
import { projectResultTool } from '../agent/project-result-tool'
import { workBriefTools } from '../agent/work-brief-tools'
import { readProjectResult } from '../store/project-result-requests'
import { readPageEvidence } from '../store/page-evidence'
import type { Services } from '../contracts'
import type { WorkBrief } from '@shared/work-brief'

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  ipcMain: {},
  dialog: {},
  Notification: class {},
  safeStorage: {}
}))
const { buildHandlers } = await import('./handlers')
let root: string, h: Harness
const memo = 'Supplier A ships in five days. Supplier B has not confirmed delivery.'
function boot() {
  h = createHarness({ diskProfile: root, attachments: (dataDir) => createAttachmentStore({ dataDir }) })
  mkdirSync(h.services.dataDir, { recursive: true })
  h.services.tools.register(projectResultTool(h.services.store, h.services))
  for (const t of workBriefTools(h.services.store, h.services.bus, h.services)) h.services.tools.register(t)
  return buildHandlers(
    { ...h.services, providers: h.providers, runtime: h.runtime } as unknown as Services,
    () => null
  )
}
type Ipc = ReturnType<typeof boot>
function script(partial = false, readPage = false) {
  h.engine.script('fai', async (api) => {
    if (readPage) expect((await api.tool('read_project_result',{})).isError).toBeFalsy()
    const r = await api.tool('plan_work', {
      objective: 'Compare suppliers',
      deliverable: 'Supplier comparison',
      checks: 'Record delivery and unknowns'
    })
    const body = r.content.find((p) => p.type === 'text')
    if (body?.type !== 'text' || r.isError) throw Error('No work brief')
    const brief: WorkBrief = JSON.parse(body.text)
    const verdict = await api.tool('review_work', {
      id: brief.id,
      revision: brief.revision,
      action: 'result',
      text: memo,
      partial
    })
    if (verdict.isError) throw Error('Work result was refused')
    api.say('Ready for your review.')
  })
}
async function accept(ipc: Ipc, chat: string) {
  const [brief] = await ipc['work:list']({ conversationId: chat })
  expect(brief?.state).toBe('review')
  const decided = await ipc['work:decide']({
    conversationId: chat,
    id: brief!.id,
    revision: brief!.revision,
    decision: 'accept',
    note: ''
  })
  return { conversationId: chat, workId: decided.id, revision: decided.revision }
}
async function scoped(ipc: Ipc) {
  const chat = h.runtime.openDm(h.bot('fai', { isPrimary: true }).id).id
  const project = await ipc['projects:create']({ name: 'Procurement' })
  const other = await ipc['projects:create']({ name: 'Other project' })
  const path = join(root, 'lead-times.md')
  writeFileSync(path, 'Supplier A ships in five days. Supplier B has not confirmed delivery.')
  const [source] = await ipc['projects:attach-notes']({ projectId: project.id, paths: [path] })
  const address = (await ipc['session:project']({ projectId: project.id })).address
  const { session } = await ipc['session:open']({ ...address, mode: 'fresh' })
  const answer = await ipc['session:lookup']({
    ...address,
    sessionId: session.id,
    requestId: randomUUID(),
    query: 'Supplier'
  })
  script()
  await ipc['session:ask-fai']({
    ...address,
    sessionId: session.id,
    answerId: answer.id,
    requestId: randomUUID(),
    instruction: 'Compare the suppliers.'
  })
  await h.runtime.idle()
  return { req: await accept(ipc, chat), project, other, source: source! }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'faibots-accepted-result-'))
})
afterEach(async () => {
  await h.runtime.shutdown()
  h.cleanup()
  rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

it('saves an accepted supplier memo to its original Space once, checks its source and reopens the same immutable Page', async () => {
  let ipc = boot()
  const { req, project, other, source } = await scoped(ipc)
  const input = { ...req, projectId: project.id }
  expect((await ipc['content:work-destinations'](req)).projects.map((p) => p.id)).toEqual([project.id])
  expect(() => ipc['content:save-work']({ ...req, projectId: other.id })).toThrow(/provided its evidence/)
  const [a, b] = await Promise.all([ipc['content:save-work'](input), ipc['content:save-work'](input)])
  expect(a).toEqual(b)
  expect(a).toMatchObject({ name: 'Supplier comparison', workId: req.workId, partial: false })
  const read = { projectId: project.id, pageId: a.id }
  expect(await ipc['content:read-page'](read)).toMatchObject({
    body: memo,
    sources: [{ sha256: source.sha256 }],
    attribution: { workId: req.workId, ownerAccepted: true }
  })
  expect(() => ipc['content:read-page']({ ...read, projectId: other.id })).toThrow(/not found/)
  await h.runtime.shutdown()
  h.cleanup()
  ipc = boot()
  expect((await ipc['content:project']({ projectId: project.id })).pages).toEqual([a])
  expect(await ipc['content:save-work'](input)).toEqual(a)
  expect((await ipc['content:work-destinations'](req)).saved?.id).toBe(a.id)
  expect((await ipc['content:read-page'](read)).body).toBe(memo)
  const item = h.services.store.projectContent.pin(project.id, source.id).itemId
  await ipc['content:revoke']({ projectId: project.id, itemId: item })
  expect(() => ipc['content:save-work'](input)).toThrow()
  expect(() => ipc['content:read-page'](read)).toThrow()
  expect((await ipc['content:project']({ projectId: project.id })).pages[0]?.name).toBe(
    'Unavailable work result'
  )
  expect(await ipc['artifacts:list']({ projectId: project.id })).toEqual([])
  expect((await ipc['work:list']({ conversationId: req.conversationId }))[0]?.state).toBe('accepted')
  expect(h.services.store.artifacts.listByProject(project.id)).toHaveLength(1)
})

it('lets the owner choose the destination for plain accepted chat work and preserves a partial verdict', async () => {
  const ipc = boot()
  const chat = h.runtime.openDm(h.bot('fai', { isPrimary: true }).id).id
  const project = await ipc['projects:create']({ name: 'Logistics' })
  const other = await ipc['projects:create']({ name: 'Events' })
  script(true)
  await h.send(chat, 'Prepare a supplier memo with the unknowns.')
  const [review] = await ipc['work:list']({ conversationId: chat })
  expect(() =>
    ipc['content:save-work']({
      conversationId: chat,
      workId: review!.id,
      revision: review!.revision,
      projectId: project.id
    })
  ).toThrow(/owner-accepted/)
  const req = await accept(ipc, chat)
  expect((await ipc['content:work-destinations'](req)).projects.map((p) => p.id)).toEqual([
    project.id,
    other.id
  ])
  expect(() => ipc['content:save-work']({ ...req, projectId: 'missing' })).toThrow(/not found/)
  expect(() =>
    ipc['content:save-work']({
      ...req,
      conversationId: h.runtime.openDm(h.bot('Auditor').id).id,
      projectId: project.id
    })
  ).toThrow(/original fai chat/)
  const page = await ipc['content:save-work']({ ...req, projectId: other.id })
  expect(page.partial).toBe(true)
  expect(
    (await ipc['content:read-page']({ projectId: other.id, pageId: page.id })).attribution
  ).toMatchObject({ partial: true })
  expect(() => ipc['content:save-work']({ ...req, projectId: project.id })).toThrow(
    /different saved destination/
  )
})

it('refuses publication when source bytes changed before saving and leaves the accepted brief intact', async () => {
  const ipc = boot()
  const { req, project, source } = await scoped(ipc)
  writeFileSync(
    join(h.services.dataDir, 'attachments', source.sha256.slice(0, 16) + '-' + source.name),
    'Different bytes'
  )
  expect(() => ipc['content:save-work']({ ...req, projectId: project.id })).toThrow(/verified|source/i)
  expect((await ipc['content:project']({ projectId: project.id })).pages).toEqual([])
  expect(h.services.store.artifacts.listByProject(project.id)).toEqual([])
  expect((await ipc['work:list']({ conversationId: req.conversationId }))[0]?.state).toBe('accepted')
})

it('asks fai about only the selected owner-accepted Page with no sources, then reopens its exact revision', async () => {
  let ipc = boot()
  const chat = h.runtime.openDm(h.bot('fai', { isPrimary:true }).id).id
  const project = await ipc['projects:create']({ name:'Logistics' })
  const other = await ipc['projects:create']({ name:'Private project' })
  script(true)
  await h.send(chat,'Prepare a supplier memo with unknowns.')
  const saved = await ipc['content:save-work']({ ...await accept(ipc,chat), projectId:project.id })
  const request = { projectId:project.id, pageId:saved.id, revisionId:saved.revisionId, sha256:saved.sha256,
    requestId:randomUUID(), instruction:'Which supplier still owes a delivery date?' }
  await expect(ipc['session:ask-page']({...request,projectId:other.id})).rejects.toThrow(/Page/)
  await expect(ipc['session:ask-page']({...request,revisionId:randomUUID()})).rejects.toThrow(/revision/)
  const unreferenced = join(root,'unrelated.md')
  writeFileSync(unreferenced,'Unrelated private detail.')
  await ipc['projects:attach-notes']({projectId:project.id,paths:[unreferenced]})
  let reads = 0
  h.engine.script('fai', async ({tool,say}) => {
    const result = await tool('read_project_result',{})
    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content.find(p=>p.type==='text')!.text)
    expect(data.page).toMatchObject({id:saved.id,revisionId:saved.revisionId,sha256:saved.sha256,reviewer:'Owner',partial:true,body:memo,sources:[]})
    expect(JSON.stringify(data)).not.toMatch(/unrelated|Private project/)
    reads++
    say('Supplier B still owes a delivery date.')
  })
  const [one,two] = await Promise.all([ipc['session:ask-page'](request),ipc['session:ask-page'](request)])
  await h.runtime.idle()
  expect(one).toEqual(two)
  expect(reads).toBe(1)
  expect(h.services.store.db.prepare('select count(*) n from project_sessions').get()?.n).toBe(0)
  await h.runtime.shutdown()
  h.cleanup()
  ipc = boot()
  expect(await ipc['session:instruction'](one)).toBe(request.instruction)
  expect(readProjectResult(h.services.store,h.services,chat,one.entryId)?.page?.sha256).toBe(saved.sha256)
  const answer = h.services.store.entries.since(chat,0).find(entry =>
    entry.author.kind === 'bot' && entry.meta?.selectedResultEntryId === one.entryId)!
  script(false,true)
  await h.runtime.send({conversationId:chat,replyToId:answer.id,clientNonce:randomUUID(),text:'Prepare a follow-up memo.',
    mentions:[],mentionsEveryone:false,attachmentPaths:[]})
  await h.runtime.idle()
  const next = await accept(ipc,chat)
  expect((await ipc['content:work-destinations'](next)).projects.map(p => p.id)).toEqual([project.id])
  const derived = await ipc['content:save-work']({...next,projectId:project.id})
  const derivedEvidence = readPageEvidence(h.services.store,h.services,project.id,derived.id)
  expect(derivedEvidence.parentPages).toEqual([{id:saved.id,revisionId:saved.revisionId,name:saved.name,sha256:saved.sha256}])
  h.services.store.db.prepare("update accepted_work_pages set body='Unverified replacement' where id=?").run(saved.id)
  expect(await ipc['session:instruction'](one)).toBeNull()
  await expect(ipc['session:ask-page'](request)).rejects.toThrow(/revision/)
  expect(() => readPageEvidence(h.services.store,h.services,project.id,derived.id)).toThrow()
})

it('traces the attachment actually used by a saved chat Page and refuses changed bytes', async () => {
  const ipc = boot()
  const chat = h.runtime.openDm(h.bot('fai',{isPrimary:true}).id).id
  const project = await ipc['projects:create']({name:'Shipping'})
  const path = join(root,'shipping-note.txt')
  writeFileSync(path,'The supplier promised to call on Tuesday.')
  script()
  await h.runtime.send({conversationId:chat,clientNonce:randomUUID(),text:'Prepare delivery notes.',
    mentions:[],mentionsEveryone:false,attachmentPaths:[path]})
  await h.runtime.idle()
  const req = await accept(ipc,chat)
  const page = await ipc['content:save-work']({...req,projectId:project.id})
  const attached = h.services.store.entries.since(chat,0).find(entry => entry.attachments.length)!.attachments[0]!
  const evidence = readPageEvidence(h.services.store,h.services,project.id,page.id)
  expect(evidence.attachments).toEqual([{name:attached.name,sha256:attached.sha256}])
  expect(evidence.sources).toEqual([])
  writeFileSync(attached.path,'Changed attached content.')
  expect(() => readPageEvidence(h.services.store,h.services,project.id,page.id)).toThrow()
})

it('rechecks original sources before releasing a selected Page reply, including after its final tool read', async () => {
  const ipc = boot()
  const {req,project,source} = await scoped(ipc)
  const page = await ipc['content:save-work']({...req,projectId:project.id})
  const request = {projectId:project.id,pageId:page.id,revisionId:page.revisionId,sha256:page.sha256,
    requestId:randomUUID(),instruction:'Discuss this Page.'}
  let verified = false
  h.engine.script('fai',async ({tool,say}) => {
    const result = await tool('read_project_result',{})
    const data = JSON.parse(result.content.find(p=>p.type==='text')!.text)
    expect(data.page.sources).toMatchObject([{sourceId:source.id,sha256:source.sha256,revision:1}])
    verified = true
    say('Private reply before withdrawal.')
    const store = h.services.store
    store.projectContent.revoke(project.id,store.projectContent.pin(project.id,source.id).itemId)
    say('Private reply after withdrawal.')
  })
  const response = await ipc['session:ask-page'](request)
  await h.runtime.idle()
  expect(verified).toBe(true)
  expect(await ipc['session:instruction'](response)).toBeNull()
  expect(JSON.stringify(h.services.store.entries.since(req.conversationId,0))).not.toContain('Private reply')
  expect(JSON.stringify(h.services.bus.events)).not.toContain('Private reply')
})

it('rolls back artifacts and reviews if publication fails, retries cleanly and detects altered stored bytes', async () => {
  const ipc = boot()
  const { req, project } = await scoped(ipc)
  const input = { ...req, projectId: project.id }
  const store = h.services.store
  store.db.exec(
    "create trigger injected_page_failure before insert on accepted_work_pages begin select raise(abort,'synthetic failure'); end"
  )
  expect(() => ipc['content:save-work'](input)).toThrow(/synthetic failure/)
  expect(store.artifacts.listByProject(project.id)).toEqual([])
  expect(store.db.prepare('select count(*) as n from review_decisions').get()?.n).toBe(0)
  expect((await ipc['work:list']({ conversationId: req.conversationId }))[0]?.state).toBe('accepted')
  store.db.exec('drop trigger injected_page_failure')
  const page = await ipc['content:save-work'](input)
  store.db.prepare('update accepted_work_pages set body=? where id=?').run('tampered', page.id)
  expect(() => ipc['content:read-page']({ projectId: project.id, pageId: page.id })).toThrow(
    /no longer matches/
  )
  expect(() => ipc['content:save-work'](input)).toThrow(/no longer matches/)
  expect(store.artifacts.listByProject(project.id)).toHaveLength(1)
})
