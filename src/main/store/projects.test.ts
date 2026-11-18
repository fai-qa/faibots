import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type PlatformStore } from './index'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('journey store (migration 6)', () => {
  let store: PlatformStore
  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/home/me', userName: 'Me' })
  })
  afterEach(() => store.close())

  const project = () => store.projects.create({ name: 'Launch proposal', description: 'Q1 launch' })

  describe('projects', () => {
    it('creates, lists, gets, updates and deletes projects by id', () => {
      const a = project()
      const b = store.projects.create({ name: 'Other' })
      expect(store.projects.list().map((p) => p.id)).toEqual([a.id, b.id])
      expect(store.projects.get(a.id)).toMatchObject({ name: 'Launch proposal', description: 'Q1 launch' })
      const updated = store.projects.update(a.id, { name: 'Launch plan' })
      expect(updated).toMatchObject({ name: 'Launch plan', description: 'Q1 launch' })
      store.projects.delete(a.id)
      expect(store.projects.get(a.id)).toBeUndefined()
      expect(() => store.projects.delete(a.id)).toThrow(/not found/i)
    })

    it('validates the name and ignores undefined patch fields', () => {
      expect(() => store.projects.create({ name: '  ' })).toThrow(/name/i)
      expect(() => store.projects.create({ name: 'x'.repeat(121) })).toThrow(/120/)
      const p = project()
      expect(store.projects.update(p.id, { name: undefined })).toMatchObject({ name: 'Launch proposal' })
      expect(() => store.projects.update('missing', { name: 'Nope' })).toThrow(/not found/i)
    })
  })

  describe('project sources', () => {
    it('records a source with its full sha256, name, size and kind', () => {
      const p = project()
      const source = store.projectSources.insert({
        projectId: p.id, attachmentId: 'att-1', name: 'brief.md', sha256: sha('brief'), sizeBytes: 5, kind: 'md'
      })
      expect(source).toMatchObject({
        projectId: p.id, attachmentId: 'att-1', name: 'brief.md', sha256: sha('brief'), sizeBytes: 5, kind: 'md'
      })
      expect(store.projectSources.get(source.id)).toEqual(source)
      expect(store.projectSources.listByProject(p.id)).toEqual([source])
    })

    it('lists only the sources of its own project', () => {
      const a = project()
      const b = store.projects.create({ name: 'B' })
      const inA = store.projectSources.insert({ projectId: a.id, attachmentId: '1', name: 'a.md', sha256: sha('a'), sizeBytes: 1, kind: 'md' })
      store.projectSources.insert({ projectId: b.id, attachmentId: '2', name: 'b.txt', sha256: sha('b'), sizeBytes: 1, kind: 'txt' })
      expect(store.projectSources.listByProject(a.id).map((s) => s.id)).toEqual([inA.id])
      store.projectSources.remove(inA.id)
      expect(store.projectSources.get(inA.id)).toBeUndefined()
    })

    it('rejects malformed hashes, unknown kinds, bad sizes and unknown projects', () => {
      const p = project()
      const base = { projectId: p.id, attachmentId: '1', name: 'x.md', sizeBytes: 1 }
      expect(() => store.projectSources.insert({ ...base, sha256: 'abc', kind: 'md' })).toThrow(/64 hexadecimal/)
      expect(() => store.projectSources.insert({ ...base, sha256: sha('x'), kind: 'docx' as never })).toThrow(/Markdown/)
      expect(() => store.projectSources.insert({ ...base, sha256: sha('x'), kind: 'md', sizeBytes: -1 })).toThrow(/whole number/)
      expect(() => store.projectSources.insert({ projectId: 'missing', attachmentId: '1', name: 'x.md', sha256: sha('x'), sizeBytes: 1, kind: 'md' })).toThrow(/not found/i)
    })
  })

  describe('artifacts, revisions and reviews', () => {
    it('numbers revisions per artifact and keeps provenance', () => {
      const p = project()
      const artifact = store.artifacts.create({ projectId: p.id, name: 'proposal.md' })
      expect(store.artifacts.listByProject(p.id).map((a) => a.id)).toEqual([artifact.id])
      const first = store.artifacts.createRevision({ artifactId: artifact.id, sha256: sha('v1'), provenance: { projectId: p.id } })
      const second = store.artifacts.createRevision({ artifactId: artifact.id, sha256: sha('v2'), provenance: { projectId: p.id, sources: [{ attachmentId: 'a1', name: 'brief.md', sha256: sha('brief') }] } })
      expect(first).toMatchObject({ artifactId: artifact.id, revisionNo: 1, sha256: sha('v1'), provenance: { projectId: p.id } })
      expect(second).toMatchObject({ artifactId: artifact.id, revisionNo: 2, provenance: { sources: [{ name: 'brief.md' }] } })
      expect(store.artifacts.revisions(artifact.id).map((r) => r.revisionNo)).toEqual([1, 2])
      // A second artifact starts its own numbering.
      const other = store.artifacts.create({ projectId: p.id, name: 'other.md' })
      expect(store.artifacts.createRevision({ artifactId: other.id, sha256: sha('o') })).toMatchObject({ revisionNo: 1 })
    })

    it('rejects revisions of unknown artifacts and malformed hashes', () => {
      expect(() => store.artifacts.createRevision({ artifactId: 'missing', sha256: sha('x') })).toThrow(/Artifact not found/)
      const artifact = store.artifacts.create({ projectId: project().id, name: 'p.md' })
      expect(() => store.artifacts.createRevision({ artifactId: artifact.id, sha256: 'short' })).toThrow(/64 hexadecimal/)
    })

    it('records review decisions against a revision and validates them', () => {
      const artifact = store.artifacts.create({ projectId: project().id, name: 'p.md' })
      const revision = store.artifacts.createRevision({ artifactId: artifact.id, sha256: sha('v1') })
      const decision = store.artifacts.addReview({
        artifactRevisionId: revision.id, rubric: 'has a summary and three options', reviewer: 'user',
        decision: 'repair', explanation: 'needs the budget section'
      })
      expect(decision).toMatchObject({ artifactRevisionId: revision.id, rubric: 'has a summary and three options', reviewer: 'user', decision: 'repair', explanation: 'needs the budget section' })
      expect(store.artifacts.reviews(revision.id)).toEqual([decision])
      expect(() => store.artifacts.addReview({ artifactRevisionId: revision.id, rubric: 'r', reviewer: 'user', decision: 'maybe' as never })).toThrow(/accepted, repair, partial or rejected/)
      expect(() => store.artifacts.addReview({ artifactRevisionId: revision.id, rubric: '  ', reviewer: 'user', decision: 'accepted' })).toThrow(/rubric/)
      expect(() => store.artifacts.addReview({ artifactRevisionId: revision.id, rubric: 'r', reviewer: ' ', decision: 'accepted' })).toThrow(/reviewer/)
      expect(() => store.artifacts.addReview({ artifactRevisionId: 'missing', rubric: 'r', reviewer: 'user', decision: 'accepted' })).toThrow(/revision not found/)
    })
  })

  it('deleting a project cascades sources, artifacts, revisions and decisions', () => {
    const p = project()
    const source = store.projectSources.insert({ projectId: p.id, attachmentId: '1', name: 'n.md', sha256: sha('n'), sizeBytes: 1, kind: 'md' })
    const artifact = store.artifacts.create({ projectId: p.id, name: 'p.md' })
    const revision = store.artifacts.createRevision({ artifactId: artifact.id, sha256: sha('v') })
    const decision = store.artifacts.addReview({ artifactRevisionId: revision.id, rubric: 'r', reviewer: 'user', decision: 'accepted' })
    store.projects.delete(p.id)
    expect(store.projectSources.get(source.id)).toBeUndefined()
    expect(store.artifacts.get(artifact.id)).toBeUndefined()
    expect(store.artifacts.revisions(artifact.id)).toEqual([])
    expect(store.artifacts.reviews(revision.id)).toEqual([])
    expect(decision.id).toBeTruthy()
    expect(store.db.prepare('pragma foreign_key_check').all()).toEqual([])
  })
})
