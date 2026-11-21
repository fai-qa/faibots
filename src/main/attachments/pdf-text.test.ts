import { expect, it } from 'vitest'
import { extractPdfText } from './pdf-text'
import { MAX_NOTE_BYTES } from './snapshots'
import { pdfFixture } from './testing/pdf-fixture'

it('reads a text-layer PDF locally in page order', async () => {
  expect(await extractPdfText(pdfFixture('Venue: Cedar', 'Session: Wednesday'))).toBe('Venue: Cedar\n\nSession: Wednesday')
})

it('reports the image-only page even in a mixed document; rejects invalid files and oversized inputs', async () => {
  await expect(extractPdfText(pdfFixture('Venue: Cedar', ''))).rejects.toThrow(/Page 2 has no readable text layer/)
  await expect(extractPdfText(Buffer.from('not a PDF'))).rejects.toThrow(/valid PDF/)
  await expect(extractPdfText(pdfFixture(...Array<string>(129).fill('Cedar')))).rejects.toThrow(/page limit/)
  await expect(extractPdfText(Buffer.alloc(MAX_NOTE_BYTES + 1))).rejects.toThrow(/10 MB/)
})
