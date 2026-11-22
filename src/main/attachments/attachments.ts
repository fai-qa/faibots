// Files sent in chats are copied into <dataDir>/attachments/<sha256-prefix>-<name>, so the same
// file sent twice is stored once and later edits to the original don't change the transcript.

import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { Attachment } from '@shared/domain'
import type { AttachmentStore } from '../contracts'
import { isInside } from '../tools/paths'

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.log': 'text/plain',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain',
  '.py': 'text/x-python', '.sh': 'text/x-shellscript', '.ps1': 'text/plain', '.sql': 'text/plain',
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.zip': 'application/zip', '.gz': 'application/gzip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

export const mimeTypeFor = (name: string) => MIME_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'

/** A file name that is valid on Windows too, keeping the extension. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim() || 'file'
  if (cleaned.length <= 100) return cleaned
  const ext = extname(cleaned).slice(0, 20)
  return cleaned.slice(0, 100 - ext.length) + ext
}

function readSizedFile(path: string, name: string, expectedSize: number): Buffer {
  // A project snapshot can be replaced or grow during a read. Bound allocation to its recorded size.
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_ATTACHMENT_BYTES)
    throw new Error('Invalid snapshot size.')
  const changed = () => new Error('Source snapshot no longer matches: ' + name)
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== expectedSize) throw changed()
    const bytes = Buffer.alloc(expectedSize + 1)
    let total = 0
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, null)
      if (count === 0) break
      total += count
    }
    if (total !== expectedSize) throw changed()
    return bytes.subarray(0, total)
  } finally {
    closeSync(fd)
  }
}

export function createAttachmentStore(deps: { dataDir: string }): AttachmentStore {
  const dir = join(deps.dataDir, 'attachments')

  return {
    ingest(paths) {
      mkdirSync(dir, { recursive: true })
      return paths.map((source): Attachment => {
        const stat = statSync(source)
        if (!stat.isFile()) throw new Error(`${basename(source)} is not a file`)
        if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(source)} is larger than 50 MB`)
        const bytes = readSizedFile(source, basename(source), stat.size)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const hash = sha256.slice(0, 16)
        const name = basename(source)
        const path = join(dir, `${hash}-${safeFileName(name)}`)
        if (!existsSync(path)) writeFileSync(path, bytes)
        return { id: randomUUID(), name, mimeType: mimeTypeFor(name), sizeBytes: bytes.length, sha256, path }
      })
    },

    read(attachment, expectedSize) {
      // Attachments come back from the transcript; only ever read inside our own folder.
      if (!isInside(attachment.path, dir)) throw new Error('Attachment is outside the attachment store')
      if (expectedSize === undefined) return readFileSync(attachment.path)
      return readSizedFile(attachment.path, attachment.name, expectedSize)
    }
  }
}
