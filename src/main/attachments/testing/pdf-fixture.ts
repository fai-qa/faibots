/** A self-contained PDF with one text line per page. An empty line produces an image-only page. */
export function pdfFixture(...pages: string[]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  for (const [i, text] of pages.entries()) {
    const stream = text
      ? `BT /F1 10 Tf 10 60 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
      : 'q 10 0 0 10 20 20 cm BI /W 1 /H 1 /CS /G /BPC 8 ID X EI Q'
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
    )
  }
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(pdf, 'latin1')
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(pdf, 'latin1')
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}
