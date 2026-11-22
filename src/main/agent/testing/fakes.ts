// Test harness for the runtime: a real in-memory store, the real ToolRegistry and ApprovalService,
// stubs for the other platform services, and a scriptable fake TurnEngine. Not used by app code.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Bot, Conversation, Id, NewBot } from '@shared/domain'
import type {
  AttachmentStore,
  McpHost,
  MemoryService,
  RecipeService,
  SecretVault,
  Services,
  SkillService,
  ToolBridge,
  ToolResult
} from '../../contracts'
import { createProviderService, type ProviderServiceDeps, type RuntimeProviders } from '../../providers/provider-service'
import { openStore, type PlatformStore } from '../../store'
import { fakeBus } from '../../store/test-helpers'
import { createApprovalService, createToolRegistry } from '../../tools'
import type { EngineKind } from '../../providers/catalog'
import type { EngineTurn, TurnEngine } from '../engine'
import { createRuntime, type CreateRuntimeOptions } from '../index'
import type { Orchestrator } from '../orchestrator'

const unused = (name: string) => () => {
  throw new Error(`${name} is not used in runtime tests`)
}

export function fakeSecrets(): SecretVault & { keys: Map<string, string> } {
  const keys = new Map<string, string>()
  return {
    keys,
    list: () => [],
    set: unused('secrets.set'),
    delete: () => {},
    envForBot: () => ({}),
    getProviderKey: (id) => keys.get(id),
    setProviderKey: (id, key) => {
      if (key) keys.set(id, key)
      else keys.delete(id)
    },
    redact: (text) => text.replaceAll('sk-secret-value', '«secret:KEY»')
  }
}

export function stubMemory(block = ''): MemoryService {
  return {
    list: () => [],
    add: unused('memory.add'),
    update: unused('memory.update'),
    delete: () => {},
    getProfile: (botId) => ({ botId, content: '', updatedAt: 0 }),
    setProfile: unused('memory.setProfile'),
    search: () => [],
    promptBlock: () => block
  }
}

export function stubSkills(block = ''): SkillService {
  return {
    list: () => [],
    get: unused('skills.get'),
    findForBot: () => undefined,
    save: unused('skills.save'),
    delete: () => {},
    importFiles: () => [],
    rescan: () => [],
    promptBlock: () => block
  }
}

export function stubMcp(): McpHost & { toolsForBot: McpHost['toolsForBot']; allTools(): Promise<never[]> } {
  return {
    list: () => [],
    save: unused('mcp.save'),
    delete: () => {},
    restart: unused('mcp.restart'),
    tools: async () => [],
    import: () => [],
    toolsForBot: async () => [],
    allTools: async () => [],
    instructionsForBot: () => '',
    shutdown: async () => {}
  }
}

export function stubBridge(): ToolBridge & { opened: number; closed: number } {
  const bridge = {
    opened: 0,
    closed: 0,
    async open() {
      bridge.opened++
      return { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer test-token' }, close: () => void bridge.closed++ }
    },
    async shutdown() {}
  }
  return bridge
}

const stubAttachments: AttachmentStore = {
  ingest: (paths) =>
    paths.map((path, i) => ({ id: `att-${i}`, name: path.split(/[\\/]/).pop() ?? path, mimeType: 'text/plain', sizeBytes: 3, path })),
  read: () => Buffer.from('abc')
}

const stubRecipes: RecipeService = { exportRecipe: unused('recipes.export'), importRecipe: unused('recipes.import') }

export type TestServices = Omit<Services, 'providers' | 'runtime' | 'routines' | 'webhooks' | 'missions'> & {
  store: PlatformStore
  bus: ReturnType<typeof fakeBus>
  secrets: ReturnType<typeof fakeSecrets>
  bridge: ReturnType<typeof stubBridge>
}

export function createTestServices(opts: { homeDir?: string; databasePath?: string } = {}): TestServices & { cleanup(): void } {
  const homeDir = opts.homeDir ?? mkdtempSync(join(tmpdir(), 'faibots-runtime-'))
  const store = openStore(opts.databasePath ?? ':memory:', { homeDir, userName: 'Alex' })
  store.settings.update({ workspaceRoot: join(homeDir, 'workspaces'), userName: 'Alex' })
  const bus = fakeBus()
  const secrets = fakeSecrets()
  const mcp = stubMcp()
  const approvals = createApprovalService({ store, bus })
  const tools = createToolRegistry({ store, approvals, secrets, mcp, bus })
  return {
    dataDir: join(homeDir, 'data'),
    bus,
    store,
    secrets,
    memory: stubMemory(),
    skills: stubSkills(),
    tools,
    approvals,
    mcp,
    bridge: stubBridge(),
    recipes: stubRecipes,
    attachments: stubAttachments,
    cleanup() {
      store.close()
      if (!opts.homeDir) rmSync(homeDir, { recursive: true, force: true })
    }
  }
}

/** What a fake turn script can do. */
export interface TurnApi {
  turn: EngineTurn
  /** Stream a message (in a few deltas) and end it. */
  say(text: string): void
  /** Call a tool through the runtime (card, registry, approvals). */
  tool(name: string, input: unknown): Promise<ToolResult>
  pass(): Promise<ToolResult>
  /** Resolves when the turn is stopped. */
  untilAborted(): Promise<void>
}

export interface TurnRecord {
  botId: Id
  handle: string
  conversationId: Id
  turnNote: string
  chain: Id[]
  inGroup: boolean
  upToSeq: number
  lastSeenSeq: number
  /** Texts of the message entries this turn could see that it had not seen before. */
  newTexts: string[]
  /** The system prompt delivered to the engine (mission tests check manifest-lite in it). */
  system?: { stable: string; volatile: string }
}

export type TurnScript = (api: TurnApi) => Promise<void> | void

/** A TurnEngine driven by per-bot scripts (by handle). Records every turn it runs. */
export class FakeEngine implements TurnEngine {
  readonly turns: TurnRecord[] = []
  running = 0
  maxRunning = 0
  private readonly scripts = new Map<string, TurnScript>()
  private fallback: TurnScript = (api) => api.say(`Hello from ${api.turn.bot.name}`)

  constructor(private readonly store: () => PlatformStore) {}

  script(handle: string, fn: TurnScript): this {
    this.scripts.set(handle, fn)
    return this
  }

  otherwise(fn: TurnScript): this {
    this.fallback = fn
    return this
  }

  async run(turn: EngineTurn): Promise<void> {
    const store = this.store()
    const newTexts = store.entries
      .since(turn.conversation.id, turn.context.lastSeenSeq)
      .filter((e) => e.seq <= turn.upToSeq && e.kind === 'message' && !(e.author.kind === 'bot' && e.author.botId === turn.bot.id))
      .map((e) => e.text)
    this.turns.push({
      botId: turn.bot.id,
      handle: turn.bot.handle,
      conversationId: turn.conversation.id,
      turnNote: turn.turnNote,
      chain: turn.toolContext.chain,
      inGroup: turn.toolContext.inGroup,
      upToSeq: turn.upToSeq,
      lastSeenSeq: turn.context.lastSeenSeq,
      newTexts,
      system: { stable: turn.system.stable, volatile: turn.system.volatile }
    })
    this.running++
    this.maxRunning = Math.max(this.maxRunning, this.running)
    let n = 0
    const api: TurnApi = {
      turn,
      say(text) {
        turn.recorder.phase('typing')
        const half = Math.ceil(text.length / 2)
        turn.recorder.textDelta(text.slice(0, half))
        turn.recorder.textDelta(text.slice(half))
        turn.recorder.endText()
      },
      tool: (name, input) => turn.runTool({ id: `call-${turn.turnId}-${n++}`, name, input }),
      pass: () => turn.runTool({ id: `call-${turn.turnId}-${n++}`, name: 'pass_turn', input: {} }),
      untilAborted: () =>
        new Promise<void>((resolve) => {
          if (turn.signal.aborted) resolve()
          else turn.signal.addEventListener('abort', () => resolve(), { once: true })
        })
    }
    try {
      await (this.scripts.get(turn.bot.handle) ?? this.fallback)(api)
    } finally {
      this.running--
    }
  }
}

export interface Harness {
  services: TestServices
  providers: RuntimeProviders
  runtime: Orchestrator
  engine: FakeEngine
  providerId: Id
  bot(name: string, extra?: Partial<NewBot>): Bot
  group(bots: Bot[], settings?: Partial<NonNullable<Conversation['group']>>): Conversation
  send(conversationId: Id, text: string, extra?: { mentions?: Id[]; mentionsEveryone?: boolean }): Promise<void>
  /** Message texts of a conversation as "handle: text" ("you: …" for the user). */
  transcript(conversationId: Id): string[]
  cleanup(): void
}

let nonce = 0

export function createHarness(
  opts: {
    runtime?: CreateRuntimeOptions
    providers?: Partial<ProviderServiceDeps>
    diskProfile?: string
    attachments?: (dataDir: string) => AttachmentStore
    /** Build real engines from the harness services (the fake engine covers the rest). */
    engines?: (services: TestServices, providers: RuntimeProviders) => Partial<Record<EngineKind, TurnEngine>>
  } = {}
): Harness {
  const services = createTestServices(opts.diskProfile ? { homeDir: opts.diskProfile, databasePath: join(opts.diskProfile, 'faibots.db') } : {})
  if (opts.attachments) services.attachments = opts.attachments(services.dataDir)
  const providers = createProviderService({ store: services.store, secrets: services.secrets, bus: services.bus, ...opts.providers })
  const provider = providers.save({
    kind: 'openai-compatible',
    label: 'Local test model',
    baseUrl: 'http://localhost:11434/v1',
    defaultModelId: 'test-model',
    enabled: true
  })
  const engine = new FakeEngine(() => services.store)
  const runtime = createRuntime(
    { ...services, providers },
    {
      ...opts.runtime,
      engines: { native: engine, 'claude-code': engine, codex: engine, ...opts.runtime?.engines, ...opts.engines?.(services, providers) }
    }
  )
  const harness: Harness = {
    services,
    providers,
    runtime,
    engine,
    providerId: provider.id,
    bot(name, extra) {
      return services.store.bots.create({ name, model: { providerId: provider.id, modelId: '' }, ...extra })
    },
    group(bots, settings) {
      return runtime.createGroup({ title: 'Team', botIds: bots.map((b) => b.id), ...(settings && { settings }) })
    },
    async send(conversationId, text, extra) {
      await runtime.send({
        conversationId,
        text,
        mentions: extra?.mentions ?? [],
        mentionsEveryone: extra?.mentionsEveryone ?? false,
        attachmentPaths: [],
        clientNonce: `nonce-${++nonce}`
      })
      await runtime.idle()
    },
    transcript(conversationId) {
      return services.store.entries
        .page(conversationId, { limit: 500 })
        .entries.filter((e) => e.kind === 'message')
        .map((e) => `${e.author.kind === 'bot' ? services.store.bots.get(e.author.botId)?.handle : 'you'}: ${e.text}`)
    },
    cleanup() {
      services.cleanup()
    }
  }
  return harness
}
