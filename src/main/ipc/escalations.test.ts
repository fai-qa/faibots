import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Services, ToolContext } from '../contracts'
import type { Bot, Conversation } from '@shared/domain'
import type { HandoffRequest } from '@shared/escalations'
import { createPlatformServices } from '../platform-services'
import { createRuntimeServices } from '../runtime-services'
import type { PlatformStore } from '../store'
import { fakeBus, fakeCipher } from '../store/test-helpers'
import { getHandoffCheckpoint, prepareHandoff } from '../store/escalations'
import { createSnapshotService } from '../attachments/snapshots'
import { projectSessionHandlers } from './project-sessions'
import { escalationHandlers } from './escalations'

let root: string, s: Services, store: PlatformStore
function boot() {
  const bus = fakeBus(),
    dataDir = join(root, 'profile')
  const platform = createPlatformServices({ dataDir, bus, cipher: fakeCipher, homeDir: join(root, 'home') })
  const base = { ...platform, bus, dataDir }
  s = { ...base, ...createRuntimeServices(base) }
  store = s.store as PlatformStore
}
async function close() {
  await s.routines.shutdown()
  await s.runtime.shutdown()
  await s.mcp.shutdown()
  await s.bridge.shutdown()
  s.store.close()
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'faibots-handoff-'))
  boot()
})
afterEach(async () => {
  await close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})
function fixture() {
  const chief =
    store.bots.list().find((b) => b.isPrimary && b.name === 'fai') ??
    store.bots.create({ name: 'fai', isPrimary: true })
  const editor = store.bots.create({ name: 'Rowan' }),
    chat = s.runtime.openDm(editor.id),
    chiefChat = s.runtime.openDm(chief.id)
  const text = 'Hidden first. The entrance opens Tuesday. Hidden last.'
  const add = (value: string) =>
    store.entries.append({
      conversationId: chat.id,
      kind: 'message',
      author: { kind: 'bot', botId: editor.id },
      text: value,
      attachments: [],
      mentions: [],
      mentionsEveryone: false,
      isStreaming: false
    })
  add('Unrelated private conversation.')
  const selected = add(text),
    start = text.indexOf('The entrance'),
    end = text.indexOf(' Hidden last')
  const req: HandoffRequest = {
    id: randomUUID(),
    sourceChatId: chat.id,
    question: 'Confirm the entrance date.',
    selections: [{ entryId: selected.id, start, end, expectedText: text.slice(start, end) }]
  }
  return { chief, editor, chat, chiefChat, req, selected }
}
function ctx(bot: Bot, conversation: Conversation): ToolContext {
  return {
    bot,
    conversation,
    callId: 'fixture-call',
    turnId: 'fixture-turn',
    actionId: 'fixture-action',
    signal: new AbortController().signal,
    chain: [],
    inGroup: false,
    workspaceDir: root
  }
}
function addWork(chatId: string, entryId: string) {
  // The native brief module belongs to the integration branch. Exercise its exact persisted contract.
  store.db.exec(
    `create table if not exists chief_work (id text primary key,conversation_id text not null,user_entry_id text not null,objective text not null,deliverable text not null,checks text not null,state text not null,revision integer not null,updated_at integer not null)`
  )
  if (!store.entries.get(entryId))
    store.entries.append({
      id: entryId,
      conversationId: chatId,
      kind: 'message',
      author: { kind: 'user' },
      text: 'Original work',
      attachments: [],
      mentions: [],
      mentionsEveryone: false,
      isStreaming: false
    })
  const workId = randomUUID()
  store.db
    .prepare(
      "insert into chief_work (id,conversation_id,user_entry_id,objective,deliverable,checks,state,revision,updated_at) values (?,?,?,'Entrance date','Date','Signed notice','active',1,0)"
    )
    .run(workId, chatId, entryId)
  return workId
}
it('lets the owner escalate exact excerpts once, uses the actual chief DM, preserves source authors and does not offer the tool to a specialist', async () => {
  const { chief, editor, chat, chiefChat, req, selected } = fixture()
  const handlers = escalationHandlers(s, store)
  await expect(
    handlers['handoff:send']({
      ...req,
      id: randomUUID(),
      selections: [{ ...req.selections[0]!, expectedText: 'Words from a different message.' }]
    })
  ).rejects.toThrow(/original words changed/)
  const [a, b] = await Promise.all([handlers['handoff:send'](req), handlers['handoff:send'](req)])
  expect(a.destinationEntryId).toBe(b.destinationEntryId)
  expect(
    store.entries.since(chiefChat.id, 0).filter((e) => e.clientNonce === 'escalation-' + req.id)
  ).toHaveLength(1)
  expect(store.entries.get(a.destinationEntryId!)!.text).not.toMatch(/Tuesday|Hidden|Unrelated/)
  expect(await s.tools.forTurn(ctx(editor, chat))).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'read_handoff' })])
  )
  expect(await s.tools.execute('read_handoff', { id: req.id }, ctx(editor, chat))).toMatchObject({ isError: true })
  const read = await s.tools.execute('read_handoff', { id: req.id }, ctx(chief, chiefChat))
  expect(JSON.stringify(read)).toContain('The entrance opens Tuesday.')
  expect(JSON.stringify(read)).not.toMatch(/Unrelated private|Hidden first|Hidden last/)
  expect(store.actions.get('fixture-action')).toBeUndefined()
  expect(getHandoffCheckpoint(store, chat.id, { handoffId: req.id }, s)).toEqual([])
  expect(
    getHandoffCheckpoint(store, chiefChat.id, { userEntryId: a.destinationEntryId }, s)[0]?.excerpts?.[0]
  ).toMatchObject({ entryId: selected.id, authorId: editor.id })
  store.entries.update(selected.id, { text: 'Source was replaced.' })
  expect(getHandoffCheckpoint(store, chiefChat.id, { handoffId: req.id }, s)[0]).toMatchObject({
    availability: 'withheld'
  })
  expect(
    JSON.stringify(await s.tools.execute('read_handoff', { id: req.id }, ctx(chief, chiefChat)))
  ).not.toContain('Tuesday')
  expect(store.bots.get(editor.id)?.isPrimary).toBe(false)
})
it('verifies the exact project/host/source/work scope before dispatch and again after cold restart and model context rollover', async () => {
  const { chief, editor, chat, chiefChat, req } = fixture()
  const project = store.projects.create({ name: 'Venue' })
  const path = join(root, 'notice.md')
  writeFileSync(path, 'Deadline: Tuesday')
  const [selected] = createSnapshotService({
    attachments: s.attachments,
    projects: store.projects,
    projectSources: store.projectSources
  }).attach(project.id, [path])
  const ph = projectSessionHandlers(s, store),
    address = ph['session:project']({ projectId: project.id }).address
  const session = ph['session:open']({ ...address, mode: 'fresh' }).session
  req.scope = { ...address, sessionId: session.id }
  const workId = addWork(chiefChat.id, randomUUID())
  req.work = { id: workId, revision: 1 }
  const h = escalationHandlers(s, store)
  await expect(
    h['handoff:send']({ ...req, id: randomUUID(), scope: { ...req.scope, hostId: 'wrong' } })
  ).rejects.toThrow(/host/)
  await expect(
    h['handoff:send']({ ...req, id: randomUUID(), work: { id: randomUUID(), revision: 1 } })
  ).rejects.toThrow(/work/)
  await expect(
    h['handoff:send']({ ...req, id: randomUUID(), work: { id: workId, revision: 99 } })
  ).rejects.toThrow(/changed/)
  const result = await h['handoff:send'](req)
  const noVerification = getHandoffCheckpoint(store, chiefChat.id, { workId })[0]
  expect(noVerification).toMatchObject({ availability: 'withheld', workId })
  store.botContext.set({
    conversationId: chat.id,
    botId: editor.id,
    summary: 'Private specialist summary',
    lastSeenSeq: 100,
    summarizedUpToSeq: 100,
    engineSessionId: 'do-not-copy-thread'
  })
  store.botContext.set({
    conversationId: chiefChat.id,
    botId: chief.id,
    summary: 'Chief context rolled over',
    lastSeenSeq: 90,
    summarizedUpToSeq: 90
  })
  await close()
  boot()
  const checkpoint = getHandoffCheckpoint(store, chiefChat.id, { workId }, s)[0]!
  expect(checkpoint).toMatchObject({
    availability: 'available',
    chiefId: chief.id,
    specialistId: editor.id,
    scope: req.scope,
    workId,
    workRevision: 1,
    destinationEntryId: result.destinationEntryId,
    sources: [{ sourceId: selected!.id, revision: 1, sha256: selected!.sha256 }]
  })
  expect(JSON.stringify(checkpoint)).not.toMatch(/Private specialist summary|do-not-copy-thread|Hidden last/)
  s.tools.setPermission('read_handoff', 'never', chief.id)
  expect((await s.tools.execute('read_handoff', { id: result.id }, ctx(chief, chiefChat))).isError).toBe(true)
  expect(store.bots.get(chief.id)?.toolPermissions.read_handoff).toBe('never')
  expect(getHandoffCheckpoint(store, chiefChat.id, { workId }, s)[0]).toMatchObject({
    availability: 'withheld',
    reason: expect.stringMatching(/turned off/)
  })
  s.tools.setPermission('read_handoff', 'always', chief.id)
  const target = store.projects.create({ name: 'Venue' })
  const otherScope = projectSessionHandlers(s, store)['session:project']({ projectId: target.id }).address
  const other = projectSessionHandlers(s, store)['session:open']({ ...otherScope, mode: 'fresh' }).session
  await expect(
    escalationHandlers(s, store)['handoff:send']({
      ...req,
      id: randomUUID(),
      scope: { ...otherScope, sessionId: other.id }
    })
  ).rejects.toThrow(/already has a handoff/)
  store.projectContent.revoke(project.id, selected!.id)
  expect(getHandoffCheckpoint(store, chiefChat.id, { workId }, s)[0]).toMatchObject({ availability: 'withheld' })
  expect(JSON.stringify(getHandoffCheckpoint(store, chiefChat.id, { workId }, s))).not.toContain(
    'The entrance opens Tuesday.'
  )
  store.projectContent.restore(project.id, selected!.id)
  store.projectContent.select(project.id, selected!.id, true)
  writeFileSync(
    join(s.dataDir, 'attachments', selected!.sha256.slice(0, 16) + '-' + selected!.name),
    'Changed snapshot.'
  )
  expect(getHandoffCheckpoint(store, chiefChat.id, { workId }, s)[0]).toMatchObject({
    availability: 'withheld',
    reason: expect.stringMatching(/snapshot no longer matches/)
  })
})

it('recovers an interrupted handoff once and discovers work created from the delivered message without treating it as accepted', async () => {
  const { req, chiefChat, chat } = fixture()
  const prepared = prepareHandoff(store, req, chiefChat.id, s)
  expect(prepared.destinationEntryId).toBeUndefined()
  await close()
  boot()
  const h = escalationHandlers(s, store)
  expect(h['handoff:options']({ sourceChatId: chat.id }).receipts[0]?.id).toBe(req.id)
  const sent = await h['handoff:resume']({ sourceChatId: chat.id, id: req.id })
  const again = await h['handoff:resume']({ sourceChatId: chat.id, id: req.id })
  expect(again.destinationEntryId).toBe(sent.destinationEntryId)
  const workId = addWork(chiefChat.id, sent.destinationEntryId!)
  expect(getHandoffCheckpoint(store, chiefChat.id, { workId }, s)[0]).toMatchObject({
    id: req.id,
    workId,
    availability: 'available'
  })
  store.db.prepare("update chief_work set state='cancelled', revision=revision+1 where id=?").run(workId)
  expect(getHandoffCheckpoint(store, chiefChat.id, { workId }, s)[0]).toMatchObject({
    id: req.id,
    workId,
    availability: 'withheld'
  })
  expect(store.db.prepare('select state from chief_work where id=?').get(workId)?.state).toBe('cancelled')
})
