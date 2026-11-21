import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ArtifactRevision, Id, ProjectSource } from '@shared/domain'
import type { AttachmentStore } from '../contracts'
import type { PlatformStore } from '../store'
import { observeFile, pinWorkspace } from '../routines/acceptance'
import { mimeTypeFor, safeFileName } from './attachments'
import { extractPdfText, MAX_PDF_CHARACTERS, UnreadablePdf } from './pdf-text'
import { MAX_NOTE_BYTES } from './snapshots'

type Pin = ReturnType<PlatformStore['projectContent']['pin']>

/** Extract selected PDF copies once per operation. Every later read still checks the current
 * grant and original bytes, including after an asynchronous provider call. */
export async function prepareNoteReader(
  store: PlatformStore, projectId: Id, pins: Pin[], dataDir: string, attachments: AttachmentStore, allowOmissions = false
) {
  const extracted = new Map<string, string | UnreadablePdf>()
  let remaining = MAX_PDF_CHARACTERS * 3
  const deadline = performance.now() + 30_000
  for (const pin of pins) {
    try {
      const source = store.projectContent.check(projectId, pin)
      if (source.kind !== 'pdf' || extracted.has(source.sha256)) continue
      if (performance.now() >= deadline) throw new UnreadablePdf('Selected PDF notes exceed the reading time limit. Select fewer notes.')
      if (remaining <= 0) throw new UnreadablePdf('Selected PDF notes exceed the combined text limit. Select fewer notes.')
      const text = await extractPdfText(readSourceSnapshot(dataDir, attachments, source))
      if (text.length > remaining) throw new UnreadablePdf('Selected PDF notes exceed the combined text limit. Select fewer notes.')
      remaining -= text.length
      extracted.set(source.sha256, text)
    } catch (error) {
      if (!allowOmissions) throw error
      if (error instanceof UnreadablePdf) extracted.set(pin.sha256, error)
    }
  }
  return (pin: Pin) => {
    const source = store.projectContent.check(projectId, pin)
    const bytes = readSourceSnapshot(dataDir, attachments, source)
    if (source.kind !== 'pdf') return bytes.toString('utf8')
    const text = extracted.get(source.sha256)
    if (typeof text === 'string') return text
    if (text instanceof UnreadablePdf) throw text
    throw new UnreadablePdf('PDF text is unavailable.')
  }
}

export function readSourceSnapshot(dataDir: string, attachments: AttachmentStore, source: ProjectSource): Buffer {
  const path = join(dataDir, 'attachments', source.sha256.slice(0, 16) + '-' + safeFileName(source.name))
  if (source.sizeBytes > MAX_NOTE_BYTES) throw new Error('The source snapshot exceeds the note size limit.')
  const data = attachments.read({
    id: source.attachmentId,
    name: source.name,
    mimeType: mimeTypeFor(source.name),
    sizeBytes: source.sizeBytes,
    path
  }, source.sizeBytes)
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
