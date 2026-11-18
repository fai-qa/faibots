import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RoutineRun } from '@shared/domain'
import { WebhookError } from './routines'
import { createWebhookServer, payloadFromBody } from './webhook-server'

function post(port: number, path: string, opts: { headers?: Record<string, string>; body?: string; method?: string } = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }))
    })
    req.on('error', reject)
    req.end(opts.body ?? '')
  })
}

describe('webhook server', () => {
  const calls: { id: string; token: string; payload: string }[] = []
  const server = createWebhookServer({
    triggerWebhook(id, token, payload) {
      calls.push({ id, token, payload })
      if (token !== 'good') throw new WebhookError(401, 'Wrong or missing token.')
      return { id: 'run1', status: 'running', startedAt: 1 } as RoutineRun
    }
  })
  let port = 0

  beforeEach(async () => {
    calls.length = 0
    // A random high port; retry a few times in case one is taken.
    for (let i = 0; i < 5; i++) {
      port = 40_000 + Math.floor(Math.random() * 20_000)
      if ((await server.listen(port)).listening) break
    }
  })
  afterEach(() => server.close())

  it('starts a run with a valid token and passes the body as data', async () => {
    const res = await post(port, '/routines/abc-123/run', {
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'New lead', from: 'n8n' })
    })
    expect(res).toEqual({ status: 202, body: { runId: 'run1', status: 'running', startedAt: 1 } })
    expect(calls[0]).toEqual({ id: 'abc-123', token: 'good', payload: 'New lead\n\n{\n  "from": "n8n"\n}' })
    expect(server.status()).toEqual({ listening: true, port })
    expect(server.url('abc-123', port)).toBe(`http://127.0.0.1:${port}/routines/abc-123/run`)
  })

  it('refuses web pages, other hosts, wrong methods and paths', async () => {
    expect((await post(port, '/routines/a/run', { headers: { authorization: 'Bearer good', origin: 'https://evil.example' } })).status).toBe(403)
    expect((await post(port, '/routines/a/run', { headers: { authorization: 'Bearer good', host: 'evil.example' } })).status).toBe(403)
    expect((await post(port, '/routines/a/run', { method: 'GET' })).status).toBe(405)
    expect((await post(port, '/elsewhere')).status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it('answers with the service status for a bad token', async () => {
    const res = await post(port, '/routines/a/run', { headers: { authorization: 'Bearer bad' } })
    expect(res).toEqual({ status: 401, body: { error: 'Wrong or missing token.' } })
    // Tokens only travel in the header, never in the URL.
    await post(port, '/routines/a/run?token=good')
    expect(calls.at(-1)!.token).toBe('')
  })

  it('caps the body size', async () => {
    const res = await post(port, '/routines/a/run', { headers: { authorization: 'Bearer good' }, body: 'x'.repeat(70 * 1024) }).catch(() => ({ status: 413 }))
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('reports a port that is taken instead of throwing', async () => {
    const other = createWebhookServer({ triggerWebhook: () => ({}) as RoutineRun })
    const status = await other.listen(port)
    expect(status).toMatchObject({ listening: false, port, error: expect.stringContaining('already used') })
    await other.close()
  })

  it('reads payloads as text, JSON text fields or pretty JSON', () => {
    expect(payloadFromBody('  hello ', 'text/plain')).toBe('hello')
    expect(payloadFromBody('{"text":"hi"}', 'application/json')).toBe('hi')
    expect(payloadFromBody('{"a":1}', undefined)).toBe('{\n  "a": 1\n}')
    expect(payloadFromBody('{not json', 'application/json')).toBe('{not json')
    expect(payloadFromBody('', 'application/json')).toBe('')
  })
})
