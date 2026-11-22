// Runs inside a dedicated Node worker. The only input is a verified local byte array.
const { parentPort, workerData } = require('node:worker_threads')
globalThis.fetch = async () => { throw new Error('Network access is disabled for PDF notes.') }

class NoteError extends Error {}

async function extract() {
  const { getDocumentProxy } = await import(workerData.moduleUrl)
  const doc = await getDocumentProxy(workerData.bytes, {
    isEvalSupported: false, useWorkerFetch: false, useSystemFonts: false, useWasm: false,
    disableFontFace: true, disableRange: true, disableStream: true, disableAutoFetch: true,
    enableXfa: false, stopAtErrors: true, verbosity: 0
  })
  try {
    if (doc.numPages > workerData.maxPages) throw new NoteError('PDF exceeds the page limit. Split it before attaching.')
    const pages = []
    let length = 0
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber)
      const reader = page.streamTextContent().getReader()
      const parts = []
      let readable = false
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          for (const item of value.items) {
            if (typeof item.str !== 'string') continue
            length += item.str.length + 1
            if (length > workerData.maxCharacters)
              throw new NoteError('PDF text exceeds the extraction limit. Split it before attaching.')
            if (item.str.trim()) readable = true
            parts.push(item.str, item.hasEOL ? '\n' : ' ')
          }
        }
      } finally {
        reader.releaseLock()
        page.cleanup()
      }
      if (!readable)
        throw new NoteError(`Page ${pageNumber} has no readable text layer. Use OCR locally or attach text notes.`)
      pages.push(parts.join('').trim())
    }
    if (!pages.length) throw new NoteError('PDF has no readable text layer.')
    return pages.join('\n\n')
  } finally {
    await doc.loadingTask.destroy()
  }
}

extract().then(
  (text) => parentPort.postMessage({ text }),
  (error) => {
    let reason = 'The PDF could not be read. Attach a valid PDF with a text layer or use text notes.'
    if (error instanceof NoteError) reason = error.message
    if (error?.name === 'PasswordException') reason = 'PDF is password-protected. Attach an unlocked copy.'
    parentPort.postMessage({ reason })
  }
)
