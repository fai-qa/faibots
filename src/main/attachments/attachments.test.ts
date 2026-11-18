import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAttachmentStore, mimeTypeFor, safeFileName } from './attachments'

describe('AttachmentStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-att-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('copies files content-addressed and describes them', () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'report.pdf'), 'pdf bytes')
    writeFileSync(join(dir, 'src', 'copy.pdf'), 'pdf bytes')
    const store = createAttachmentStore({ dataDir: join(dir, 'data') })
    const [a, b] = store.ingest([join(dir, 'src', 'report.pdf'), join(dir, 'src', 'copy.pdf')])
    expect(a).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 9 })
    expect(a!.path).toMatch(/attachments[\\/][0-9a-f]{16}-report\.pdf$/)
    expect(store.read(a!).toString()).toBe('pdf bytes')
    expect(a!.id).not.toBe(b!.id)
    expect(readdirSync(join(dir, 'data', 'attachments'))).toHaveLength(2)
    // Same content and name: stored once.
    store.ingest([join(dir, 'src', 'report.pdf')])
    expect(readdirSync(join(dir, 'data', 'attachments'))).toHaveLength(2)
  })

  it('refuses folders and reads outside the store', () => {
    const store = createAttachmentStore({ dataDir: join(dir, 'data') })
    expect(() => store.ingest([dir])).toThrow(/not a file/)
    writeFileSync(join(dir, 'secret.txt'), 'x')
    expect(() => store.read({ id: '1', name: 's', mimeType: 'text/plain', sizeBytes: 1, path: join(dir, 'secret.txt') })).toThrow()
  })

  it('sniffs mime types by extension and makes names Windows-safe', () => {
    expect(mimeTypeFor('a.PNG')).toBe('image/png')
    expect(mimeTypeFor('notes.md')).toBe('text/markdown')
    expect(mimeTypeFor('blob')).toBe('application/octet-stream')
    expect(safeFileName('a<b>:c?.txt')).toBe('a_b__c_.txt')
    expect(safeFileName('trailing. ')).toBe('trailing')
    expect(safeFileName(`${'x'.repeat(200)}.docx`)).toMatch(/^x+\.docx$/)
    expect(safeFileName(`${'x'.repeat(200)}.docx`)).toHaveLength(100)
  })
})
