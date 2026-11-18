import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Bot, Conversation } from '@shared/domain'
import type { ToolBridge, ToolContext, ToolRegistry } from '../contracts'
import { defineTool, textResult } from '../tools/define'
import { createToolRegistry } from '../tools/registry'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { createApprovalService } from '../tools/approvals'
import { createToolBridge } from './bridge'

describe('ToolBridge', () => {
  let store: PlatformStore
  let registry: ToolRegistry
  let bridge: ToolBridge
  let bot: Bot
  let conversation: Conversation
  let calls: { name: string; botId: string; conversationId: string; text: string }[]

  const connect = async (url: string, headers: Record<string, string>) => {
    const client = new Client({ name: 'test-engine', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
    return client
  }

  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/tmp' })
    const bus = fakeBus()
    calls = []
    registry = createToolRegistry({
      store,
      bus,
      approvals: createApprovalService({ store, bus }),
      secrets: { redact: (t) => t },
      mcp: {
        toolsForBot: async () => [{ ...whoami('mcp__ext__thing'), source: 'mcp' }],
        allTools: async () => []
      }
    })
    function whoami(name: string) {
      return defineTool({
        name,
        description: 'Say who is calling',
        schema: z.object({ text: z.string() }),
        source: 'faibots',
        defaultPermission: 'always',
        activityLabel: 'Checking',
        execute: async (input, ctx) => {
          calls.push({ name, botId: ctx.bot.id, conversationId: ctx.conversation.id, text: input.text })
          return textResult(`${ctx.bot.name} in ${ctx.conversation.id}: ${input.text}`)
        }
      })
    }
    registry.register(whoami('whoami'))
    registry.register({ ...whoami('group_only'), isAvailable: (c) => c.inGroup })
    bridge = createToolBridge({ registry })
    bot = store.bots.create({ name: 'Coder' })
    conversation = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
  })
  afterEach(async () => {
    await bridge.shutdown()
    store.close()
  })

  const turn = (): Omit<ToolContext, 'callId'> => ({
    bot, conversation, turnId: 'turn-1', signal: new AbortController().signal, chain: [], inGroup: false, workspaceDir: '/tmp/ws'
  })

  it('serves the turn\'s tools (minus MCP ones) on 127.0.0.1 and runs them as that bot', async () => {
    const endpoint = await bridge.open(turn())
    expect(endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(endpoint.headers.Authorization).toMatch(/^Bearer .{40,}$/)

    const client = await connect(endpoint.url, endpoint.headers)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(['whoami'])
    expect(tools[0]!.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } } })

    const result = await client.callTool({ name: 'whoami', arguments: { text: 'hello' } })
    expect(result.content).toEqual([{ type: 'text', text: `Coder in ${conversation.id}: hello` }])
    expect(calls).toEqual([{ name: 'whoami', botId: bot.id, conversationId: conversation.id, text: 'hello' }])

    const hidden = await client.callTool({ name: 'mcp__ext__thing', arguments: { text: 'x' } })
    expect(hidden.isError).toBe(true)
    const invalid = await client.callTool({ name: 'whoami', arguments: { text: 5 } })
    expect(invalid.isError).toBe(true)
    await client.close()
  })

  it('rejects unknown tokens and revokes a token on close', async () => {
    const endpoint = await bridge.open(turn())
    await expect(connect(endpoint.url, { Authorization: 'Bearer nope' })).rejects.toThrow()
    await expect(connect(endpoint.url, {})).rejects.toThrow()
    endpoint.close()
    await expect(connect(endpoint.url, endpoint.headers)).rejects.toThrow()
  })

  it('keeps concurrent turns apart', async () => {
    const other = store.bots.create({ name: 'Reviewer' })
    const otherConv = store.conversations.create({ kind: 'dm', title: '', botIds: [other.id] })
    const a = await bridge.open(turn())
    const b = await bridge.open({ ...turn(), bot: other, conversation: otherConv, inGroup: true })
    expect(new URL(a.url).port).toBe(new URL(b.url).port)
    const clientB = await connect(b.url, b.headers)
    expect((await clientB.listTools()).tools.map((t) => t.name)).toEqual(['whoami', 'group_only'])
    await clientB.callTool({ name: 'whoami', arguments: { text: 'b' } })
    const clientA = await connect(a.url, a.headers)
    await clientA.callTool({ name: 'whoami', arguments: { text: 'a' } })
    expect(calls.map((c) => [c.botId, c.text])).toEqual([[other.id, 'b'], [bot.id, 'a']])
    await clientA.close()
    await clientB.close()
  })
})
