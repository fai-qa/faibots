import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { MAX_NOTE_BYTES } from './snapshots'
import workerSource from './pdf-worker.cjs?raw'

const requireHere = createRequire(import.meta.url)
const MAX_ACTIVE = 2
const MAX_WAITING = 6
export const MAX_PDF_CHARACTERS = 400_000
const waiting: Array<() => void> = []
let active = 0

export class UnreadablePdf extends Error {}

async function run(bytes: Buffer): Promise<string> {
  const installed = requireHere.resolve('unpdf')
  const unpacked = installed.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
  const moduleUrl = pathToFileURL(existsSync(unpacked) ? unpacked : installed).href
  const input = Uint8Array.from(bytes)
  const worker = new Worker(workerSource, {
    eval: true,
    execArgv: [],
    workerData: { moduleUrl, bytes: input, maxPages: 128, maxCharacters: MAX_PDF_CHARACTERS },
    transferList: [input.buffer],
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
    stdout: true,
    stderr: true
  })
  worker.stdout.resume()
  worker.stderr.resume()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new UnreadablePdf('PDF extraction timed out. Split the document or attach text notes.'))
      }, 8_000)
      worker.once('message', (result: { text?: string; reason?: string }) => {
        if (typeof result.text === 'string') resolve(result.text)
        else reject(new UnreadablePdf(result.reason || 'PDF extraction failed.'))
      })
      worker.once('error', () => reject(new UnreadablePdf('The local PDF reader could not finish within its limits.')))
      worker.once('exit', () => reject(new UnreadablePdf('The local PDF reader exited without a result.')))
    })
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
}

export async function extractPdfText(bytes: Buffer): Promise<string> {
  if (!bytes.length || bytes.length > MAX_NOTE_BYTES) throw new UnreadablePdf('PDF notes must be between one byte and 10 MB.')
  if (active >= MAX_ACTIVE) {
    if (waiting.length >= MAX_WAITING)
      throw new UnreadablePdf('The local PDF reader is busy. Try again after the current notes finish.')
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else active++
  try {
    return await run(bytes)
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}
