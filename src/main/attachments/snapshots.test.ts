import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type PlatformStore } from '../store'
import { observeFile, verifyRevisionFile } from '../routines/acceptance'
import { createAttachmentStore } from './attachments'
import { createSnapshotService, MAX_NOTE_BYTES } from './snapshots'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('snapshot service (owner decisions: md/txt/pdf, 10 MB, full sha256)', () => {
  let dir: string
  let store: PlatformStore
  let service: ReturnType<typeof createSnapshotService>
  let projectId: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-snapshots-'))
    store = openStore(join(dir, 'test.db'), { homeDir: dir })
    projectId = store.projects.create({ name: 'Launch proposal' }).id
    const attachments = createAttachmentStore({ dataDir: dir })
    service = createSnapshotService({ attachments, projects: store.projects, projectSources: store.projectSources })
  })
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  const note = (name: string, body: string | Buffer) => {
    const path = join(dir, name)
    writeFileSync(path, body)
    return path
  }

  it.each(['brief.md', 'notes.txt', 'report.pdf'] as const)('attaches a %s note with its full sha256, name and size', (name) => {
    const body = `note body ${name}`
    const path = note(name, body)
    const source = service.attach(projectId, [path])[0]!
    expect(source).toMatchObject({
      projectId, name, sha256: sha(body), sizeBytes: Buffer.byteLength(body), kind: name.split('.').pop()
    })
    expect(store.projectSources.get(source.id)).toEqual(source)
    // The note was copied into the attachment store unchanged (FJ-01 ingest).
    const stored = join(dir, 'attachments')
    const copied = service.attach(projectId, [path])[0]!
    expect(copied.attachmentId).not.toBe(source.attachmentId)
    expect(existsSync(stored)).toBe(true)
    expect(store.projectSources.listByProject(projectId)).toHaveLength(2)
  })

  it('rejects notes that are not md, txt or pdf before storing anything', () => {
    const docx = note('brief.docx', 'docx body')
    const png = note('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    expect(() => service.attach(projectId, [docx])).toThrow(/Markdown \(.md\), plain text \(.txt\) or PDF/)
    expect(() => service.attach(projectId, [png])).toThrow(/not supported/)
    expect(store.projectSources.listByProject(projectId)).toEqual([])
  })

  it('rejects notes larger than 10 MB with a clean message', () => {
    const big = note('big.md', 'x'.repeat(MAX_NOTE_BYTES + 1))
    expect(() => service.attach(projectId, [big])).toThrow(/10 MB or smaller/)
    expect(store.projectSources.listByProject(projectId)).toEqual([])
  })

  it('rejects unknown projects and unreadable paths', () => {
    expect(() => service.attach('missing', [note('a.md', 'x')])).toThrow(/Project not found/)
    expect(() => service.attach(projectId, [join(dir, 'nope.md')])).toThrow(/could not be read/)
    expect(() => service.attach(projectId, [dir])).toThrow(/is not a file/)
  })

  it('attaches several notes and keeps each row self-contained', () => {
    const sources = service.attach(projectId, [note('a.md', 'alpha'), note('b.txt', 'beta'), note('c.pdf', 'gamma')])
    expect(sources.map((s) => s.name).sort()).toEqual(['a.md', 'b.txt', 'c.pdf'])
    expect(new Set(sources.map((s) => s.sha256)).size).toBe(3)
    expect(store.projectSources.listByProject(projectId)).toHaveLength(3)
  })
})

describe('artifact revision capture reuses the acceptance observation (FJ-06)', () => {
  let dir: string
  let store: PlatformStore
  let workspace: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-revision-'))
    store = openStore(join(dir, 'test.db'), { homeDir: dir })
    workspace = join(dir, 'workspaces', 'writer')
    mkdirSync(workspace, { recursive: true })
  })
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

  it('snapshots a deliverable through observeFile and verifies it through verifyRevisionFile', () => {
    const pinned = realpathSync(workspace)
    const project = store.projects.create({ name: 'Proposal' })
    const artifact = store.artifacts.create({ projectId: project.id, name: 'proposal.md' })
    writeFileSync(join(workspace, 'proposal.md'), '# Launch plan\n- option A')
    const observed = observeFile(workspace, 'proposal.md', pinned)
    expect(observed.kind).toBe('ok')
    const revision = store.artifacts.createRevision({
      artifactId: artifact.id,
      sha256: observed.kind === 'ok' ? observed.sha256 : '',
      provenance: { projectId: project.id, note: 'drafted in the bot workspace' }
    })
    expect(revision.sha256).toBe(sha('# Launch plan\n- option A'))
    expect(store.artifacts.revisions(artifact.id)).toHaveLength(1)
    expect(verifyRevisionFile(workspace, 'proposal.md', pinned, revision.sha256))
      .toMatchObject({ status: 'passed', bytes: Buffer.byteLength('# Launch plan\n- option A') })
  })

  it('fails revision verification when the file changed, went missing, left the root or grew too large', () => {
    const pinned = realpathSync(workspace)
    const artifact = store.artifacts.create({ projectId: store.projects.create({ name: 'P' }).id, name: 'p.md' })
    const expected = sha('original')
    const path = join(workspace, 'p.md')
    writeFileSync(path, 'original')
    expect(verifyRevisionFile(workspace, 'p.md', pinned, expected)).toMatchObject({ status: 'passed' })
    writeFileSync(path, 'changed')
    expect(verifyRevisionFile(workspace, 'p.md', pinned, expected)).toMatchObject({ status: 'failed', reason: 'File SHA-256 does not match.' })
    rmSync(path)
    expect(verifyRevisionFile(workspace, 'p.md', pinned, expected)).toMatchObject({ status: 'failed', reason: 'Required file is missing.' })
    // A file that exists outside the pinned workspace is invalid, not observable.
    writeFileSync(join(dir, 'workspaces', 'outside.md'), 'outside')
    expect(observeFile(workspace, '../outside.md', pinned)).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/outside/i) })
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 1))
    expect(observeFile(workspace, 'p.md', pinned)).toMatchObject({ kind: 'invalid', reason: expect.stringMatching(/1 MiB/) })
    expect(store.artifacts.revisions(artifact.id)).toEqual([])
  })
})
