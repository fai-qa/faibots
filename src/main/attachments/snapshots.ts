// Snapshot service (first journey, FJ-01/FJ-02): attach note files to a project as sources.
// Owner decisions: notes are md/txt/pdf only and at most 10 MB each (decision b); the source
// records the full SHA-256 (decision j). Sources are attached files: the note is copied into
// the attachment store once, and the project_source row keeps a self-contained identity.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Id, NoteKind, ProjectSource } from '@shared/domain'
import type { AttachmentStore } from '../contracts'
import type { ProjectRepo, ProjectSourceRepo } from '../store/projects'

export const MAX_NOTE_BYTES = 10 * 1024 * 1024

const NOTE_EXTENSIONS: Record<string, NoteKind> = { '.md': 'md', '.txt': 'txt', '.pdf': 'pdf' }

export const noteKindFor = (name: string): NoteKind | undefined => NOTE_EXTENSIONS[extname(name).toLowerCase()]

export interface SnapshotService {
  /**
   * Copy each file into the attachment store and record it as a source of `projectId`.
   * Throws with a clean message before anything is stored when a file is not an allowed
   * note type, exceeds 10 MB, or the project does not exist. Files are handled one by one:
   * a later failure leaves the rows already attached (rows stay resolvable; orphaned
   * attachment files are reconciled, never silently deleted — DATABASE.md:32).
   */
  attach(projectId: Id, paths: string[]): ProjectSource[]
}

export function createSnapshotService(deps: {
  attachments: AttachmentStore
  projects: ProjectRepo
  projectSources: ProjectSourceRepo
}): SnapshotService {
  return {
    attach(projectId, paths) {
      if (!deps.projects.get(projectId)) throw new Error('Project not found')
      return paths.map((sourcePath): ProjectSource => {
        const name = basename(sourcePath)
        let stat: ReturnType<typeof statSync>
        try {
          stat = statSync(sourcePath)
        } catch {
          throw new Error(`${name} could not be read.`)
        }
        if (!stat.isFile()) throw new Error(`${name} is not a file`)
        if (stat.size > MAX_NOTE_BYTES) {
          throw new Error(`${name} is ${stat.size} bytes; a note must be 10 MB or smaller.`)
        }
        const kind = noteKindFor(name)
        if (!kind) throw new Error(`Notes must be Markdown (.md), plain text (.txt) or PDF (.pdf); ${name} is not supported.`)
        const sha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
        const attachment = deps.attachments.ingest([sourcePath])[0]!
        return deps.projectSources.insert({
          projectId, attachmentId: attachment.id, name: attachment.name, sha256, sizeBytes: stat.size, kind
        })
      })
    }
  }
}
