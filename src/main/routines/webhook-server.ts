// Local webhook endpoint: other apps on this computer (n8n, Zapier's local agent, a script, a
// scheduled task) start a routine with
//
//   POST http://127.0.0.1:<port>/routines/<routine id>/run
//   Authorization: Bearer <token>
//   body: optional text, or JSON (a "text" field, or the whole object), passed to the bot as data
//
// Safety: it listens on 127.0.0.1 only, so other computers cannot reach it. Each routine has its own
// token (only a hash is stored). Requests that carry an Origin header come from a web page, and are
// refused, so a site you visit cannot start runs. The Host header must name this computer, which
// stops DNS-rebinding tricks. Bodies are capped, and the routine service rate-limits runs.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Id, RoutineRun } from '@shared/domain'
import type { WebhookHost, WebhookStatus } from '../contracts'
import { MAX_WEBHOOK_PAYLOAD_CHARS, WebhookError } from './routines'

const MAX_BODY_BYTES = 64 * 1024
const ROUTE = /^\/routines\/([A-Za-z0-9-]{1,64})\/run\/?$/

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge())
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** The data handed to the bot: a JSON "text" field, other JSON pretty-printed, or the raw text. */
export function payloadFromBody(body: string, contentType: string | undefined): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  if (/json/i.test(contentType ?? '') || /^[[{]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as { text?: unknown }).text === 'string') {
        const rest = { ...(parsed as Record<string, unknown>) }
        const text = rest['text'] as string
        delete rest['text']
        return Object.keys(rest).length > 0 ? `${text}\n\n${JSON.stringify(rest, null, 2)}` : text
      }
      return JSON.stringify(parsed, null, 2)
    } catch {
      // Not JSON after all: pass it on as text.
    }
  }
  return trimmed
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function createWebhookServer(deps: {
  triggerWebhook(id: Id, token: string, payload: string): RoutineRun
}): WebhookHost {
  let server: Server | undefined
  let state: WebhookStatus = { listening: false }

  const handle = async (req: IncomingMessage, res: ServerResponse, port: number) => {
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'Unknown host.' })
    if (req.headers.origin) return send(res, 403, { error: 'Web pages cannot start routines.' })
    const match = ROUTE.exec(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    if (!match) return send(res, 404, { error: 'Not found. POST /routines/<id>/run' })
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      return send(res, 405, { error: 'Use POST.' })
    }
    const auth = req.headers.authorization ?? ''
    const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? ''
    let body: string
    try {
      body = await readBody(req)
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res, 413, { error: `The body is limited to ${MAX_BODY_BYTES / 1024} KB.` })
      return send(res, 400, { error: 'Could not read the request.' })
    }
    const payload = payloadFromBody(body, req.headers['content-type']).slice(0, MAX_WEBHOOK_PAYLOAD_CHARS + 1)
    try {
      const run = deps.triggerWebhook(match[1]!, token, payload)
      return send(res, 202, { runId: run.id, status: run.status, startedAt: run.startedAt })
    } catch (err) {
      if (err instanceof WebhookError) return send(res, err.status, { error: err.message })
      return send(res, 500, { error: 'The run could not start.' })
    }
  }

  const close = () =>
    new Promise<void>((resolve) => {
      const current = server
      server = undefined
      state = { listening: false }
      if (!current) return resolve()
      current.close(() => resolve())
      current.closeAllConnections()
    })

  return {
    async listen(port) {
      if (server && state.listening && state.port === port) return state
      await close()
      const next = createServer((req, res) => {
        handle(req, res, port).catch(() => {
          if (!res.headersSent) send(res, 500, { error: 'The run could not start.' })
        })
      })
      next.requestTimeout = 15_000
      state = await new Promise<WebhookStatus>((resolve) => {
        next.once('error', (err: NodeJS.ErrnoException) => {
          const error =
            err.code === 'EADDRINUSE' ? `Port ${port} is already used by another app. Pick another port.` : `The webhook server could not start: ${err.message}`
          resolve({ listening: false, port, error })
        })
        next.listen(port, '127.0.0.1', () => resolve({ listening: true, port }))
      })
      if (state.listening) server = next
      return state
    },
    close,
    status: () => ({ ...state }),
    url: (routineId, port) => `http://127.0.0.1:${port}/routines/${routineId}/run`
  }
}
