import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { INVOKE_CHANNELS, type InvokeMap } from '@shared/ipc'
import type { Services } from '../contracts'
import { createAttachmentStore } from '../attachments/attachments'
import { MAX_NOTE_BYTES } from '../attachments/snapshots'
import { openStore, type PlatformStore } from '../store'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const handle = vi.fn()
vi.mock('electron', () => ({
  app: { getName: () => 'FaiBots', getVersion: () => '0.1.0' },
  BrowserWindow: class {},
  ipcMain: { handle: (...args: unknown[]) => handle(...args) },
  dialog: {},
  Notification: class {},
  safeStorage: { isEncryptionAvailable: () => true }
}))

const { buildHandlers, registerHandlers } = await import('./handlers')

describe('IPC handlers', () => {
  it('cover exactly the allowlisted invoke channels, and register only those', () => {
    const table = buildHandlers({} as Services, () => null)
    expect(Object.keys(table).sort()).toEqual([...INVOKE_CHANNELS].sort())
    registerHandlers(table)
    expect(handle.mock.calls.map((c) => c[0]).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('pass errors to the renderer as plain messages', async () => {
    handle.mockClear()
    const failing = { store: { bots: { list: () => { throw new Error('boom') } } } } as unknown as Services
    registerHandlers(buildHandlers(failing, () => null))
    const listener = handle.mock.calls.find((c) => c[0] === 'bots:list')![1] as (e: unknown, req: unknown) => Promise<unknown>
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(listener({}, undefined)).rejects.toThrow('boom')
    spy.mockRestore()
  })

  it('validate group member changes', () => {
    const conversations = new Map([
      ['g', { id: 'g', kind: 'group', botIds: ['a'], group: {} }],
      ['d', { id: 'd', kind: 'dm', botIds: ['a'] }]
    ])
    const services = {
      store: {
        conversations: { get: (id: string) => conversations.get(id), update: vi.fn((id: string) => conversations.get(id)) },
        bots: { get: (id: string) => (id === 'missing' ? undefined : { id }) }
      },
      runtime: { stop: vi.fn() },
      bus: { emit: vi.fn() }
    } as unknown as Services
    const update = buildHandlers(services, () => null)['conv:update']
    expect(() => update({ id: 'd', patch: { botIds: ['a', 'b'] } })).toThrow(/Only group/)
    expect(() => update({ id: 'g', patch: { botIds: ['a', 'missing'] } })).toThrow(/Bot not found/)
    expect(() => update({ id: 'g', patch: { botIds: Array.from({ length: 9 }, (_, i) => `b${i}`) } })).toThrow(/at most/)
    expect(() => update({ id: 'g', patch: { botIds: [] } })).toThrow(/at least one/)
    expect(() => update({ id: 'g', patch: { botIds: ['a', 'a'] } })).toThrow(/once/)
    update({ id: 'g', patch: { botIds: ['a', 'b'] } })
    expect(services.store.conversations.update).toHaveBeenCalledWith('g', { botIds: ['a', 'b'] })
    expect(services.runtime.stop).not.toHaveBeenCalled()
    update({ id: 'g', patch: { botIds: ['b'] } })
    expect(services.runtime.stop).toHaveBeenCalledWith('g')
  })
})

describe('journey handlers (M1b)', () => {
  let dir: string
  let store: PlatformStore
  let services: Services

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-journey-ipc-'))
    store = openStore(join(dir, 'test.db'), { homeDir: dir })
    services = {
      store,
      attachments: createAttachmentStore({ dataDir: dir }),
      bus: { emit: vi.fn() }
    } as unknown as Services
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const journey = () =>
    buildHandlers(services, () => null) as unknown as {
      [C in keyof InvokeMap]: (req: InvokeMap[C]['req']) => InvokeMap[C]['res']
    }

  const note = (name: string, body: string | Buffer): string => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  it('creates, lists and gets projects', () => {
    const created = journey()['projects:create']({ name: '  Launch  ', description: 'ship the app' })
    expect(created).toMatchObject({ name: 'Launch', description: 'ship the app' })
    expect(journey()['projects:list'](undefined)).toEqual([created])
    expect(journey()['projects:get']({ id: created.id })).toEqual(created)
    expect(() => journey()['projects:get']({ id: 'missing' })).toThrow(/Project not found/)
    expect(() => journey()['projects:create']({ name: '   ' })).toThrow(/needs a name/)
  })

  it('attaches picked notes through the snapshot service and lists them as sources', () => {
    const project = journey()['projects:create']({ name: 'Notes' })
    const sources = journey()['projects:attach-notes']({
      projectId: project.id,
      paths: [note('brief.md', '# brief'), note('notes.txt', 'raw')]
    })
    expect(sources.map((s) => s.name).sort()).toEqual(['brief.md', 'notes.txt'])
    expect(sources[0]).toMatchObject({ projectId: project.id, kind: 'md', sha256: sha('# brief') })
    // The sources are the same rows the store lists for the project.
    expect(journey()['projects:list-sources']({ projectId: project.id }).map((s) => s.id).sort()).toEqual(
      sources.map((s) => s.id).sort()
    )
    expect(() => journey()['projects:attach-notes']({ projectId: project.id, paths: [] })).toThrow(/at least one note/)
  })

  it('surfaces note errors cleanly: wrong type, over 10 MB, unknown project', () => {
    const project = journey()['projects:create']({ name: 'P' })
    expect(() => journey()['projects:attach-notes']({ projectId: project.id, paths: [note('x.docx', 'nope')] })).toThrow(
      /Markdown \(.md\), plain text \(.txt\) or PDF/
    )
    expect(() =>
      journey()['projects:attach-notes']({ projectId: project.id, paths: [note('big.md', 'x'.repeat(MAX_NOTE_BYTES + 1))] })
    ).toThrow(/10 MB or smaller/)
    expect(() => journey()['projects:attach-notes']({ projectId: 'missing', paths: [note('a.md', 'a')] })).toThrow(
      /Project not found/
    )
    // Nothing was stored after any failed attach.
    expect(journey()['projects:list-sources']({ projectId: project.id })).toEqual([])
  })

  it('lists artifacts with their revisions and reviews, oldest first', () => {
    const project = journey()['projects:create']({ name: 'P' })
    const artifact = store.artifacts.create({ projectId: project.id, name: 'plan.md' })
    const r1 = store.artifacts.createRevision({ artifactId: artifact.id, sha256: sha('a') })
    const r2 = store.artifacts.createRevision({
      artifactId: artifact.id,
      sha256: sha('b'),
      provenance: { projectId: project.id, note: 'second pass' }
    })
    const decision = store.artifacts.addReview({ artifactRevisionId: r2.id, rubric: 'r', reviewer: 'user', decision: 'accepted' })
    expect(journey()['artifacts:list']({ projectId: project.id })).toEqual([
      { artifact, revisions: [{ ...r1, reviews: [] }, { ...r2, reviews: [decision] }] }
    ])
    expect(() => journey()['artifacts:list']({ projectId: 'missing' })).toThrow(/Project not found/)
  })

  it('starts a mission through the mission service and lists runs, validating the project', () => {
    const project = journey()['projects:create']({ name: 'P' })
    const run = { id: 'run-1', projectId: project.id, status: 'working', budgets: {}, startedAt: Date.now() }
    const missions = { start: vi.fn(() => run), runs: vi.fn(() => [run]) }
    const handlers = buildHandlers({ ...services, missions } as unknown as Services, () => null)
    expect(handlers['projects:start-mission']({ projectId: project.id })).toEqual(run)
    expect(missions.start).toHaveBeenCalledWith(project.id)
    expect(handlers['projects:list-runs']({ projectId: project.id })).toEqual([run])
    expect(missions.runs).toHaveBeenCalledWith(project.id, undefined)
    expect(() => handlers['projects:list-runs']({ projectId: 'missing' })).toThrow(/Project not found/)
  })
})
