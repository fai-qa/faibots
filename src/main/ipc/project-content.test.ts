import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAttachmentStore } from '../attachments/attachments'
import { pdfFixture } from '../attachments/testing/pdf-fixture'
import { createSnapshotService } from '../attachments/snapshots'
import type { Services } from '../contracts'
import { openStore, type PlatformStore } from '../store'
import { projectContentHandlers } from './project-content'

describe('project content through its desktop handlers', () => {
  let root: string, store: PlatformStore
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'faibots-content-'))
    store = openStore(':memory:', { homeDir: root })
  })
  afterEach(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  function fixture(name = 'handoff.md', contents: string | Buffer = 'First revision.') {
    const a = store.projects.create({ name: 'Source owner' }),
      b = store.projects.create({ name: 'Recipient' })
    const attachments = createAttachmentStore({ dataDir: root })
    const handlers = projectContentHandlers(
      { dataDir: root, attachments, bus: { emit: vi.fn() } } as unknown as Services,
      store
    )
    const path = join(root, name)
    writeFileSync(path, contents)
    const [source] = createSnapshotService({
      attachments,
      projectSources: store.projectSources,
      projects: store.projects
    }).attach(a.id, [path])
    return { a, b, path, source: source!, handlers }
  }
  it('previews PDF text from the original version and rechecks access after extraction', async () => {
    const { a, b, source, handlers } = fixture('handoff.pdf', pdfFixture('Venue: Cedar'))
    const item = store.projectContent.pin(a.id, source.id).itemId
    const req = { projectId: b.id, sourceId: source.id }
    handlers['content:share']({ projectId: a.id, targetProjectId: b.id, itemId: item })
    expect(await handlers['content:read-source'](req)).toEqual({ text: 'Venue: Cedar', sha256: source.sha256 })
    const pending = handlers['content:read-source'](req)
    handlers['content:revoke']({ projectId: a.id, targetProjectId: b.id, itemId: item })
    await expect(pending).rejects.toThrow(/access/)
    writeFileSync(join(root, 'attachments', source.sha256.slice(0, 16) + '-' + source.name), 'tampered')
    await expect(handlers['content:read-source']({ projectId: a.id, sourceId: source.id })).rejects.toThrow(/snapshot/)
  })

  it('requires a grant and explicit selection; checks current access at every version read', async () => {
    const { a, b, path, source, handlers } = fixture()
    const read = handlers['content:read-source']
    await expect(read({ projectId: b.id, sourceId: source.id })).rejects.toThrow(/access/)
    const [first] = store.projectContent.library(a.id)
    handlers['content:share']({ projectId: a.id, targetProjectId: b.id, itemId: first!.itemId })
    expect(store.projectContent.library(b.id)[0]).toMatchObject({ readable: true, selected: false })
    handlers['content:select']({ projectId: b.id, itemId: first!.itemId, selected: true })
    writeFileSync(path, 'Second revision.')
    handlers['content:revise']({ projectId: a.id, itemId: first!.itemId, path })
    const item = store.projectContent.library(b.id)[0]!
    expect(item.revision).toBe(2)
    expect(item.versions.map((v) => v.revision)).toEqual([2, 1])
    expect((await read({ projectId: b.id, sourceId: source.id })).text).toBe('First revision.')
    expect((await read({ projectId: b.id, sourceId: item.source.id })).text).toBe('Second revision.')
    expect(() => handlers['content:revise']({ projectId: b.id, itemId: item.itemId, path })).toThrow(/owning/)
    handlers['content:revoke']({ projectId: a.id, itemId: item.itemId })
    expect(store.projectContent.library(b.id)).toEqual([])
    await expect(read({ projectId: b.id, sourceId: source.id })).rejects.toThrow(/access/)
    await expect(read({ projectId: a.id, sourceId: item.source.id })).rejects.toThrow(/access/)
    expect(() => handlers['content:share']({ projectId: b.id, targetProjectId: a.id, itemId: item.itemId })).toThrow()
    expect(() => handlers['content:restore']({ projectId: b.id, itemId: item.itemId })).toThrow(/owner/)
    handlers['content:restore']({ projectId: a.id, itemId: item.itemId })
    expect((await read({ projectId: a.id, sourceId: source.id })).text).toBe('First revision.')
    await expect(read({ projectId: b.id, sourceId: source.id })).rejects.toThrow(/access/)
    handlers['content:share']({ projectId: a.id, targetProjectId: b.id, itemId: item.itemId })
    handlers['content:revoke']({ projectId: a.id, targetProjectId: b.id, itemId: item.itemId })
    await expect(read({ projectId: b.id, sourceId: source.id })).rejects.toThrow(/access/)
    expect((await read({ projectId: a.id, sourceId: source.id })).text).toBe('First revision.')
  })
  it('rejects changed snapshot bytes and cannot use the hash alone to read another project', async () => {
    const { a, b, source, handlers } = fixture()
    writeFileSync(join(root, 'attachments', source.sha256.slice(0, 16) + '-' + source.name), 'changed fixture')
    await expect(handlers['content:read-source']({ projectId: a.id, sourceId: source.id })).rejects.toThrow(/snapshot/)
    await expect(handlers['content:read-source']({ projectId: b.id, sourceId: source.id })).rejects.toThrow(/access/)
  })
})
