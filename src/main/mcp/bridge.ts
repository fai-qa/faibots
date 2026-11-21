// ToolBridge: FaiBots's own tools (memory, skills, send_to_agent, …) served as a local MCP server,
// so external engines (Claude Code, Codex) can call them. One HTTP server on 127.0.0.1 with a
// random port; each turn gets its own bearer token, and the token decides which bot and
// conversation the tools run as. Stateless Streamable HTTP: one MCP server object per request.

import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolBridge, ToolContext, ToolRegistry, ToolResult } from '../contracts'

const PATH = '/mcp'

type TurnContext = Omit<ToolContext, 'callId'>

function toMcpResult(result: ToolResult) {
  return {
    content: result.content.map((c) =>
      c.type === 'text' ? { type: 'text' as const, text: c.text } : { type: 'image' as const, data: c.dataBase64, mimeType: c.mediaType }
    ),
    ...(result.isError && { isError: true })
  }
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

export function createToolBridge(deps: { registry: ToolRegistry }): ToolBridge {
  const turns = new Map<string, TurnContext>()
  let http: HttpServer | undefined
  let listening: Promise<number> | undefined

  /** The tools an external engine gets: everything for this turn except MCP tools, which it is given directly. */
  const toolsFor = async (ctx: TurnContext) =>
    (await deps.registry.forTurn(ctx)).filter((t) => !t.name.startsWith('mcp__') && (!ctx.admittedTools || ctx.admittedTools.has(t.name)))

  const mcpServerFor = (ctx: TurnContext) => {
    const server = new Server({ name: 'faibots', version: '0.1.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await toolsFor(ctx)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as { type: 'object'; [k: string]: unknown }
      }))
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params
      if (!(await toolsFor(ctx)).some((t) => t.name === name)) {
        return { content: [{ type: 'text' as const, text: `Unknown tool "${name}".` }], isError: true }
      }
      const result = await deps.registry.execute(name, args ?? {}, {
        ...ctx,
        callId: randomUUID(),
        signal: AbortSignal.any([ctx.signal, extra.signal])
      })
      return toMcpResult(result)
    })
    return server
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== PATH) return sendJson(res, 404, 'Not found')
    const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim()
    const ctx = token ? turns.get(token) : undefined
    if (!ctx) return sendJson(res, 401, 'Unauthorized')
    // Stateless server: no standalone SSE stream and no sessions to delete.
    if (req.method !== 'POST') return sendJson(res, 405, 'Method not allowed')

    const server = mcpServerFor(ctx)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }

  const ensureListening = (): Promise<number> => {
    if (listening) return listening
    listening = new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        handle(req, res).catch((err) => {
          console.error('[bridge] request failed:', err instanceof Error ? err.message : err)
          if (!res.headersSent) sendJson(res, 500, 'Internal error')
          else res.end()
        })
      })
      server.once('error', (err) => {
        listening = undefined
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        http = server
        resolve((server.address() as AddressInfo).port)
      })
    })
    return listening
  }

  return {
    async open(ctx) {
      const port = await ensureListening()
      const token = randomBytes(32).toString('base64url')
      turns.set(token, ctx)
      return {
        url: `http://127.0.0.1:${port}${PATH}`,
        headers: { Authorization: `Bearer ${token}` },
        close: () => {
          turns.delete(token)
        }
      }
    },

    async shutdown() {
      turns.clear()
      const server = http
      http = undefined
      listening = undefined
      if (!server) return
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}
