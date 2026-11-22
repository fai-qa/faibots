import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import type { SDKMessage, Options, query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import type { ThreadEvent } from '@openai/codex-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it } from 'vitest'
import type { ContextScope } from '@shared/turn-context'
import type { ToolBridge, ToolDefinition } from '../contracts'
import { createToolBridge } from '../mcp/bridge'
import { safeModelId, turnContextHandlers } from '../store/turn-context'
import { createCodexEngine } from './codex-engine'
import { createClaudeCodeEngine } from './claude-code-engine'
import { createNativeEngine } from './native-engine'
import { projectResultTool } from './project-result-tool'
import { projectSessionHandlers } from '../ipc/project-sessions'
import { createHarness } from './testing/fakes'
import { say, ScriptedAdapter } from './testing/scripted-adapter'

const connector: ToolDefinition = {
  name: 'mcp__local__note',
  source: 'mcp',
  serverId: 'local',
  remoteName: 'note',
  description: 'Read fixture note',
  inputSchema: { type: 'object' },
  defaultPermission: 'ask',
  activityLabel: 'Reading note',
  execute: async () => ({ content: [] })
}

async function enumerateBridge(endpoint: { url: string; headers: Record<string, string> }) {
  expect(new URL(endpoint.url).hostname).toBe('127.0.0.1')
  const client = new Client({ name: 'catalog-fixture', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: endpoint.headers } })
  )
  try {
    return (await client.listTools()).tools.map((t) => 'mcp__faibots__' + t.name)
  } finally {
    await client.close()
  }
}

it.each(['native', 'codex', 'claude-code'] as const)(
  'records the actual %s dispatch, scoped to the originating chat',
  async (engine) => {
    let offered: string[] = []
    let transport: ToolBridge | undefined
    const adapter = new ScriptedAdapter([say('Fixture received.'),say('Selected result received.')])
    const h = createHarness({
      engines(services, providers) {
        services.mcp.toolsForBot = async () => [connector]
        if (engine === 'native')
          return {
            native: createNativeEngine({
              store: services.store,
              attachments: services.attachments,
              providers: { ...providers, adapterFor: () => adapter, modelInfo: async () => undefined }
            })
          }
        const bridge = createToolBridge({ registry: services.tools })
        transport = bridge
        if (engine === 'codex')
          return {
            codex: createCodexEngine({
              store: services.store,
              providers,
              bridge,
              codex: (options) => {
                const cfg = options.configOverrides!.find((v) => v.startsWith('mcp_servers='))!
                const endpoint = {
                  url: JSON.parse(/url = ("[^"]+")/.exec(cfg)![1]!),
                  headers: { Authorization: 'Bearer ' + options.env!.FAIBOTS_BRIDGE_TOKEN }
                }
                const thread = {
                  async runStreamed() {
                    offered = await enumerateBridge(endpoint)
                    expect(cfg).toContain('list_bots = { approval_mode = "approve" }')
                    const events = (async function* (): AsyncGenerator<ThreadEvent> {
                      yield {
                        type: 'item.completed',
                        item: { id: 'msg', type: 'agent_message', text: 'Fixture received.' }
                      }
                      yield {
                        type: 'turn.completed',
                        usage: {
                          input_tokens: 1,
                          output_tokens: 1,
                          cached_input_tokens: 0,
                          cache_write_input_tokens: 0,
                          reasoning_output_tokens: 0
                        }
                      }
                    })()
                    return { events }
                  }
                }
                return { startThread: () => thread, resumeThread: () => thread }
              }
            })
          }
        const query = (({ options }: { options: Options }) =>
          Object.assign(
            (async function* () {
              const faibots = options.mcpServers!.faibots
              if (!faibots || faibots.type !== 'http') throw new Error('Expected the app bridge')
              offered = await enumerateBridge({ url: faibots.url, headers: faibots.headers! })
              const connectors = options.mcpServers!.connectors
              if (!connectors || connectors.type !== 'sdk') throw new Error('Expected the connector transport')
              const [app, sdk] = InMemoryTransport.createLinkedPair()
              const client = new Client({ name: 'connector-fixture', version: '1' })
              await connectors.instance.connect(app)
              await client.connect(sdk)
              try {
                offered.push(...(await client.listTools()).tools.map((t) => 'mcp__connectors__' + t.name))
              } finally {
                await client.close()
                await connectors.instance.close()
              }
              yield {
                type: 'assistant',
                parent_tool_use_id: null,
                message: { id: 'msg', content: [{ type: 'text', text: 'Fixture received.' }] }
              } as SDKMessage
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 'test',
                result: 'Fixture received.',
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0
                }
              } as SDKMessage
            })(),
            { close() {} }
          )) as unknown as typeof claudeQuery
        return { 'claude-code': createClaudeCodeEngine({ ...services, bridge, query }) }
      }
    })
    try {
      const { store, tools } = h.services
      tools.register(projectResultTool(store,h.services))
      const providerId =
        engine === 'native'
          ? h.providerId
          : h.providers.save({
              kind: engine,
              label: 'Local fixture',
              defaultModelId: 'unit-model',
              enabled: true
            }).id
      const bot = h.bot('Catalog', { model: { providerId, modelId: 'unit-model' } })
      tools.setPermission('list_bots', 'ask', bot.id)
      tools.setPermission('send_to_agent', 'never', bot.id)
      const dm = h.runtime.openDm(bot.id)
      const group = h.group([bot], { maxRounds: 1 })
      const room = engine === 'native' ? dm : group
      const body = 'private fixture prompt sk-secret-value'
      const entry = await h.runtime.send({
        conversationId: room.id,
        text: body,
        mentions: [bot.id],
        mentionsEveryone: false,
        attachmentPaths: ['C:/private-fixture/never-display-me.txt'],
        clientNonce: 'unit-nonce'
      })
      await h.runtime.idle()
      expect(h.transcript(room.id).join(' ')).toContain('Fixture received.')
      if (engine === 'native') offered = adapter.specs[0]!.tools.map((t) => t.name)
      const get = turnContextHandlers(h.services, store)['context:turns']
      const scope: ContextScope = { kind: 'chat', conversationId: room.id }
      const [receipt] = get({ scope }).turns
      expect(receipt).toMatchObject({
        botId: bot.id,
        scopeId: room.id,
        route: room.kind,
        providerId,
        modelId: 'unit-model',
        engine,
        sources: [
          { kind: 'attachment', entryId: entry.id, sha256: createHash('sha256').update('abc').digest('hex') }
        ]
      })
      expect(receipt!.tools.map((t) => t.exposedAs).sort()).toEqual(offered.sort())
      expect(receipt!.tools.find((t) => t.name === 'list_bots')).toMatchObject({ permission: 'ask' })
      expect(receipt!.tools.some((t) => t.name === connector.name)).toBe(engine !== 'codex')
      expect(receipt!.tools.some((t) => t.name === 'send_to_agent')).toBe(false)
      expect(receipt!.tools.some((t) => t.name === 'read_project_result')).toBe(false)
      expect(receipt!.omissions).toContain('Turned off by permission: send_to_agent.')
      expect(receipt!.tools.some((t) => t.name === 'pass_turn')).toBe(room.kind === 'group')
      expect(
        get({ scope: { kind: 'chat', conversationId: (room === dm ? group : dm).id }, turnId: receipt!.id })
          .turns
      ).toEqual([])
      const stored = store.db.prepare('select payload from turn_context_receipts').get()!.payload
      expect(stored).not.toContain(body)
      expect(stored).not.toContain('never-display-me')
      expect(stored).not.toContain('Bearer')
      expect(stored).not.toContain('sk-secret-value')
      const attachment = entry.attachments[0]!
      store.entries.update(entry.id, { attachments: [{ ...attachment, sizeBytes: 51 * 1024 * 1024 }] })
      expect(get({ scope }).turns[0]!.sources).toEqual([{ kind: 'withheld', reason: 'verification-limit' }])
      store.entries.update(entry.id, { attachments: [] })
      expect(get({ scope }).turns[0]!.sources).toEqual([{ kind: 'withheld' }])
      h.runtime.reset(room.id)
      expect(get({ scope }).turns).toEqual([])
      mkdirSync(h.services.dataDir,{recursive:true})
      const chief = h.bot('fai',{isPrimary:true,model:{providerId,modelId:'unit-model'}})
      const selectedChat = h.runtime.openDm(chief.id)
      const project = store.projects.create({name:'Fixture selection'})
      store.projectSources.insert({projectId:project.id,attachmentId:'fixture-copy',name:'note.md',sizeBytes:3,kind:'md',
        sha256:createHash('sha256').update('abc').digest('hex')})
      const handlers = projectSessionHandlers({...h.services,runtime:h.runtime,providers:h.providers},store)
      const address = handlers['session:project']({projectId:project.id}).address
      const session = handlers['session:open']({...address,mode:'fresh'}).session
      const selected = await handlers['session:lookup']({...address,sessionId:session.id,query:'abc',requestId:randomUUID()})
      await handlers['session:ask-fai']({...address,sessionId:session.id,answerId:selected.id,requestId:randomUUID(),instruction:'Summarize the result.'})
      await h.runtime.idle()
      if (engine === 'native') offered = adapter.specs.at(-1)!.tools.map(t=>t.name)
      const [authorized] = get({scope:{kind:'chat',conversationId:selectedChat.id}}).turns
      expect(authorized!.tools.map(t=>t.exposedAs).sort()).toEqual(offered.sort())
      expect(authorized!.tools.find(t=>t.name==='read_project_result')).toMatchObject({
        exposedAs:engine==='native'?'read_project_result':'mcp__faibots__read_project_result',
        ...(engine==='codex' && {hostApproval:'app'})
      })
    } finally {
      await h.runtime.shutdown()
      await transport?.shutdown()
      h.cleanup()
    }
  }
)

it('binds a mission dispatch to its selected revision and keeps the hash private when project access changes', async () => {
  const adapter = new ScriptedAdapter([say('Draft received.')])
  const h = createHarness({
    engines: (services, providers) => ({
      native: createNativeEngine({
        store: services.store,
        attachments: services.attachments,
        providers: { ...providers, adapterFor: () => adapter, modelInfo: async () => undefined }
      })
    })
  })
  try {
    const { store } = h.services
    const project = store.projects.create({ name: 'Fixture' })
    const bot = h.bot('Writer')
    const source = store.projectSources.insert({
      projectId: project.id,
      attachmentId: 'attachment',
      name: 'notes.md',
      sizeBytes: 3,
      kind: 'md',
      sha256: createHash('sha256').update('abc').digest('hex')
    })
    const run = store.journeyRuns.start({ projectId: project.id, status: 'working', startedAt: Date.now() })
    const [pin] = store.projectContent.recordContext(run, [source], 'fixture')
    const result = await h.runtime.runAutomated({
      botId: bot.id,
      text: 'Use the selected note.',
      trigger: { kind: 'mission', projectId: project.id, projectName: 'Fixture', artifactName: 'Output' },
      projectRun: { projectId: project.id, runId: run.id },
      manifestLite: { sources: [{ path: 'notes.md', sha256: source.sha256 }] }
    })
    expect(result.status).toBe('done')
    const get = turnContextHandlers(h.services, store)['context:turns']
    const query = {
      scope: { kind: 'chat' as const, conversationId: result.conversationId },
      turnId: result.turnId
    }
    expect(get(query).turns[0]).toMatchObject({
      id: result.turnId,
      projectId: project.id,
      sources: [{ kind: 'project', ...pin }]
    })
    store.projectContent.revoke(project.id, pin!.itemId)
    expect(get(query).turns[0]!.sources).toEqual([{ kind: 'withheld' }])
  } finally {
    await h.runtime.shutdown()
    h.cleanup()
  }
})

it('withholds custom URLs, vault values and absolute paths from model metadata', () => {
  const redact = (text: string) => text.replace('secret-token', 'redacted')
  for (const value of ['https://server/key', 'C:/other/model', '/var/private', 'secret-token'])
    expect(safeModelId(value, redact)).toBe('withheld')
  expect(safeModelId('namespace/the-model:latest', redact)).toBe('namespace/the-model:latest')
})
