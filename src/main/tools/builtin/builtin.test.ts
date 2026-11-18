import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot, Conversation } from '@shared/domain'
import type { ToolContext, ToolResult } from '../../contracts'
import { createMemoryService } from '../../memory/memory'
import { createSkillService } from '../../skills/skills'
import { openStore, type PlatformStore } from '../../store'
import { fakeBus } from '../../store/test-helpers'
import type { PlatformToolDefinition } from '../define'
import { fileTools } from './files'
import { memoryTools, skillTools } from './memory-skills'
import { formatShellRun, shellInvocation, shellTool } from './shell'
import { createPinnedFetch, htmlToMarkdown, isPrivateAddress, webFetchTool } from './web-fetch'

const text = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : `[image ${c.mediaType}]`)).join('\n')

let dir: string
let store: PlatformStore
let bot: Bot
let conv: Conversation
let ctx: ToolContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'faibots-tools-'))
  store = openStore(':memory:', { homeDir: dir })
  bot = store.bots.create({ name: 'Ops' })
  conv = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
  ctx = {
    bot, conversation: conv, turnId: 't', callId: 'c', signal: new AbortController().signal, chain: [], inGroup: false,
    workspaceDir: join(dir, 'ws')
  }
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('file tools', () => {
  let skillDirs: string[]
  let tools: Record<string, PlatformToolDefinition>
  beforeEach(() => {
    skillDirs = []
    tools = Object.fromEntries(fileTools({ homeDir: dir, skillDirsForBot: () => skillDirs }).map((t) => [t.name, t]))
  })

  it('auto-allows inside the workspace only, judged on real paths', () => {
    mkdirSync(ctx.workspaceDir, { recursive: true })
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    // A junction on Windows: symbolic links need admin rights or Developer Mode there.
    symlinkSync(outside, join(ctx.workspaceDir, 'link'), 'junction')
    expect(tools.write_file!.autoAllow!({ path: 'notes/a.md', content: '' }, ctx)).toBe(true)
    expect(tools.write_file!.autoAllow!({ path: join(ctx.workspaceDir, 'a.md'), content: '' }, ctx)).toBe(true)
    expect(tools.write_file!.autoAllow!({ path: '../outside/a.md', content: '' }, ctx)).toBe(false)
    expect(tools.write_file!.autoAllow!({ path: 'link/escape.md', content: '' }, ctx)).toBe(false)
    expect(tools.read_file!.autoAllow!({ path: '~/secret.txt' }, ctx)).toBe(false)
    skillDirs = [outside]
    expect(tools.read_file!.autoAllow!({ path: join(outside, 'ref.md') }, ctx)).toBe(true)
    expect(tools.write_file!.autoAllow!({ path: join(outside, 'ref.md'), content: '' }, ctx)).toBe(false)
  })

  it('writes, reads with offset/limit, lists and edits', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')
    expect(text(await tools.write_file!.execute({ path: 'docs/a.txt', content: lines }, ctx))).toContain('Wrote 10 lines')
    expect(text(await tools.read_file!.execute({ path: 'docs/a.txt' }, ctx))).toContain('(10 lines)\nline 1\n')
    const part = text(await tools.read_file!.execute({ path: 'docs/a.txt', offset: 3, limit: 2 }, ctx))
    expect(part).toContain('(lines 3-4 of 10)\nline 3\nline 4')

    expect(text(await tools.list_dir!.execute({ path: '.' }, ctx))).toContain('docs/')
    expect(text(await tools.list_dir!.execute({ path: 'docs' }, ctx))).toMatch(/a\.txt \(\d+ bytes\)/)

    const edited = await tools.edit_file!.execute({ path: 'docs/a.txt', old_text: 'line 2\n', new_text: 'second\n' }, ctx)
    expect(edited.isError).toBeUndefined()
    expect(readFileSync(join(ctx.workspaceDir, 'docs/a.txt'), 'utf8')).toContain('line 1\nsecond\nline 3')

    const ambiguous = await tools.edit_file!.execute({ path: 'docs/a.txt', old_text: 'line', new_text: 'row' }, ctx)
    expect(text(ambiguous)).toContain('appears 9 times')
    await tools.edit_file!.execute({ path: 'docs/a.txt', old_text: 'line', new_text: 'row', replace_all: true }, ctx)
    expect(readFileSync(join(ctx.workspaceDir, 'docs/a.txt'), 'utf8')).not.toContain('line')
    expect((await tools.edit_file!.execute({ path: 'docs/a.txt', old_text: 'missing', new_text: 'x' }, ctx)).isError).toBe(true)
  })

  it('edits CRLF files with LF old_text', async () => {
    mkdirSync(ctx.workspaceDir, { recursive: true })
    writeFileSync(join(ctx.workspaceDir, 'win.txt'), 'one\r\ntwo\r\nthree\r\n')
    await tools.edit_file!.execute({ path: 'win.txt', old_text: 'one\ntwo', new_text: 'uno\ndos' }, ctx)
    expect(readFileSync(join(ctx.workspaceDir, 'win.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n')
  })

  it('handles binary files, images, folders and missing paths', async () => {
    mkdirSync(ctx.workspaceDir, { recursive: true })
    writeFileSync(join(ctx.workspaceDir, 'bin.dat'), Buffer.from([1, 0, 2, 3]))
    writeFileSync(join(ctx.workspaceDir, 'pic.png'), Buffer.from([137, 80, 78, 71]))
    expect(text(await tools.read_file!.execute({ path: 'bin.dat' }, ctx))).toContain('binary')
    const image = await tools.read_file!.execute({ path: 'pic.png' }, ctx)
    expect(image.content[1]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    expect((await tools.read_file!.execute({ path: '.' }, ctx)).isError).toBe(true)
    expect((await tools.read_file!.execute({ path: 'nope.txt' }, ctx)).isError).toBe(true)
    expect(text(await tools.read_file!.execute({ path: 'x' }, { ...ctx, workspaceDir: join(dir, 'other') }))).toContain('does not exist')
  })
})

describe('shell', () => {
  it('builds the PowerShell invocation on Windows and bash elsewhere', () => {
    const win = shellInvocation('Get-ChildItem', 'win32')
    expect(win.file).toBe('powershell.exe')
    expect(win.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(win.args[4]).toMatch(/UTF8Encoding.*; Get-ChildItem$/)
    expect(shellInvocation('ls -la', 'linux')).toEqual({ file: 'bash', args: ['-lc', 'ls -la'] })
  })

  it('formats results', () => {
    expect(formatShellRun({ exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false, cancelled: false }, 5)).toBe('Exit code: 0\nok')
    expect(formatShellRun({ exitCode: null, stdout: '', stderr: 'e', timedOut: true, cancelled: false }, 5))
      .toBe('Timed out after 5 s; the command was stopped.\nExit code: none\n--- stderr ---\ne')
  })

  const runsBash = process.platform !== 'win32'

  it.runIf(runsBash)('runs in the workspace with the bot\'s secrets in env', async () => {
    const tool = shellTool({ homeDir: dir, secrets: { envForBot: () => ({ CRM_TOKEN: 'abc123' }) } })
    const result = await tool.execute({ command: 'echo "$CRM_TOKEN"; pwd; echo oops >&2' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('abc123')
    expect(text(result)).toContain(ctx.workspaceDir)
    expect(text(result)).toContain('--- stderr ---\noops')
    expect(tool.summarize!({ command: 'ls' }, ctx)).toBe(`Run \`ls\` in ${ctx.workspaceDir}`)
  })

  it.runIf(runsBash)('reports non-zero exits, timeouts and stops', async () => {
    const tool = shellTool({ homeDir: dir, secrets: { envForBot: () => ({}) } })
    const failed = await tool.execute({ command: 'exit 3' }, ctx)
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('Exit code: 3')

    const slow = await tool.execute({ command: 'sleep 5', timeoutSec: 1 }, ctx)
    expect(text(slow)).toContain('Timed out after 1 s')

    const controller = new AbortController()
    const pending = tool.execute({ command: 'sleep 5' }, { ...ctx, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    expect(text(await pending)).toContain('Cancelled')
    expect((await tool.execute({ command: 'ls', cwd: 'missing' }, ctx)).isError).toBe(true)
  })
})

describe('web_fetch', () => {
  const page = (body: string, type: string, status = 200) =>
    (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch
  const publicDns = async () => ['93.184.216.34']

  it('knows loopback, private, link-local and similar addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254',
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:808:808']) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  describe('connection pinning (DNS rebinding)', () => {
    let server: Server
    let port: number
    let hits: string[]
    beforeEach(async () => {
      hits = []
      server = createServer((req, res) => {
        hits.push(req.url ?? '')
        if (req.url === '/moved') {
          res.writeHead(302, { location: '/final' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'x-test': 'yes' })
        res.end(gzipSync('<p>Hello from the server</p>'))
      })
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      port = (server.address() as AddressInfo).port
    })
    afterEach(() => new Promise<void>((r) => server.close(() => r())))

    it('refuses a name that resolves public for the check and private for the connection', async () => {
      let lookups = 0
      const rebinding = async () => (++lookups === 1 ? ['93.184.216.34'] : ['127.0.0.1'])
      const result = await webFetchTool({ lookup: rebinding }).execute({ url: `http://rebind.test:${port}/secret` }, ctx)
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/private address \(127\.0\.0\.1\)/)
      expect(lookups).toBe(2)
      expect(hits).toEqual([])
    })

    it('reads like fetch: status, headers, gzip body and redirects left to the caller', async () => {
      const pinned = createPinnedFetch(async () => ['127.0.0.1'], () => false)
      const signal = new AbortController().signal
      const res = await pinned(new URL(`http://site.test:${port}/page`), { signal, headers: {} })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-test')).toBe('yes')
      expect(res.headers.get('content-encoding')).toBeNull()
      expect(await res.text()).toBe('<p>Hello from the server</p>')
      const moved = await pinned(new URL(`http://site.test:${port}/moved`), { signal, headers: {} })
      expect(moved.status).toBe(302)
      expect(moved.headers.get('location')).toBe('/final')
      expect(hits).toEqual(['/page', '/moved'])
    })
  })

  it('refuses local and private targets, also behind DNS names and redirects', async () => {
    let fetched = 0
    const counting = (async () => { fetched++; return new Response('x', { headers: { 'content-type': 'text/plain' } }) }) as unknown as typeof fetch
    const tool = webFetchTool({ lookup: async (host) => (host === 'intranet.test' ? ['10.0.0.5'] : ['93.184.216.34']), fetch: counting })
    for (const url of ['http://localhost:3000', 'http://app.localhost', 'http://127.0.0.1/', 'http://[::1]:8080/', 'http://169.254.169.254/latest', 'https://intranet.test/']) {
      const result = await tool.execute({ url }, ctx)
      expect(result.isError, url).toBe(true)
      expect(text(result), url).toContain('cannot open local or private network addresses')
    }
    expect(fetched).toBe(0)

    const redirecting = (async (url: URL) =>
      url.hostname === 'short.test'
        ? new Response(null, { status: 302, headers: { location: 'http://192.168.0.1/admin' } })
        : new Response('never', { headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch
    const viaRedirect = await webFetchTool({ lookup: publicDns, fetch: redirecting }).execute({ url: 'https://short.test/x' }, ctx)
    expect(text(viaRedirect)).toContain('192.168.0.1')

    const hops = (async (url: URL) =>
      url.pathname === '/final'
        ? new Response('<p>Landed</p>', { headers: { 'content-type': 'text/html' } })
        : new Response(null, { status: 301, headers: { location: '/final' } })) as unknown as typeof fetch
    expect(text(await webFetchTool({ lookup: publicDns, fetch: hops }).execute({ url: 'https://a.test/start' }, ctx)))
      .toBe('URL: https://a.test/final\nStatus: 200\n\nLanded')
  })

  it('turns HTML into Markdown without scripts', () => {
    const md = htmlToMarkdown('<h1>Title</h1><script>evil()</script><p>Hello <a href="https://x.y">link</a></p><ul><li>a</li></ul>')
    expect(md).toBe('# Title\n\nHello [link](https://x.y)\n\n-   a')
  })

  it('fetches pages, JSON and rejects non-text or bad URLs', async () => {
    const html = await webFetchTool({ lookup: publicDns, fetch: page('<p>Hi</p>', 'text/html; charset=utf-8') }).execute({ url: 'https://example.com' }, ctx)
    expect(text(html)).toBe('URL: https://example.com/\nStatus: 200\n\nHi')
    const json = await webFetchTool({ lookup: publicDns, fetch: page('{"a":1}', 'application/json') }).execute({ url: 'https://api.test/x' }, ctx)
    expect(text(json)).toContain('"a": 1')
    const notFound = await webFetchTool({ lookup: publicDns, fetch: page('gone', 'text/plain', 404) }).execute({ url: 'https://a.test' }, ctx)
    expect(notFound.isError).toBe(true)
    expect((await webFetchTool({ lookup: publicDns, fetch: page('x', 'image/png') }).execute({ url: 'https://a.test' }, ctx)).isError).toBe(true)
    expect((await webFetchTool({ lookup: publicDns, fetch: page('', 'text/plain') }).execute({ url: 'file:///etc/passwd' }, ctx)).isError).toBe(true)
    expect((await webFetchTool({ lookup: publicDns, fetch: page('', 'text/plain') }).execute({ url: 'not a url' }, ctx)).isError).toBe(true)
    const long = await webFetchTool({ lookup: publicDns, fetch: page('x'.repeat(60_000), 'text/plain') }).execute({ url: 'https://a.test' }, ctx)
    expect(text(long)).toContain('cut at 50000 characters')
  })
})

describe('memory tools', () => {
  it('writes, edits and forgets only the calling bot\'s memory', async () => {
    const memory = createMemoryService(store.db)
    const [update, recall] = memoryTools({ memory })
    const other = store.bots.create({ name: 'Other' })

    expect(text(await update!.execute({ action: 'write', tier: 'profile', content: 'Alex builds AI products.' }, ctx))).toContain('Saved')
    expect(memory.getProfile(bot.id).content).toBe('Alex builds AI products.')

    const saved = text(await update!.execute({ action: 'write', tier: 'log', content: 'Demo day is Friday' }, ctx))
    const factId = /id: ([^)]+)/.exec(saved)![1]!
    expect(memory.getFact(factId)!.source).toEqual({ conversationId: conv.id })
    expect(text(await recall!.execute({ query: 'demo' }, ctx))).toContain('Demo day is Friday')

    await update!.execute({ action: 'edit', tier: 'log', factId, content: 'Demo day moved to Monday' }, ctx)
    expect(memory.getFact(factId)!.text).toBe('Demo day moved to Monday')

    const otherCtx = { ...ctx, bot: other }
    expect((await update!.execute({ action: 'delete', tier: 'log', factId }, otherCtx)).isError).toBe(true)
    expect(text(await recall!.execute({ query: 'demo' }, otherCtx))).toContain('Nothing')

    await update!.execute({ action: 'delete', tier: 'log', factId }, ctx)
    expect(memory.getFact(factId)).toBeUndefined()
    expect((await update!.execute({ action: 'write', tier: 'log' }, ctx)).isError).toBe(true)
  })
})

describe('skill tools', () => {
  it('loads visible skills and manages only the bot\'s own', async () => {
    const skills = createSkillService({ dataDir: join(dir, 'data'), homeDir: dir, store, bus: fakeBus() })
    const [load, update] = skillTools({ skills })
    const library = skills.save({ name: 'house-style', description: 'Use when writing', body: 'Be brief.' })
    store.bots.update(bot.id, { skillIds: [library.id] })
    const fresh = { ...ctx, bot: store.bots.get(bot.id)! }

    expect(text(await load!.execute({ name: 'house-style' }, fresh))).toContain('Be brief.')
    expect(text(await load!.execute({ name: 'nope' }, fresh))).toContain('Your skills: house-style')

    expect((await update!.execute({ action: 'write', name: 'Triage Bugs', description: 'Use when triaging' }, fresh)).isError).toBe(true)
    expect(text(await update!.execute({ action: 'write', name: 'Triage Bugs', description: 'Use when triaging', content: '1. Sort' }, fresh)))
      .toContain('Created skill triage-bugs')
    expect(text(await update!.execute({ action: 'write', name: 'triage-bugs', content: '1. Sort by impact' }, fresh))).toContain('Updated')
    expect(skills.findForBot(bot.id, 'triage-bugs')!.body.trim()).toBe('1. Sort by impact')
    expect(skills.findForBot(bot.id, 'triage-bugs')!.description).toBe('Use when triaging')

    expect((await update!.execute({ action: 'delete', name: 'house-style' }, fresh)).isError).toBe(true)
    expect(text(await update!.execute({ action: 'delete', name: 'triage-bugs' }, fresh))).toContain('Deleted')
    expect(skills.findForBot(bot.id, 'triage-bugs')).toBeUndefined()
  })
})
