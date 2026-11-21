import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../agent/testing/fakes'
import { projectResultTool } from '../agent/project-result-tool'
import { turnPrompt } from '../agent/external-common'
import { createAttachmentStore } from '../attachments/attachments'
import { createSnapshotService } from '../attachments/snapshots'
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
  h.engine.script(chief.handle, async ({ turn, tool, say }) => {
    expect(turn.tools.map((t) => t.name)).toContain('read_project_result')
    expect(turn.context.engineSessionId).toBeUndefined()
    expect(turn.context.summary).toBe('')
    expect(turnPrompt(turn, store, true).text).not.toMatch(/ordinary earlier|unrelated summary|blue marker/i)
    first = JSON.stringify(await tool('read_project_result', {}))
    store.projectContent.select(
      scope.projectId,
      store.projectContent.pin(scope.projectId, source.id).itemId,
      false
    )
    second = JSON.stringify(await tool('read_project_result', {}))
    turn.saveContext({ engineSessionId: 'restricted-thread', summary: 'restricted summary' })
    say('The selected answer quoted West entrance.')
  })
  const [one, two] = await Promise.all([ipc['session:ask-fai'](request), ipc['session:ask-fai'](request)])
  expect(one).toEqual(two)
  await h.runtime.idle()
  expect(first).toContain('Gate: West entrance')
  expect(first).not.toMatch(/blue marker/i)
  expect(second).toContain('"isError":true')
  expect(second).not.toMatch(/fixture-notes|west entrance/)
  expect(h.engine.turns).toHaveLength(2)
  expect(store.botContext.get(dm.id, chief.id)).toMatchObject({
    engineSessionId: 'ordinary-private-thread',
    summary: 'unrelated summary'
  })
  const entries = store.entries.since(dm.id, 0)
  expect(entries.filter((e) => e.kind === 'tool-call').map((e) => e.toolCall?.resultText)).toEqual([
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
    if (!turn.selectedResultTrigger) {
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
