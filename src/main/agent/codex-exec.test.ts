import { createServer } from 'node:http'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { findCodexBinary } from '../providers/external'
import { createScopedCodex } from './codex-exec'

it('contacts the faibots bridge and skips MCP transports from account and workspace configuration', async () => {
  const bin = findCodexBinary()
  expect(bin).toBeDefined()
  const root = mkdtempSync(join(tmpdir(), 'faibots-codex-scope-'))
  const account = join(root, '.codex'), project = join(root, 'bot')
  mkdirSync(account)
  mkdirSync(join(project, '.codex'), { recursive: true })
  const paths = new Set<string>()
  let promptSeen = false
  const http = createServer(async (req, res) => {
    const path = req.url ?? ''
    paths.add(path)
    const parts: Buffer[] = []
    for await (const chunk of req) parts.push(Buffer.from(chunk))
    const body = Buffer.concat(parts).toString()
    if (path === '/faibots' && req.method === 'POST') {
      const rpc = JSON.parse(body) as { id?: number; method: string }
      if (rpc.id === undefined) { res.writeHead(202).end(); return }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [] }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
      return
    }
    if (path === '/v1/responses') promptSeen ||= body.includes('Cedar fixture text')
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Offline fixture complete.' } }))
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  try {
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Local fixture port missing')
    const base = `http://127.0.0.1:${address.port}`
    const peerConfig = (name: string) => `[mcp_servers.${name}]\nurl="${base}/${name}"\nrequired=true\n`
    writeFileSync(join(account, 'config.toml'), peerConfig('account_peer') + `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`)
    writeFileSync(join(project, '.codex', 'config.toml'), peerConfig('workspace_peer'))
    const env: Record<string, string> = {
      HOME: root, USERPROFILE: root, APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'), CODEX_HOME: account
    }
    for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'COMSPEC', 'PATHEXT'])
      if (process.env[name]) env[name] = process.env[name]!
    // Exercise an unpacked Windows executable, as the desktop installer does. A development
    // node_modules tree may be inside a protected folder where Windows denies CLI startup.
    let cli = bin!.path
    if (process.platform === 'win32') {
      cli = join(root, 'codex.exe')
      copyFileSync(bin!.path, cli)
    }
    const scoped = createScopedCodex({ codexPathOverride: cli, env, configOverrides: [
      `mcp_servers={faibots={url="${base}/faibots", required=true}}`, 'features.apps=false', 'features.plugins=false',
      'project_root_markers=[]', 'model_provider="fixture"', `model_providers.fixture={name="Local",base_url="${base}/v1",wire_api="responses",supports_websockets=false,requires_openai_auth=false}`,
      `chatgpt_base_url="${base}"`, 'analytics.enabled=false', 'feedback.enabled=false'
    ] })
    const { events } = await scoped.startThread({ workingDirectory: project, sandboxMode: 'read-only', model: 'gpt-6.1-sol' })
      .runStreamed('Cedar fixture text', { signal: AbortSignal.timeout(20_000) })
    // The local provider deliberately declines the request once it sees the isolated tool profile.
    const drain = async () => { for await (const _ of events) { /* consume through process exit */ } }
    await expect(drain()).rejects.toThrow('exit 1')
    expect(paths.has('/faibots')).toBe(true)
    expect(promptSeen).toBe(true)
    expect(paths.has('/account_peer')).toBe(false)
    expect(paths.has('/workspace_peer')).toBe(false)
  } finally {
    http.closeAllConnections()
    await new Promise<void>(resolve => http.close(() => resolve()))
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}, 30_000)
