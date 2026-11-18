import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from '@shared/domain'
import type { ToolContext } from '../contracts'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { convertCallResult, createMcpHost, mcpToolName, type Connector, type PlatformMcpHost } from './host'
import type { McpServerInput } from './config-import'

/** A tiny in-process MCP server; tools can change at runtime. */
function fakeServer(initial: { name: string; description?: string }[], instructions?: string) {
  let tools = initial
  const server = new Server({ name: 'fake', version: '1' }, { capabilities: { tools: { listChanged: true } }, instructions })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ ...t, inputSchema: { type: 'object' as const, properties: { q: { type: 'string' } } } }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text' as const, text: `${req.params.name}:${JSON.stringify(req.params.arguments)}` }]
  }))
  return {
    server,
    setTools: async (next: typeof initial) => {
      tools = next
      await server.sendToolListChanged()
    }
  }
}

const stdio = (name: string, extra: Partial<McpServerInput> = {}): McpServerInput => ({
  name, transport: 'stdio', command: 'fake', args: [], env: {}, enabled: true, disabledTools: [], customInstructions: '', ...extra
})

const until = async (check: () => boolean) => {
  for (let i = 0; i < 600 && !check(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(check()).toBe(true)
}

describe('mcpToolName', () => {
  it('namespaces, sanitizes and caps at 64 characters', () => {
    expect(mcpToolName('git hub', 'create.issue')).toBe('mcp__git_hub__create_issue')
    const long = mcpToolName('a'.repeat(40), 'b'.repeat(40))
    expect(long).toHaveLength(64)
    expect(long).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(mcpToolName('a'.repeat(40), 'c'.repeat(40))).not.toBe(long)
  })
})

describe('convertCallResult', () => {
  it('maps every content kind', () => {
    expect(convertCallResult({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a', text: 'body' } },
        { type: 'resource_link', name: 'doc', uri: 'https://d' },
        { type: 'audio', data: 'x', mimeType: 'audio/wav' }
      ],
      isError: true
    })).toEqual({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', mediaType: 'image/png', dataBase64: 'AAA' },
        { type: 'text', text: 'file:///a:\nbody' },
        { type: 'text', text: 'Link: doc https://d' },
        { type: 'text', text: '[audio content]' }
      ],
      isError: true
    })
    expect(convertCallResult({ content: [], structuredContent: { a: 1 } }).content[0]).toEqual({ type: 'text', text: '{\n  "a": 1\n}' })
  })
})

describe('McpHost', () => {
  let dir: string
  let store: PlatformStore
  let bus: ReturnType<typeof fakeBus>
  let host: PlatformMcpHost
  let servers: Map<string, ReturnType<typeof fakeServer>>
  let connects: string[]
  let failNext: Set<string>

  const connector: Connector = async (config: McpServerConfig, makeClient) => {
    connects.push(config.name)
    if (failNext.delete(config.name)) throw new Error('spawn fake ENOENT')
    const fake = servers.get(config.name)
    if (!fake) throw new Error(`no fake server ${config.name}`)
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await fake.server.connect(serverSide)
    const client = makeClient()
    await client.connect(clientSide)
    return { client }
  }

  const ctx = (): ToolContext => {
    const bot = store.bots.list()[0]!
    return {
      bot, conversation: store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] }), turnId: 't', callId: 'c',
      signal: new AbortController().signal, chain: [], inGroup: false, workspaceDir: dir
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-mcp-'))
    store = openStore(':memory:', { homeDir: dir })
    bus = fakeBus()
    servers = new Map()
    connects = []
    failNext = new Set()
    host = createMcpHost({ db: store.db, bus, homeDir: dir, store, connector })
  })
  afterEach(async () => {
    await host.shutdown()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('validates and stores configs', () => {
    const saved = host.save(stdio('github', { env: { T: '1' } }))
    expect(host.list()).toEqual([{ server: saved, status: { state: 'stopped' } }])
    expect(() => host.save(stdio('GitHub'))).toThrow(/already exists/)
    expect(() => host.save(stdio('x', { command: ' ' }))).toThrow(/command/)
    expect(() => host.save({ ...stdio('web'), transport: 'http', url: 'ftp://x' })).toThrow(/http/)
    const renamed = host.save({ ...saved, name: 'gh' })
    expect(renamed.id).toBe(saved.id)
    expect(renamed.createdAt).toBe(saved.createdAt)
    expect(bus.of('mcp:changed').length).toBeGreaterThan(0)
  })

  it('starts lazily, maps tools for the bots allowed to use them, and calls them', async () => {
    servers.set('github', fakeServer([{ name: 'create_issue', description: 'Create an issue' }, { name: 'delete_repo' }], 'Prefer small issues.'))
    servers.set('notes', fakeServer([{ name: 'search' }]))
    const github = host.save(stdio('github', { disabledTools: ['delete_repo'], customInstructions: 'Use the acme org.' }))
    const notes = host.save(stdio('notes'))
    const all = store.bots.create({ name: 'All' })
    const onlyNotes = store.bots.create({ name: 'Notes only', mcpServerIds: [notes.id] })
    expect(connects).toEqual([])

    const tools = await host.toolsForBot(all)
    expect(tools.map((t) => t.name)).toEqual(['mcp__github__create_issue', 'mcp__notes__search'])
    expect(tools[0]).toMatchObject({ source: 'mcp', serverId: github.id, defaultPermission: 'ask', description: 'Create an issue' })
    expect(host.list().map((s) => s.status)).toEqual([{ state: 'ready', toolCount: 2 }, { state: 'ready', toolCount: 1 }])
    expect((await host.toolsForBot(onlyNotes)).map((t) => t.name)).toEqual(['mcp__notes__search'])
    expect(connects).toEqual(['github', 'notes'])

    const result = await tools[0]!.execute({ q: 'bug' }, ctx())
    expect(result).toEqual({ content: [{ type: 'text', text: 'create_issue:{"q":"bug"}' }] })
    expect(tools[0]!.summarize!({ q: 'bug' }, ctx())).toBe('Use create_issue on github with {"q":"bug"}')

    expect(host.instructionsForBot(all)).toBe('## Connector: github\nPrefer small issues.\n\nUse the acme org.')
    expect(host.instructionsForBot(onlyNotes)).toBe('')
    expect(await host.tools(github.id)).toEqual([
      { name: 'create_issue', description: 'Create an issue', disabled: false },
      { name: 'delete_repo', description: '', disabled: true }
    ])
  })

  it('refreshes the cached tool list on list_changed', async () => {
    const fake = fakeServer([{ name: 'a' }])
    servers.set('srv', fake)
    const srv = host.save(stdio('srv'))
    const bot = store.bots.create({ name: 'B' })
    expect((await host.toolsForBot(bot)).map((t) => t.name)).toEqual(['mcp__srv__a'])
    await fake.setTools([{ name: 'a' }, { name: 'b' }])
    await until(() => host.list().find((s) => s.server.id === srv.id)!.status.state === 'ready' &&
      (host.list()[0]!.status as { toolCount: number }).toolCount === 2)
    expect((await host.toolsForBot(bot)).map((t) => t.name)).toEqual(['mcp__srv__a', 'mcp__srv__b'])
  })

  it('reports start failures, cools down, and restarts on demand', async () => {
    servers.set('flaky', fakeServer([{ name: 'x' }]))
    const flaky = host.save(stdio('flaky'))
    const bot = store.bots.create({ name: 'B' })
    failNext.add('flaky')
    expect(await host.toolsForBot(bot)).toEqual([])
    expect(host.list()[0]!.status).toEqual({ state: 'error', message: 'spawn fake ENOENT' })
    // Within the cooldown a turn does not wait on it again.
    expect(await host.toolsForBot(bot)).toEqual([])
    expect(connects).toEqual(['flaky'])
    expect(await host.restart(flaky.id)).toEqual({ state: 'ready', toolCount: 1 })
  })

  it('closes a server that connects but hangs past its startup timeout', async () => {
    const hanging = new Server({ name: 'hang', version: '1' }, { capabilities: { tools: {} } })
    hanging.setRequestHandler(ListToolsRequestSchema, () => new Promise(() => {}))
    let closed = 0
    const slowHost = createMcpHost({
      db: store.db, bus, homeDir: dir, store,
      connector: async (_config, makeClient) => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        await hanging.connect(serverSide)
        const client = makeClient()
        const close = client.close.bind(client)
        client.close = async () => {
          closed++
          await close()
        }
        await client.connect(clientSide)
        return { client }
      }
    })
    slowHost.save(stdio('slow', { startupTimeoutSec: 0.2 }))
    expect(await slowHost.toolsForBot(store.bots.create({ name: 'B' }))).toEqual([])
    expect(slowHost.list()[0]!.status).toEqual({ state: 'error', message: 'slow did not start within 0.2 s' })
    await until(() => closed > 0)
    await slowHost.shutdown()
  })

  it('restarts a server that crashes', async () => {
    servers.set('crashy', fakeServer([{ name: 'x' }]))
    host.save(stdio('crashy'))
    const bot = store.bots.create({ name: 'B' })
    await host.toolsForBot(bot)
    const old = servers.get('crashy')!
    servers.set('crashy', fakeServer([{ name: 'x' }, { name: 'y' }]))
    await old.server.close() // the child "exits"
    await until(() => host.list()[0]!.status.state === 'error')
    await until(() => host.list()[0]!.status.state === 'ready')
    expect(connects).toEqual(['crashy', 'crashy'])
    expect((await host.toolsForBot(bot)).map((t) => t.name)).toEqual(['mcp__crashy__x', 'mcp__crashy__y'])
  })

  it('disabled servers and config changes stop the connection', async () => {
    servers.set('s', fakeServer([{ name: 'x' }]))
    const s = host.save(stdio('s'))
    const bot = store.bots.create({ name: 'B' })
    await host.toolsForBot(bot)
    host.save({ ...s, customInstructions: 'notes only' })
    expect(host.list()[0]!.status.state).toBe('ready')
    host.save({ ...s, enabled: false })
    expect(host.list()[0]!.status.state).toBe('stopped')
    expect(await host.toolsForBot(bot)).toEqual([])
  })

  it('delete removes the server from bots that listed it', () => {
    const s = host.save(stdio('s'))
    const t = host.save(stdio('t'))
    const bot = store.bots.create({ name: 'B', mcpServerIds: [s.id, t.id] })
    host.delete(s.id)
    expect(store.bots.get(bot.id)!.mcpServerIds).toEqual([t.id])
    expect(host.list().map((x) => x.server.name)).toEqual(['t'])
  })

  it('imports from Claude, Codex, Cursor and JSON without overwriting existing names', () => {
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'npx' }, linear: { url: 'https://l/mcp' } } }))
    mkdirSync(join(dir, '.codex'))
    writeFileSync(join(dir, '.codex', 'config.toml'), '[mcp_servers.docs]\ncommand = "docs"\n')
    mkdirSync(join(dir, '.cursor'))
    writeFileSync(join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'other' }, figma: { url: 'https://f/mcp' } } }))

    host.save(stdio('linear'))
    expect(host.import('claude').map((s) => s.name)).toEqual(['github'])
    expect(host.import('codex').map((s) => s.name)).toEqual(['docs'])
    expect(host.import('cursor').map((s) => s.name)).toEqual(['figma'])
    expect(host.import('json', '{"mcpServers":{"pasted":{"command":"p"}}}').map((s) => s.name)).toEqual(['pasted'])
    expect(host.import('claude')).toEqual([])
    expect(host.list().map((s) => s.server.name)).toEqual(['linear', 'github', 'docs', 'figma', 'pasted'])
    rmSync(join(dir, '.claude.json'))
    expect(() => host.import('claude')).toThrow(/No Claude Code config/)
  })
})
