// Local MCP client host. Servers start lazily (the first time a bot or the settings screen needs
// their tools), tool lists are cached and refreshed on list_changed, and a server that crashes
// is restarted with backoff. Bots see tools as mcp__<server>__<tool>.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { Bot, Id, McpServerConfig, McpServerStatus } from '@shared/domain'
import type { EventBus, McpHost, McpImportSource, Store, ToolDefinition, ToolResult, ToolResultContent } from '../contracts'
import { num, parseJson, str, type Db, type Row } from '../store/db'
import { errorResult } from '../tools/define'
import type { McpToolSource } from '../tools/registry'
import {
  expandEnv, parseClaudeConfig, parseCodexConfig, parseCursorConfig, parseMcpJson, type McpServerInput
} from './config-import'

const CLIENT_INFO = { name: 'faibots', version: '0.1.0' }
const DEFAULT_STARTUP_SEC = 30
const TOOL_CALL_TIMEOUT_MS = 10 * 60_000
/** Delays before restarting a crashed server; after the last one we wait for the next use. */
const RESTART_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000]
/** A server that failed to start is not retried on every turn for this long. */
const FAILURE_COOLDOWN_MS = 30_000
const STABLE_AFTER_MS = 60_000
const MAX_INSTRUCTIONS = 10_000
/** Windows variables npx/cmd-based servers need, beyond the SDK's safe default set. */
const EXTRA_WINDOWS_ENV = ['PATHEXT', 'COMSPEC', 'WINDIR', 'PROGRAMDATA', 'ProgramFiles(x86)', 'CommonProgramFiles', 'TMP', 'OS', 'NUMBER_OF_PROCESSORS']

/** Connects a client to a server; replaceable in tests. Returns a description of stderr for errors. */
export type Connector = (server: McpServerConfig, makeClient: () => Client) => Promise<{ client: Client; stderrTail?: () => string }>

type ServerTool = Pick<Tool, 'name' | 'description' | 'inputSchema' | 'title'>

interface Conn {
  status: McpServerStatus
  client?: Client
  tools: ServerTool[]
  instructions?: string
  starting?: Promise<void>
  /** Bumped on every start/stop, so callbacks from an old client are ignored. */
  generation: number
  attempts: number
  failedAt?: number
  connectedAt?: number
  retryTimer?: NodeJS.Timeout
  stderrTail?: () => string
}

export interface PlatformMcpHost extends McpHost, McpToolSource {}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_')

/** mcp__<server>__<tool>, at most 64 characters; long names get a hash so they stay unique. */
export function mcpToolName(serverName: string, toolName: string): string {
  const full = `mcp__${sanitize(serverName)}__${sanitize(toolName)}`
  if (full.length <= 64) return full
  return `${full.slice(0, 57)}_${createHash('sha256').update(full).digest('hex').slice(0, 6)}`
}

function toConfig(r: Row): McpServerConfig {
  const data = parseJson<Partial<McpServerConfig>>(r['data'], {})
  return {
    transport: 'stdio',
    enabled: true,
    disabledTools: [],
    customInstructions: '',
    ...data,
    id: str(r['id']),
    name: str(r['name']),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

function validate(input: McpServerInput): McpServerInput {
  const name = input.name.trim()
  if (!name) throw new Error('A connector needs a name')
  if (name.length > 64) throw new Error('Connector names are at most 64 characters')
  if (!['stdio', 'http', 'sse'].includes(input.transport)) throw new Error(`Unknown transport "${input.transport}"`)
  if (input.transport === 'stdio') {
    if (!input.command?.trim()) throw new Error('A stdio connector needs a command')
  } else {
    let url: URL
    try {
      url = new URL(input.url ?? '')
    } catch {
      throw new Error('Enter the server URL, e.g. https://example.com/mcp')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Server URLs start with http:// or https://')
  }
  if (input.customInstructions.length > MAX_INSTRUCTIONS) throw new Error(`Instructions are at most ${MAX_INSTRUCTIONS} characters`)
  return {
    ...input,
    name,
    ...(input.command !== undefined && { command: input.command.trim() }),
    ...(input.url !== undefined && { url: input.url.trim() }),
    disabledTools: [...new Set(input.disabledTools)]
  }
}

/** Fields that change how we connect; editing anything else does not need a restart. */
const connectionKey = (s: McpServerConfig) =>
  JSON.stringify([s.transport, s.command, s.args, s.env, s.cwd, s.url, s.headers, s.enabled])

function childEnv(server: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() }
  if (process.platform === 'win32') {
    for (const key of EXTRA_WINDOWS_ENV) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
  }
  for (const [key, value] of Object.entries(server.env ?? {})) env[key] = expandEnv(value)
  return env
}

const expandedHeaders = (server: McpServerConfig) =>
  Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, expandEnv(v)]))

/** The real connector: stdio child process, or Streamable HTTP with an SSE fallback. */
export const defaultConnector: Connector = async (server, makeClient) => {
  if (server.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: expandEnv(server.command ?? ''),
      args: (server.args ?? []).map((a) => expandEnv(a)),
      env: childEnv(server),
      ...(server.cwd && { cwd: expandEnv(server.cwd) }),
      stderr: 'pipe'
    })
    // Keep the end of stderr for error messages; reading it also stops the pipe filling up.
    let tail = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-2000)
    })
    const client = makeClient()
    await client.connect(transport)
    return { client, stderrTail: () => tail.trim() }
  }

  const url = new URL(expandEnv(server.url ?? ''))
  const requestInit = { headers: expandedHeaders(server) }
  if (server.transport === 'http') {
    const client = makeClient()
    try {
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit }))
      return { client }
    } catch (err) {
      await client.close().catch(() => {})
      // Older servers only speak SSE; try that before giving up.
      const fallback = makeClient()
      try {
        await fallback.connect(new SSEClientTransport(url, { requestInit }) as Transport)
        return { client: fallback }
      } catch {
        await fallback.close().catch(() => {})
        throw err
      }
    }
  }
  const client = makeClient()
  await client.connect(new SSEClientTransport(url, { requestInit }) as Transport)
  return { client }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ]).finally(() => clearTimeout(timer))
}

/** MCP tool result -> our ToolResult. */
export function convertCallResult(result: Record<string, unknown>): ToolResult {
  const content: ToolResultContent[] = []
  const items = Array.isArray(result['content']) ? (result['content'] as Record<string, unknown>[]) : []
  for (const item of items) {
    switch (item['type']) {
      case 'text':
        content.push({ type: 'text', text: String(item['text'] ?? '') })
        break
      case 'image':
        content.push({ type: 'image', mediaType: String(item['mimeType'] ?? 'image/png'), dataBase64: String(item['data'] ?? '') })
        break
      case 'resource': {
        const resource = (item['resource'] ?? {}) as Record<string, unknown>
        content.push({
          type: 'text',
          text: typeof resource['text'] === 'string'
            ? `${resource['uri'] ?? 'resource'}:\n${resource['text']}`
            : `[binary resource ${resource['uri'] ?? ''} (${resource['mimeType'] ?? 'unknown type'})]`
        })
        break
      }
      case 'resource_link':
        content.push({ type: 'text', text: `Link: ${item['name'] ?? ''} ${item['uri'] ?? ''}`.trim() })
        break
      default:
        content.push({ type: 'text', text: `[${String(item['type'])} content]` })
    }
  }
  if (content.length === 0 && result['structuredContent'] !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(result['structuredContent'], null, 2) })
  }
  if (content.length === 0 && result['toolResult'] !== undefined) {
    content.push({ type: 'text', text: JSON.stringify(result['toolResult'], null, 2) })
  }
  if (content.length === 0) content.push({ type: 'text', text: '(no output)' })
  return { content, ...(result['isError'] === true && { isError: true }) }
}

export function createMcpHost(deps: {
  db: Db
  bus: EventBus
  homeDir: string
  store: Pick<Store, 'bots'>
  connector?: Connector
}): PlatformMcpHost {
  const { db, bus } = deps
  const connector = deps.connector ?? defaultConnector
  const conns = new Map<Id, Conn>()

  const changed = () => bus.emit('mcp:changed', { at: Date.now() })
  const all = () => db.prepare('select * from mcp_servers order by created_at, rowid').all().map(toConfig)
  const get = (id: Id) => {
    const row = db.prepare('select * from mcp_servers where id = ?').get(id)
    return row ? toConfig(row) : undefined
  }
  const conn = (id: Id): Conn => {
    let c = conns.get(id)
    if (!c) {
      c = { status: { state: 'stopped' }, tools: [], generation: 0, attempts: 0 }
      conns.set(id, c)
    }
    return c
  }

  const setStatus = (c: Conn, status: McpServerStatus) => {
    c.status = status
    changed()
  }

  const stop = async (id: Id) => {
    const c = conns.get(id)
    if (!c) return
    c.generation++
    clearTimeout(c.retryTimer)
    const client = c.client
    c.client = undefined
    c.starting = undefined
    c.tools = []
    c.instructions = undefined
    c.status = { state: 'stopped' }
    if (client) await client.close().catch(() => {})
  }

  const listAllTools = async (client: Client): Promise<ServerTool[]> => {
    const tools: ServerTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...result.tools)
      cursor = result.nextCursor
      if (!cursor) break
    }
    return tools
  }

  const scheduleRestart = (id: Id, c: Conn) => {
    if (c.connectedAt && Date.now() - c.connectedAt > STABLE_AFTER_MS) c.attempts = 0
    const delay = RESTART_BACKOFF_MS[c.attempts]
    if (delay === undefined) return // gave up; the next use will try again
    c.attempts++
    const generation = c.generation
    c.retryTimer = setTimeout(() => {
      if (c.generation !== generation) return
      void start(id).catch(() => {})
    }, delay)
    c.retryTimer.unref?.()
  }

  const start = (id: Id): Promise<void> => {
    const server = get(id)
    if (!server) return Promise.reject(new Error('Connector not found'))
    const c = conn(id)
    if (c.starting) return c.starting
    const generation = ++c.generation
    clearTimeout(c.retryTimer)
    setStatus(c, { state: 'starting' })

    const run = async () => {
      let stderrTail: (() => string) | undefined
      // Every client this attempt opens, so a connect or tools/list that hangs past the timeout
      // can still be closed (otherwise its child process or connection outlives the attempt).
      const created: Client[] = []
      try {
        const makeClient = () => {
          const client = new Client(CLIENT_INFO, {
            capabilities: {},
            listChanged: {
              tools: {
                onChanged: (error, tools) => {
                  if (c.generation !== generation || error || !tools) return
                  c.tools = tools
                  setStatus(c, { state: 'ready', toolCount: tools.length })
                }
              }
            }
          })
          created.push(client)
          return client
        }
        const timeoutSec = server.startupTimeoutSec ?? DEFAULT_STARTUP_SEC
        const opening = (async () => {
          const opened = await connector(server, makeClient)
          stderrTail = opened.stderrTail
          return { client: opened.client, tools: await listAllTools(opened.client) }
        })()
        opening.catch(() => {}) // a late failure after the timeout is handled below
        const { client, tools } = await withTimeout(opening, timeoutSec * 1000, `${server.name} did not start within ${timeoutSec} s`)
        if (c.generation !== generation) {
          await client.close().catch(() => {})
          return
        }
        c.client = client
        c.tools = tools
        c.instructions = client.getInstructions()?.slice(0, MAX_INSTRUCTIONS)
        c.stderrTail = stderrTail
        c.connectedAt = Date.now()
        c.failedAt = undefined
        client.onclose = () => {
          if (c.generation !== generation || c.client !== client) return
          c.client = undefined
          c.tools = []
          const tail = c.stderrTail?.()
          setStatus(c, { state: 'error', message: `The server stopped${tail ? `: ${tail.split('\n').pop()}` : ''}` })
          c.failedAt = Date.now()
          scheduleRestart(id, c)
        }
        setStatus(c, { state: 'ready', toolCount: tools.length })
      } catch (err) {
        for (const client of created) void client.close().catch(() => {})
        if (c.generation !== generation) return
        const tail = stderrTail?.()
        const message = err instanceof Error ? err.message : String(err)
        c.failedAt = Date.now()
        setStatus(c, { state: 'error', message: tail ? `${message} (${tail.split('\n').pop()})` : message })
        throw err
      } finally {
        if (c.generation === generation) c.starting = undefined
      }
    }
    c.starting = run()
    return c.starting
  }

  /** Start if needed; skips servers that failed moments ago unless forced. */
  const ensure = async (id: Id, force = false): Promise<Conn> => {
    const c = conn(id)
    if (c.status.state === 'ready' && c.client) return c
    if (!force && c.status.state === 'error' && c.failedAt && Date.now() - c.failedAt < FAILURE_COOLDOWN_MS) {
      throw new Error(c.status.message)
    }
    await start(id)
    return c
  }

  const serversForBot = (bot: Bot) =>
    all().filter((s) => s.enabled && (bot.mcpServerIds === 'all' || bot.mcpServerIds.includes(s.id)))

  const definitions = (server: McpServerConfig, c: Conn): ToolDefinition[] =>
    c.tools
      .filter((t) => !server.disabledTools.includes(t.name))
      .map((tool): ToolDefinition => ({
        name: mcpToolName(server.name, tool.name),
        description: (tool.description || tool.title || `${tool.name} from ${server.name}`).slice(0, 4000),
        inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object' },
        source: 'mcp',
        serverId: server.id,
        remoteName: tool.name,
        defaultPermission: 'ask',
        activityLabel: `Using ${server.name}`,
        summarize: (input) => {
          const args = JSON.stringify(input ?? {})
          return `Use ${tool.name} on ${server.name}${args === '{}' ? '' : ` with ${args.length > 500 ? `${args.slice(0, 500)}…` : args}`}`
        },
        async execute(input, ctx) {
          let live: Conn
          try {
            live = await ensure(server.id)
          } catch (err) {
            return errorResult(`${server.name} is not available: ${err instanceof Error ? err.message : String(err)}`)
          }
          try {
            const result = await live.client!.callTool(
              { name: tool.name, arguments: (input ?? {}) as Record<string, unknown> },
              undefined,
              { signal: ctx.signal, timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true }
            )
            return convertCallResult(result as Record<string, unknown>)
          } catch (err) {
            if (ctx.signal.aborted) return errorResult('Cancelled.')
            return errorResult(`${tool.name} on ${server.name} failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }))

  /** Unique names across servers (two servers can sanitize to the same prefix). */
  const dedupe = (defs: ToolDefinition[]) => {
    const seen = new Set<string>()
    return defs.map((def) => {
      let name = def.name
      for (let n = 2; seen.has(name); n++) name = `${def.name.slice(0, 60)}_${n}`
      seen.add(name)
      return name === def.name ? def : { ...def, name }
    })
  }

  const toolsFor = async (servers: McpServerConfig[]) => {
    const lists = await Promise.all(
      servers.map(async (server) => {
        try {
          return definitions(server, await ensure(server.id))
        } catch {
          return [] // its status already says why
        }
      })
    )
    return dedupe(lists.flat())
  }

  const save = (input: McpServerInput & { id?: Id }): McpServerConfig => {
    const clean = validate(input)
    const existing = input.id ? get(input.id) : undefined
    if (input.id && !existing) throw new Error('Connector not found')
    const clash = all().find((s) => s.name.toLowerCase() === clean.name.toLowerCase() && s.id !== input.id)
    if (clash) throw new Error(`A connector named "${clean.name}" already exists`)
    const now = Date.now()
    const { id: _ignored, ...fields } = clean as McpServerInput & { id?: Id }
    const config: McpServerConfig = {
      ...fields,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    const { id, name, createdAt, updatedAt, ...data } = config
    db.prepare(
      `insert into mcp_servers (id, name, data, created_at, updated_at) values (?, ?, ?, ?, ?)
       on conflict (id) do update set name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`
    ).run(id, name, JSON.stringify(data), createdAt, updatedAt)
    if (existing && connectionKey(existing) !== connectionKey(config)) void stop(id) // reconnects on next use
    changed()
    return config
  }

  const importFile = (path: string, label: string, parse: (text: string) => McpServerInput[]) => {
    if (!existsSync(path)) throw new Error(`No ${label} config found at ${path}`)
    return parse(readFileSync(path, 'utf8'))
  }

  return {
    list: () => all().map((server) => ({ server, status: conns.get(server.id)?.status ?? { state: 'stopped' } })),

    save,

    delete(id) {
      void stop(id)
      conns.delete(id)
      db.prepare('delete from mcp_servers where id = ?').run(id)
      let touched = false
      for (const bot of deps.store.bots.list()) {
        if (bot.mcpServerIds !== 'all' && bot.mcpServerIds.includes(id)) {
          deps.store.bots.update(bot.id, { mcpServerIds: bot.mcpServerIds.filter((s) => s !== id) })
          touched = true
        }
      }
      if (touched) bus.emit('bots:changed', { bots: deps.store.bots.list() })
      changed()
    },

    async restart(id) {
      if (!get(id)) throw new Error('Connector not found')
      await stop(id)
      conn(id).attempts = 0
      try {
        await start(id)
      } catch {
        // the status carries the error
      }
      return conn(id).status
    },

    async tools(id) {
      const server = get(id)
      if (!server) throw new Error('Connector not found')
      const c = await ensure(id, true)
      return c.tools.map((t) => ({
        name: t.name,
        description: t.description ?? t.title ?? '',
        disabled: server.disabledTools.includes(t.name)
      }))
    },

    import(source: McpImportSource, json?: string) {
      let found: McpServerInput[]
      switch (source) {
        case 'claude':
          found = importFile(join(deps.homeDir, '.claude.json'), 'Claude Code', parseClaudeConfig)
          break
        case 'codex':
          found = importFile(join(deps.homeDir, '.codex', 'config.toml'), 'Codex', parseCodexConfig)
          break
        case 'cursor':
          found = importFile(join(deps.homeDir, '.cursor', 'mcp.json'), 'Cursor', parseCursorConfig)
          break
        case 'json':
          found = parseMcpJson(json ?? '')
          break
        default:
          throw new Error(`Unknown import source "${String(source)}"`)
      }
      // Never overwrite a connector the user already has; skip same-named ones.
      const taken = new Set(all().map((s) => s.name.toLowerCase()))
      const created: McpServerConfig[] = []
      for (const input of found) {
        if (taken.has(input.name.toLowerCase())) continue
        try {
          created.push(save(input))
          taken.add(input.name.toLowerCase())
        } catch (err) {
          console.warn(`[mcp] skipped ${input.name}:`, err instanceof Error ? err.message : err)
        }
      }
      return created
    },

    toolsForBot: (bot) => toolsFor(serversForBot(bot)),

    allTools: () => toolsFor(all().filter((s) => s.enabled)),

    instructionsForBot(bot) {
      const blocks: string[] = []
      for (const server of serversForBot(bot)) {
        const parts = [conns.get(server.id)?.instructions?.trim(), server.customInstructions.trim()].filter(Boolean)
        if (parts.length) blocks.push(`## Connector: ${server.name}\n${parts.join('\n\n')}`)
      }
      return blocks.join('\n\n')
    },

    async shutdown() {
      await Promise.all([...conns.keys()].map((id) => stop(id)))
    }
  }
}
