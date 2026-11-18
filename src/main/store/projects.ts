// Journey repositories (first journey slice, migration 6): record-only projects, note sources,
// Markdown artifacts with host-snapshotted revisions, and reviewed decisions.
// Project rows never resolve by label alone: every lookup is by id (DATABASE.md:10).

import { randomUUID } from 'node:crypto'
import type {
  Artifact, ArtifactKind, ArtifactProvenance, ArtifactRevision, ArtifactStatus, Id, NoteKind, Project,
  ProjectSource, ReviewDecision, ReviewDecisionKind
} from '@shared/domain'
import { num, parseJson, str, transaction, type Db, type Row } from './db'

export const MAX_PROJECT_NAME = 120
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
export const NOTE_KINDS: readonly NoteKind[] = ['md', 'txt', 'pdf']
export const REVIEW_DECISIONS: readonly ReviewDecisionKind[] = ['accepted', 'repair', 'partial', 'rejected']

export interface ProjectRepo {
  list(): Project[]
  get(id: Id): Project | undefined
  create(input: { name: string; description?: string }): Project
  update(id: Id, patch: { name?: string; description?: string }): Project
  delete(id: Id): void
}

export interface ProjectSourceRepo {
  listByProject(projectId: Id): ProjectSource[]
  get(id: Id): ProjectSource | undefined
  insert(input: { projectId: Id; attachmentId: Id; name: string; sha256: string; sizeBytes: number; kind: NoteKind }): ProjectSource
  remove(id: Id): void
}

export interface ArtifactRepo {
  listByProject(projectId: Id): Artifact[]
  get(id: Id): Artifact | undefined
  create(input: { projectId: Id; name: string; kind?: ArtifactKind }): Artifact
  delete(id: Id): void
  /** Move the host state of an artifact (draft -> reviewed once a review decision lands). */
  updateStatus(id: Id, status: ArtifactStatus): Artifact
  /** Oldest revision first. */
  revisions(artifactId: Id): ArtifactRevision[]
  /** Snapshot a new revision: revision_no = 1 + the latest number of that artifact. */
  createRevision(input: { artifactId: Id; sha256: string; provenance?: ArtifactProvenance }): ArtifactRevision
  reviews(artifactRevisionId: Id): ReviewDecision[]
  addReview(input: { artifactRevisionId: Id; rubric: string; reviewer: string; decision: ReviewDecisionKind; explanation?: string }): ReviewDecision
}

function checkName(name: string, what: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error(`${what} needs a name`)
  if (trimmed.length > MAX_PROJECT_NAME) throw new Error(`${what} names are at most ${MAX_PROJECT_NAME} characters`)
  return trimmed
}

function checkSha256(sha256: string): string {
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) throw new Error('SHA-256 must be 64 hexadecimal characters.')
  return sha256.toLowerCase()
}

function projectExists(db: Db, id: Id): void {
  if (!db.prepare('select 1 from projects where id = ?').get(id)) throw new Error('Project not found')
}

const toProject = (r: Row): Project => ({
  id: str(r['id']), name: str(r['name']), description: str(r['description']),
  createdAt: num(r['created_at']), updatedAt: num(r['updated_at'])
})

const toSource = (r: Row): ProjectSource => ({
  id: str(r['id']), projectId: str(r['project_id']), attachmentId: str(r['attachment_id']),
  name: str(r['name']), sha256: str(r['sha256']), sizeBytes: num(r['size_bytes']),
  kind: str(r['kind']) as NoteKind, createdAt: num(r['created_at'])
})

const toArtifact = (r: Row): Artifact => ({
  id: str(r['id']), projectId: str(r['project_id']), name: str(r['name']),
  kind: (str(r['kind']) || 'proposal') as ArtifactKind,
  status: (str(r['status']) || 'draft') as ArtifactStatus,
  createdAt: num(r['created_at']), updatedAt: num(r['updated_at'])
})

const toRevision = (r: Row): ArtifactRevision => ({
  id: str(r['id']), artifactId: str(r['artifact_id']), revisionNo: num(r['revision_no']),
  sha256: str(r['sha256']), provenance: parseJson<ArtifactProvenance>(r['provenance'], {}), createdAt: num(r['created_at'])
})

const toDecision = (r: Row): ReviewDecision => ({
  id: str(r['id']), artifactRevisionId: str(r['artifact_revision_id']), rubric: str(r['rubric']),
  reviewer: str(r['reviewer']), decision: str(r['decision']) as ReviewDecisionKind,
  explanation: str(r['explanation']), createdAt: num(r['created_at'])
})

export function createProjectRepo(db: Db): ProjectRepo {
  const get = (id: Id) => {
    const row = db.prepare('select * from projects where id = ?').get(id)
    return row ? toProject(row) : undefined
  }
  return {
    list: () => db.prepare('select * from projects order by created_at, rowid').all().map(toProject),
    get,
    create(input) {
      const now = Date.now()
      const project: Project = {
        id: randomUUID(), name: checkName(input.name, 'A project'), description: (input.description ?? '').trim(), createdAt: now, updatedAt: now
      }
      db.prepare('insert into projects (id, name, description, created_at, updated_at) values (?, ?, ?, ?, ?)')
        .run(project.id, project.name, project.description, project.createdAt, project.updatedAt)
      return project
    },
    update(id, patch) {
      const current = get(id)
      if (!current) throw new Error('Project not found')
      const next: Project = {
        ...current,
        ...(patch.name !== undefined && { name: checkName(patch.name, 'A project') }),
        ...(patch.description !== undefined && { description: patch.description.trim() }),
        updatedAt: Date.now()
      }
      db.prepare('update projects set name = ?, description = ?, updated_at = ? where id = ?')
        .run(next.name, next.description, next.updatedAt, id)
      return next
    },
    delete(id) {
      const result = db.prepare('delete from projects where id = ?').run(id)
      if (result.changes !== 1) throw new Error('Project not found')
    }
  }
}

export function createProjectSourceRepo(db: Db): ProjectSourceRepo {
  const get = (id: Id) => {
    const row = db.prepare('select * from project_sources where id = ?').get(id)
    return row ? toSource(row) : undefined
  }
  return {
    listByProject: (projectId) => db.prepare('select * from project_sources where project_id = ? order by created_at, rowid').all(projectId).map(toSource),
    get,
    insert(input) {
      projectExists(db, input.projectId)
      if (!NOTE_KINDS.includes(input.kind)) throw new Error('A note source is Markdown (.md), plain text (.txt) or PDF (.pdf).')
      if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('Note size must be a non-negative whole number of bytes.')
      if (!input.name.trim()) throw new Error('A note source needs a name.')
      if (!input.attachmentId) throw new Error('A note source needs its attachment id.')
      const source: ProjectSource = {
        id: randomUUID(), projectId: input.projectId, attachmentId: input.attachmentId, name: input.name.trim(),
        sha256: checkSha256(input.sha256), sizeBytes: input.sizeBytes, kind: input.kind, createdAt: Date.now()
      }
      db.prepare(`insert into project_sources (id, project_id, attachment_id, name, sha256, size_bytes, kind, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(source.id, source.projectId, source.attachmentId, source.name, source.sha256, source.sizeBytes, source.kind, source.createdAt)
      return source
    },
    remove(id) {
      db.prepare('delete from project_sources where id = ?').run(id)
    }
  }
}

export function createArtifactRepo(db: Db): ArtifactRepo {
  const get = (id: Id) => {
    const row = db.prepare('select * from artifacts where id = ?').get(id)
    return row ? toArtifact(row) : undefined
  }
  return {
    listByProject: (projectId) => db.prepare('select * from artifacts where project_id = ? order by created_at, rowid').all(projectId).map(toArtifact),
    get,
    create(input) {
      projectExists(db, input.projectId)
      const now = Date.now()
      const artifact: Artifact = {
        id: randomUUID(), projectId: input.projectId, name: checkName(input.name, 'An artifact'),
        kind: input.kind ?? 'proposal', status: 'draft', createdAt: now, updatedAt: now
      }
      db.prepare('insert into artifacts (id, project_id, name, kind, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
        .run(artifact.id, artifact.projectId, artifact.name, artifact.kind, artifact.status, artifact.createdAt, artifact.updatedAt)
      return artifact
    },
    delete(id) {
      db.prepare('delete from artifacts where id = ?').run(id)
    },
    updateStatus(id, status) {
      const current = get(id)
      if (!current) throw new Error('Artifact not found')
      const updatedAt = Date.now()
      db.prepare('update artifacts set status = ?, updated_at = ? where id = ?').run(status, updatedAt, id)
      return { ...current, status, updatedAt }
    },
    revisions: (artifactId) => db.prepare('select * from artifact_revisions where artifact_id = ? order by revision_no').all(artifactId).map(toRevision),
    createRevision(input) {
      return transaction(db, () => {
        const artifact = get(input.artifactId)
        if (!artifact) throw new Error('Artifact not found')
        const latest = db.prepare('select max(revision_no) as n from artifact_revisions where artifact_id = ?').get(input.artifactId) as { n: number | null } | undefined
        const revisionNo = (latest?.n ?? 0) + 1
        const revision: ArtifactRevision = {
          id: randomUUID(), artifactId: input.artifactId, revisionNo, sha256: checkSha256(input.sha256),
          provenance: input.provenance ?? {}, createdAt: Date.now()
        }
        db.prepare('insert into artifact_revisions (id, artifact_id, revision_no, sha256, provenance, created_at) values (?, ?, ?, ?, ?, ?)')
          .run(revision.id, revision.artifactId, revision.revisionNo, revision.sha256, JSON.stringify(revision.provenance), revision.createdAt)
        return revision
      })
    },
    reviews: (artifactRevisionId) => db.prepare('select * from review_decisions where artifact_revision_id = ? order by created_at, rowid').all(artifactRevisionId).map(toDecision),
    addReview(input) {
      const revision = db.prepare('select 1 from artifact_revisions where id = ?').get(input.artifactRevisionId)
      if (!revision) throw new Error('Artifact revision not found')
      if (!REVIEW_DECISIONS.includes(input.decision)) throw new Error('A review decision is accepted, repair, partial or rejected.')
      if (!input.rubric.trim()) throw new Error('A review needs the rubric it was checked against.')
      if (!input.reviewer.trim()) throw new Error('A review needs its reviewer.')
      const decision: ReviewDecision = {
        id: randomUUID(), artifactRevisionId: input.artifactRevisionId, rubric: input.rubric.trim(), reviewer: input.reviewer.trim(),
        decision: input.decision, explanation: (input.explanation ?? '').trim(), createdAt: Date.now()
      }
      db.prepare(`insert into review_decisions (id, artifact_revision_id, rubric, reviewer, decision, explanation, created_at)
        values (?, ?, ?, ?, ?, ?, ?)`)
        .run(decision.id, decision.artifactRevisionId, decision.rubric, decision.reviewer, decision.decision, decision.explanation, decision.createdAt)
      return decision
    }
  }
}
