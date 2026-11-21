import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Services } from '../contracts'
import { createAttachmentStore } from '../attachments/attachments'
import { createSnapshotService } from '../attachments/snapshots'
import { openStore, type PlatformStore } from '../store'
import { projectSessionHandlers } from './project-sessions'

let root: string, store: PlatformStore
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'faibots-session-'))
  store = openStore(join(root, 'fixture.db'), { homeDir: root })
  store.bots.create({ name: 'fai', isPrimary: true })
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function fixture() {
  const a = store.projects.create({ name: 'Conference' })
  const b = store.projects.create({ name: 'Conference' })
  const attachments = createAttachmentStore({ dataDir: root })
  const complete = vi.fn(async () => 'The signed notice says Tuesday [notice.md r1 line 1].')
  const providers = {
    resolve: () => ({ engine: 'native', provider: {}, modelId: 'test' }),
    adapterFor: () => ({ complete })
  }
  const services = { dataDir: root, attachments, providers } as unknown as Services
  const handlers = projectSessionHandlers(services, store)
  const scope = (id: string) => handlers['session:project']({ projectId: id }).address
  const attach = (projectId: string, name: string, text: string) => {
    const path = join(root, name)
    writeFileSync(path, text)
    return createSnapshotService({
      attachments,
      projects: store.projects,
      projectSources: store.projectSources
    }).attach(projectId, [path])[0]!
  }
  const start = (projectId: string) => handlers['session:open']({ ...scope(projectId), mode: 'fresh' }).session
  const ask = (projectId: string, sessionId: string, query: string, useModel = false) =>
    handlers['session:lookup']({
      ...scope(projectId),
      sessionId,
      query,
      useModel,
      requestId: randomUUID()
    })
  return { a, b, scope, attach, start, ask, complete, services, handlers }
}

it('continues saved results after reopening the database; fresh and incompatible sessions never reuse private or external history', async () => {
  const { a, b, scope, start, ask, handlers, services, attach } = fixture()
  attach(a.id, 'notice.md', 'Door: North entrance')
  attach(b.id, 'notice-b.md', 'Door: East entrance')
  const first = start(a.id),
    other = start(b.id),
    main = store.bots.list()[0]!
  const dm = store.conversations.create({ kind: 'dm', botIds: [main.id], title: 'Private' })
  store.botContext.set({
    conversationId: dm.id,
    botId: main.id,
    summary: 'private material',
    lastSeenSeq: 12,
    summarizedUpToSeq: 12,
    engineSessionId: 'foreign-thread'
  })
  const answer = await ask(a.id, first.id, 'Door')
  expect(answer.citations[0]?.excerpt).toBe('Door: North entrance')
  expect(JSON.stringify(answer)).not.toMatch(/private material|foreign-thread|East entrance/)
  const target = scope(a.id)
  expect(() => handlers['session:open']({ ...target, sessionId: other.id, mode: 'continue' })).toThrow(
    /different project/
  )
  expect(() =>
    handlers['session:open']({ ...target, hostId: 'forged', sessionId: first.id, mode: 'continue' })
  ).toThrow(/host/)
  expect(() =>
    handlers['session:open']({ ...target, environmentId: 'forged', sessionId: first.id, mode: 'continue' })
  ).toThrow(/environment/)
  expect(() =>
    handlers['session:open']({ ...target, projectId: 'absent', sessionId: first.id, mode: 'continue' })
  ).toThrow(/Unknown project/)
  expect(handlers['session:open']({ ...target, mode: 'fresh' }).history).toEqual([])
  store.close()
  store = openStore(join(root, 'fixture.db'), { homeDir: root })
  const restart = projectSessionHandlers(services, store)
  expect(restart['session:project']({ projectId: a.id }).address).toEqual(target)
  expect(restart['session:open']({ ...target, sessionId: first.id, mode: 'continue' }).history[0]?.id).toBe(
    answer.id
  )
  store.bots.update(main.id, { model: { providerId: 'new-provider', modelId: 'different-engine' } })
  expect(() => restart['session:open']({ ...target, sessionId: first.id, mode: 'continue' })).toThrow(
    /model changed/
  )
  const fork = restart['session:open']({
    ...target,
    mode: 'fork',
    parentId: first.id,
    parentProjectId: a.id,
    answerIds: [answer.id]
  })
  expect(fork.history[0]).toMatchObject({ id: answer.id, ownerId: main.id, sessionId: first.id, projectId: a.id })
  expect(fork.session.id).not.toBe(first.id)
})

it('forks just selected, currently granted results and never moves ownership or old engine checkpoint', async () => {
  const { a, b, scope, start, ask, handlers, attach } = fixture()
  const one = attach(a.id, 'notice.md', 'Door: North entrance\nTime: Noon')
  const item = store.projectContent.pin(a.id, one.id).itemId
  const first = start(a.id)
  const [door, time] = await Promise.all([ask(a.id, first.id, 'Door'), ask(a.id, first.id, 'Time')])
  const fork = {
    ...scope(b.id),
    mode: 'fork' as const,
    parentId: first.id,
    parentProjectId: a.id,
    answerIds: [time.id]
  }
  expect(() => handlers['session:open'](fork)).toThrow(/selection/)
  store.projectContent.share(a.id, item, b.id)
  expect(() => handlers['session:open'](fork)).toThrow(/selection/)
  store.projectContent.select(b.id, item, true)
  const result = handlers['session:open'](fork)
  expect(result.history.map((r) => r.id)).toEqual([time.id])
  expect(result.history[0]?.projectId).toBe(a.id)
  expect(result.session.projectId).toBe(b.id)
  expect(result.session.parentId).toBe(first.id)
  expect(JSON.stringify(result.history)).not.toContain(door.id)
  expect(() => handlers['session:open']({ ...fork, answerIds: [randomUUID()] })).toThrow(/parent session/)
  store.projectContent.revoke(a.id, item, b.id)
  expect(() =>
    handlers['session:open']({ ...scope(b.id), mode: 'continue', sessionId: result.session.id })
  ).toThrow(/permissions changed/)
  expect(handlers['session:history']({ ...scope(b.id), sessionId: result.session.id })).toEqual({
    history: [],
    omittedHistory: 1
  })
})

it('preserves native citations and conflict with the graph disconnected; detects missing bytes, a stale revision, and private sources', async () => {
  const { a, b, scope, start, ask, handlers, attach, complete } = fixture()
  const first = attach(a.id, 'schedule.md', 'Deadline: Tuesday')
  const second = attach(a.id, 'announcement.md', 'Deadline: Friday')
  attach(b.id, 'private.md', 'Deadline: Monday')
  const s = start(a.id)
  const found = await ask(a.id, s.id, 'What is the deadline?', true)
  expect(found.status).toBe('conflict')
  expect(found.citations.map((c) => [c.source.revision, c.line, c.source.sha256])).toEqual([
    [1, 1, first.sha256],
    [1, 1, second.sha256]
  ])
  expect(found.conflicts[0]).toMatch(/tuesday.*friday/)
  expect(JSON.stringify(found)).not.toContain('Monday')
  expect(complete).not.toHaveBeenCalled()
  const copy = join(root, 'attachments', first.sha256.slice(0, 16) + '-' + first.name)
  writeFileSync(copy, 'stale bytes')
  const again = await ask(a.id, s.id, 'Deadline')
  expect(again.citations.map((c) => c.excerpt)).toEqual(['Deadline: Friday'])
  expect(again.omissions[0]).toMatch(/schedule.md.*could not be verified/)
  expect(await ask(a.id, s.id, 'Nonexistent')).toMatchObject({ status: 'unavailable', citations: [] })
  expect(handlers['session:history']({ ...scope(a.id), sessionId: s.id }).omittedHistory).toBeGreaterThan(0)
  const current = store.projectContent.pin(a.id, first.id)
  store.projectContent.select(a.id, current.itemId, false)
  expect(() => handlers['session:open']({ ...scope(a.id), sessionId: s.id, mode: 'continue' })).toThrow(
    /source revisions or permissions changed/
  )
})

it('asks only the configured native model when requested and rechecks access before delivering its response', async () => {
  const { a, scope, start, ask, handlers, attach, complete } = fixture()
  const source = attach(a.id, 'notice.md', 'Day: Tuesday'),
    s = start(a.id)
  const receipt = await ask(a.id, s.id, 'Day', true)
  expect(complete).toHaveBeenCalledOnce()
  expect(receipt.modelReply).toContain('Tuesday')
  const req = { ...scope(a.id), sessionId: s.id, query: 'Day', useModel: true, requestId: randomUUID() }
  const item = store.projectContent.pin(a.id, source.id).itemId
  complete.mockImplementationOnce(async () => {
    store.projectContent.revoke(a.id, item)
    return 'Withheld'
  })
  await expect(handlers['session:lookup'](req)).rejects.toThrow(/permissions changed/)
  expect(store.db.prepare('select 1 from project_answers where id=?').get(req.requestId)).toBeUndefined()
})
