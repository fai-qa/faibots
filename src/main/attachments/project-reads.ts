import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ArtifactRevision, Id, ProjectSource } from '@shared/domain'
import type { AttachmentStore } from '../contracts'
import type { PlatformStore } from '../store'
import { observeFile, pinWorkspace } from '../routines/acceptance'
import { mimeTypeFor, safeFileName } from './attachments'

export function readSourceSnapshot(dataDir: string, attachments: AttachmentStore, source: ProjectSource): Buffer {
  const path = join(dataDir, 'attachments', source.sha256.slice(0, 16) + '-' + safeFileName(source.name))
  const data = attachments.read({
    id: source.attachmentId,
    name: source.name,
    mimeType: mimeTypeFor(source.name),
    sizeBytes: source.sizeBytes,
    path
  })
  if (createHash('sha256').update(data).digest('hex') !== source.sha256)
    throw new Error('Source snapshot no longer matches: ' + source.name)
  return data
}

/** Check the current project grant even for historical revisions that predate Library identity. */
export function revisionText(
  store: PlatformStore,
  projectId: Id,
  revision: ArtifactRevision,
  dataDir: string,
  attachments: AttachmentStore
) {
  const file = revision.provenance.file
  if (!file || revision.provenance.projectId !== projectId) throw new Error('No verified artifact file for this project.')
  for (const ref of revision.provenance.sources ?? []) {
    const legacy =
      !ref.sourceId &&
      store.db
        .prepare('select id from project_sources where project_id=? and attachment_id=? and sha256=?')
        .get(projectId, ref.attachmentId, ref.sha256)
    const sourceId = ref.sourceId ?? (legacy ? String(legacy.id) : '')
    const pinned = store.projectContent.pin(projectId, sourceId)
    if (pinned.sha256 !== ref.sha256) throw new Error('The selected source no longer matches this revision.')
    readSourceSnapshot(dataDir, attachments, store.projectContent.check(projectId, pinned))
  }
  const observed = observeFile(file.workspace, file.path, pinWorkspace(file.workspace))
  if (observed.kind !== 'ok' || observed.sha256 !== revision.sha256)
    throw new Error('The published revision is unavailable or has changed.')
  return observed.data.toString('utf8')
}
