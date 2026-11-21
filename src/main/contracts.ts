// Service contracts inside the main process.
//
// Ownership (see docs/BUILD-PLAN.md):
//   platform builder implements: Store repos, SecretVault, MemoryService, SkillService,
//                                McpHost, ToolBridge, ToolRegistry, ApprovalService, RecipeService
//   runtime builder implements:  ProviderService, Runtime (agent loop, groups, bot-to-bot)
//   integrator (index.ts, ipc/): wires everything and maps IPC channels to these methods
//
// Rules:
//   - Only src/main/index.ts, src/main/ipc/** and src/main/platform/** may import 'electron'.
//     Everything else must run under plain Node (vitest) with injected dependencies.
//   - All data crossing IPC uses the types in src/shared/domain.ts.

import type {
  AppSettings,
  ApprovalDecision,
  Attachment,
  Bot,
  BotLiveState,
  BotMemoryProfile,
  BotRecipe,
  Conversation,
  Entry,
  EntryTrigger,
  GroupSettings,
  Id,
  JourneyRun,
  ManifestLiteSource,
  McpServerConfig,
  McpServerStatus,
  MemoryFact,
  ModelInfo,
  NewBot,
  PermissionMode,
  ProviderConfig,
  Routine,
  RoutineInput,
  RoutineRun,
  RoutineRunTrigger,
  SecretInfo,
  Skill,
  SkillWithBody,
  ToolInfo,
  TurnTrigger,
  UsageSummary
} from '@shared/domain'
import type {
  EventMap,
  McpImportSource,
  ProviderTestResult,
  SaveProviderRequest,
  SendMessageRequest
} from '@shared/ipc'

export type { McpImportSource }

// ---------------------------------------------------------------------------
// Event bus (integrator implements; forwards to the renderer)
// ---------------------------------------------------------------------------

export interface EventBus {
  emit<C extends keyof EventMap>(channel: C, payload: EventMap[C]): void
}

// ---------------------------------------------------------------------------
// Persistence (platform) — node:sqlite, one file <dataDir>/faibots.db
// ---------------------------------------------------------------------------

export interface BotRepo {
  list(): Bot[]
  get(id: Id): Bot | undefined
  getByHandle(handle: string): Bot | undefined
  /** Fills defaults (handle from name, random avatar, default model from settings). */
  create(input: NewBot): Bot
  update(id: Id, patch: Partial<Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>>): Bot
  delete(id: Id): void
}

export interface ConversationRepo {
  list(): Conversation[]
  get(id: Id): Conversation | undefined
  /** The single dm conversation for a bot, if one exists. */
  findDm(botId: Id): Conversation | undefined
  /** The exchange between two bots (order-insensitive), if one exists. */
  findExchange(botA: Id, botB: Id): Conversation | undefined
  create(input: Omit<Conversation, 'id' | 'createdAt' | 'updatedAt' | 'lastEntryAt' | 'unreadCount' | 'notes'> & { notes?: string }): Conversation
  update(id: Id, patch: Partial<Omit<Conversation, 'id' | 'createdAt'>>): Conversation
  delete(id: Id): void
}

export type NewEntry = Omit<Entry, 'id' | 'seq' | 'createdAt' | 'updatedAt'> & { id?: Id }

export interface EntryRepo {
  /** Assigns id (unless given), seq, timestamps; bumps conversation.lastEntryAt. */
  append(entry: NewEntry): Entry
  update(id: Id, patch: Partial<Omit<Entry, 'id' | 'conversationId' | 'seq' | 'createdAt'>>): Entry
  get(id: Id): Entry | undefined
  findByNonce(conversationId: Id, clientNonce: string): Entry | undefined
  /** Newest-last page ending before beforeSeq (exclusive). */
  page(conversationId: Id, opts: { beforeSeq?: number; limit: number }): { entries: Entry[]; hasMore: boolean }
  /** Entries with seq > afterSeq, oldest first. */
  since(conversationId: Id, afterSeq: number, limit?: number): Entry[]
  /** Delete every entry of a conversation (reset). */
  clear(conversationId: Id): void
  /** All unfinished stream/tool entries, including older entries outside the recent page. */
  interrupted(): Entry[]
}

/** Per (conversation, bot) state the runtime keeps between turns. */
export interface BotContextState {
  conversationId: Id
  botId: Id
  /** Highest entry seq this bot has already been shown. */
  lastSeenSeq: number
  /** Native engines: rolling summary of entries up to summarizedUpToSeq. */
  summary: string
  summarizedUpToSeq: number
  /** External engines (Claude Code / Codex): their own session or thread id. */
  engineSessionId?: string
  /** The engine and provider identity that made engineSessionId; absent on rows from before it was recorded. */
  engineBinding?: string
  /** Codex: hash of the last system block delivered to the thread. */
  systemHash?: string
}

export interface BotContextRepo {
  get(conversationId: Id, botId: Id): BotContextState
  set(state: BotContextState): void
  clearConversation(conversationId: Id): void
}

export interface SettingsRepo {
  get(): AppSettings
  update(patch: Partial<AppSettings>): AppSettings
}

export interface ProviderRepo {
  list(): ProviderConfig[]
  get(id: Id): ProviderConfig | undefined
  save(input: Omit<SaveProviderRequest, 'apiKey'> & { hasApiKey: boolean }): ProviderConfig
  delete(id: Id): void
}

/** One bot turn that reached a model, as the turn log keeps it. */
export interface TurnRecord {
  id?: Id
  botId: Id
  conversationId: Id
  conversationKind: Conversation['kind']
  trigger: TurnTrigger
  status: 'sent' | 'pass' | 'error' | 'cancelled'
  providerId: Id
  modelId: string
  inputTokens: number
  outputTokens: number
  startedAt: number
  endedAt: number
  error?: string
}

export interface TurnLogRepo {
  /** Persist a daily slot before automatic work. False also rejects reused IDs/missing bots. */
  reserveAutomatic(input: { id: Id; botId: Id; startedAt: number }): boolean
  record(turn: TurnRecord): void
  /** Automatic reservations plus legacy logged turns at/after `since`, without double counting. */
  automaticRunsSince(botId: Id, since: number): number
  /** Totals per bot, local day, provider and model for turns started in [from, to). */
  summary(from: number, to: number): UsageSummary
}

export interface RoutineRepo {
  list(botId?: Id): Routine[]
  get(id: Id): Routine | undefined
  insert(input: Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'hasWebhookToken'> & { id?: Id }): Routine
  update(id: Id, patch: Partial<Omit<Routine, 'id' | 'botId' | 'createdAt' | 'updatedAt' | 'hasWebhookToken'>>): Routine
  delete(id: Id): void
  webhookTokenHash(id: Id): string | undefined
  setWebhookTokenHash(id: Id, hash: string | null): void
  startRun(input: Omit<RoutineRun, 'id' | 'summary'> & { summary?: string }): RoutineRun
  finishRun(id: Id, patch: Partial<Omit<RoutineRun, 'id' | 'routineId' | 'botId' | 'trigger' | 'startedAt'>>): RoutineRun
  runs(filter: { routineId?: Id; botId?: Id; limit?: number }): RoutineRun[]
  closeInterruptedRuns(now: number): number
}

export type ActionState = 'prepared' | 'claimed' | 'dispatched' | 'recovering' | 'unknown' | 'completed' | 'denied' | 'cancelled'

export interface ActionIntent {
  id: string
  botId: Id
  conversationId: Id
  toolName: string
  inputDigest: string
  /** Includes tool source, server and versioned recovery capability. */
  capability: string
}

export interface ActionRecord extends ActionIntent {
  state: ActionState
  attempt?: string
  approvedDigest?: string
  receipt?: ToolResult
  createdAt: number
  updatedAt: number
}

export type ActionClaim =
  | { kind: 'claimed'; record: ActionRecord; recovering: boolean }
  | { kind: 'receipt'; record: ActionRecord }
  | { kind: 'blocked'; reason: string }

export interface ActionRepo {
  get(id: string): ActionRecord | undefined
  /** Atomically reserve this identity; also block equivalent unresolved effects. */
  claim(intent: ActionIntent, canRecover: boolean): ActionClaim
  dispatch(id: string, attempt: string): void
  finish(id: string, attempt: string, state: 'completed' | 'denied' | 'cancelled' | 'unknown', receipt?: ToolResult): void
  /** Only at application startup, before any worker exists. Never on a second connection. */
  recoverInterrupted(): number
}

export interface Store {
  bots: BotRepo
  conversations: ConversationRepo
  entries: EntryRepo
  botContext: BotContextRepo
  settings: SettingsRepo
  providers: ProviderRepo
  turns: TurnLogRepo
  routines: RoutineRepo
  actions: ActionRepo
  close(): void
}

// ---------------------------------------------------------------------------
// Secrets (platform) — values encrypted with an injected cipher (Electron safeStorage in prod)
// ---------------------------------------------------------------------------

export interface Cipher {
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface SecretVault {
  list(botId?: Id): SecretInfo[]
  set(input: { botId?: Id; name: string; description: string; value: string }): SecretInfo
  delete(id: Id): void
  /** Env vars for a bot's tool processes (its own secrets). */
  envForBot(botId: Id): Record<string, string>
  getProviderKey(providerId: Id): string | undefined
  setProviderKey(providerId: Id, key: string | null): void
  /** Replace any known secret value in text with «secret:NAME». */
  redact(text: string): string
}

// ---------------------------------------------------------------------------
// Memory (platform)
// ---------------------------------------------------------------------------

export interface MemoryService {
  list(botId: Id, opts?: { query?: string; limit?: number }): MemoryFact[]
  add(input: { botId: Id; text: string; pinned?: boolean; createdBy: 'bot' | 'user'; source?: MemoryFact['source'] }): MemoryFact
  update(id: Id, patch: { text?: string; pinned?: boolean }): MemoryFact
  delete(id: Id): void
  getProfile(botId: Id): BotMemoryProfile
  setProfile(botId: Id, content: string): BotMemoryProfile
  /** Full-text search (FTS5) over the bot's facts. */
  search(botId: Id, query: string, limit?: number): MemoryFact[]
  /** Markdown block for the system prompt: profile + pinned + most recent facts, size-capped. */
  promptBlock(botId: Id): string
}

// ---------------------------------------------------------------------------
// Skills (platform) — SKILL.md folders
// ---------------------------------------------------------------------------

export interface SkillService {
  /** All skills, or the ones a bot can use (assigned + its own private skills). */
  list(botId?: Id): Skill[]
  get(id: Id): SkillWithBody
  /** Find by name among the skills a bot can use. */
  findForBot(botId: Id, name: string): SkillWithBody | undefined
  save(input: { id?: Id; name: string; description: string; body: string; ownerBotId?: Id }): Skill
  delete(id: Id): void
  importFiles(paths: string[], assignToBotId?: Id): Skill[]
  rescan(): Skill[]
  /** "Available skills" block for the system prompt (name + description per skill). */
  promptBlock(botId: Id): string
}

// ---------------------------------------------------------------------------
// Tools (platform) — registry, permission gate, approvals
// ---------------------------------------------------------------------------

export type JsonSchema = Record<string, unknown>

export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }

export interface ToolResult {
  content: ToolResultContent[]
  isError?: boolean
  /** Why an error result happened when it was not the tool failing: the user (or a 'never'
   *  permission) said no, or the turn was stopped. Cards use it; never parse the text instead. */
  outcome?: 'denied' | 'cancelled'
  /** An external effect may have happened; cancellation is not proof it did not. */
  recovery?: { actionId: string; state: 'unknown' | 'blocked' }
  /** The tool refused before doing anything (nothing was dispatched), so no outcome is unknown. */
  refusedBeforeRun?: boolean
  /** Optional data for the UI card (e.g. exchangeConversationId for send_to_agent). */
  display?: { title?: string; exchangeConversationId?: Id }
}

export interface ToolContext {
  /** User message actually included in this turn. Used to identify a durable work brief. */
  userEntryId?: Id
  bot: Bot
  conversation: Conversation
  /** Resolve a selected virtual project note in this turn, checking its current access. */
  readProjectNote?: (path: string) => string | undefined
  /** Unique per bot turn. */
  turnId: Id
  /** Model-provided tool call id. */
  callId: string
  /** Native host-owned identity, reused verbatim for recovery; not a model argument. */
  actionId?: string
  signal: AbortSignal
  /** Bots currently waiting on each other via send_to_agent, outermost first (loop guard). */
  chain: Id[]
  /** True when the turn is a group-room member turn. */
  inGroup: boolean
  /** Bot's working folder (created on demand). */
  workspaceDir: string
  /** Turn-start identity of each connector tool the model was offered: model-facing name -> server and the tool's own name there.
   * Names can be renumbered when grants change, so execute resolves connectors by this identity. Absent for older callers. */
  /** Built-in names admitted to this dispatch; the bridge also rechecks current permissions. */
  admittedTools?: ReadonlySet<string>
  mcpTools?: ReadonlyMap<string, { serverId: Id; remoteName: string }>
}

export interface ToolDefinition {
  /** Model-facing name: ^[a-zA-Z0-9_-]{1,64}$. MCP tools are mcp__<server>__<tool>. */
  name: string
  description: string
  /** JSON Schema of the input object. */
  inputSchema: JsonSchema
  source: 'builtin' | 'faibots' | 'mcp'
  serverId?: Id
  /** MCP tools: the tool's own name on its server. With serverId it is the stable identity (the model-facing name can be renumbered by dedupe). */
  remoteName?: string
  /** Adapter-owned lookup or guaranteed idempotent replay using ctx.actionId.
   * Never infer support. Undefined means unresolved and must not call execute again.
   * Change version when the remote target/account or recovery semantics change. */
  recovery?: { version: string; recover(input: unknown, ctx: ToolContext): Promise<ToolResult | undefined> }
  defaultPermission: PermissionMode
  /** Registry permission when the outbound catalog was selected. */
  effectivePermission?: PermissionMode
  /** Human label for activity lines and cards, e.g. "Running a command". */
  activityLabel: string
  /** An Ask permission can allow local workspace operations without prompting. */
  autoAllowedInWorkspace?: boolean
  /** Plain-words summary for an approval card. */
  summarize?(input: unknown, ctx: ToolContext): string
  /** Only offered when this returns true (e.g. pass_turn only in group turns). */
  isAvailable?(ctx: Pick<ToolContext, 'bot' | 'conversation' | 'inGroup'>): boolean
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolRegistry {
  register(def: ToolDefinition): void
  /** Tools the bot can call in this context; 'never' tools are omitted. Includes MCP tools. */
  forTurn(ctx: Pick<ToolContext, 'bot' | 'conversation' | 'inGroup'>, omitted?: (name: string, reason: 'scope' | 'permission') => void): Promise<ToolDefinition[]>
  /** UI listing with effective permissions. */
  info(botId?: Id): Promise<ToolInfo[]>
  setPermission(toolName: string, mode: PermissionMode | null, botId?: Id): void
  /**
   * Run a tool call: resolves permission (bot override > global > default), asks for approval
   * when needed, executes, redacts secrets, truncates huge output. Never throws for tool
   * errors: returns isError results instead.
   */
  execute(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export interface ApprovalService {
  /**
   * Post an approval card into the conversation and wait for the user's decision.
   * Resolves 'deny' if the signal aborts.
   */
  request(input: { ctx: ToolContext; toolName: string; summary: string; toolInput: unknown }): Promise<ApprovalDecision>
  resolve(approvalId: Id, decision: ApprovalDecision): void
  /**
   * Hear when a card is posted ('pending') and when it is answered or expires. The runtime uses it
   * for the bot's 'waiting' phase; the integrator for desktop notifications.
   */
  subscribe(listener: (event: ApprovalEvent) => void): () => void
}

export interface ApprovalEvent {
  approvalId: Id
  state: 'pending' | 'resolved' | 'expired'
  ctx: ToolContext
  toolName: string
  summary: string
}

// ---------------------------------------------------------------------------
// MCP (platform)
// ---------------------------------------------------------------------------

export interface McpHost {
  list(): { server: McpServerConfig; status: McpServerStatus }[]
  save(input: Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: Id }): McpServerConfig
  delete(id: Id): void
  restart(id: Id): Promise<McpServerStatus>
  tools(id: Id): Promise<{ name: string; description: string; disabled: boolean }[]>
  import(source: McpImportSource, json?: string): McpServerConfig[]
  /** Namespaced tool definitions for the servers a bot may use (starts servers lazily). */
  toolsForBot(bot: Bot): Promise<ToolDefinition[]>
  /** Custom instructions of the servers a bot may use. */
  instructionsForBot(bot: Bot): string
  shutdown(): Promise<void>
}

/**
 * Exposes FaiBots's tool registry as a local MCP server (Streamable HTTP on 127.0.0.1)
 * so external engines (Claude Code, Codex) can call memory, skills, send_to_agent, etc.
 */
export interface ToolBridge {
  /** Open a scoped endpoint for one turn; tools run with this context. */
  open(ctx: Omit<ToolContext, 'callId'>): Promise<{ url: string; headers: Record<string, string>; close(): void }>
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// Recipes (platform)
// ---------------------------------------------------------------------------

export interface RecipeService {
  exportRecipe(botId: Id): BotRecipe
  importRecipe(recipe: BotRecipe): Bot
}

// ---------------------------------------------------------------------------
// Attachments (platform)
// ---------------------------------------------------------------------------

export interface AttachmentStore {
  /** Copy files into <dataDir>/attachments and describe them. */
  ingest(paths: string[]): Attachment[]
  read(attachment: Attachment, expectedSize?: number): Buffer
}

// ---------------------------------------------------------------------------
// Runtime (runtime builder)
// ---------------------------------------------------------------------------

export interface ProviderService {
  list(): ProviderConfig[]
  save(req: SaveProviderRequest): ProviderConfig
  delete(id: Id): void
  test(id: Id): Promise<ProviderTestResult>
  models(id: Id): Promise<ModelInfo[]>
}

/** How an automatic run (a routine) ended. */
export interface AutomatedRunResult {
  /** Ledger row of the executed turn, when a model was attempted. */
  turnId?: Id
  /** 'limited': the bot reached its daily run limit, so no model was called. */
  status: 'done' | 'error' | 'cancelled' | 'skipped' | 'limited'
  conversationId: Id
  /** The message FaiBots posted to start the run. */
  entryId: Id
  /** The bot's reply text (empty when it said nothing). */
  reply: string
  error?: string
}

export interface Runtime {
  /** Store the user's message, then schedule the bot turns it triggers. Returns the stored entry. */
  send(req: SendMessageRequest): Promise<Entry>
  /**
   * Post `text` in the bot's dm as an automatic run (author 'system', with `trigger`) and wait for
   * the bot's turn. Counts against the bot's daily run limit. Mission runs pass the selected
   * sources as manifest-lite so the prompt can cite them.
   */
  runAutomated(input: { botId: Id; text: string; trigger: EntryTrigger; signal?: AbortSignal; readProjectNote?: ToolContext['readProjectNote']; projectRun?: { projectId: Id; runId: Id }; manifestLite?: { sources: ManifestLiteSource[] } }): Promise<AutomatedRunResult>
  cancelBrief(workId: Id): void
  stop(conversationId: Id): void
  reset(conversationId: Id): void
  liveStates(): BotLiveState[]
  /** Create a group conversation (validates members, MAX_GROUP_BOTS). */
  createGroup(input: { title?: string; botIds: Id[]; settings?: Partial<GroupSettings> }): Conversation
  /** Find or create the dm with a bot. */
  openDm(botId: Id): Conversation
  shutdown(): Promise<void>
}

/**
 * Mission runs (first journey, M1c): the primary bot drafts the deliverable from the project's
 * sources, the host snapshots it as a revision, one reviewer exchange records a review decision,
 * and the B1-B11 budgets are computed from the run's rows. The run continues in the background;
 * the renderer watches 'journey:changed' and re-reads runs.
 */
export interface MissionRunService {
  /** Start a mission run for a project (refuses: unknown project, no sources, a run already active). */
  start(projectId: Id, baselineRunId?: Id, trialCandidateId?: Id): JourneyRun
  /** Runs of a project, newest first. */
  runs(projectId: Id, limit?: number): JourneyRun[]
  /** Startup only: close runs left working/waiting_review by a crash as failed (A20). */
  closeInterrupted(now: number): number
  /** Resolves when no run is in progress (tests, shutdown). */
  idle(): Promise<void>
}

// ---------------------------------------------------------------------------
// Routines (phase 2) — scheduler over RoutineRepo; runs go through Runtime.runAutomated
// ---------------------------------------------------------------------------

export interface RoutineService {
  list(botId?: Id): Routine[]
  /** Create or update. Validates the schedule and plans the next run. */
  save(input: RoutineInput, createdBy?: 'user' | 'bot'): Routine
  delete(id: Id): void
  /** Start a run now (it continues in the background). Throws when the routine is already running. */
  runNow(id: Id, trigger?: Extract<RoutineRunTrigger, 'manual' | 'webhook'>, payload?: string): RoutineRun
  runs(filter: { routineId?: Id; botId?: Id; limit?: number }): RoutineRun[]
  /** Make a new webhook token (the old one stops working). The plain token is returned once. */
  newWebhookToken(id: Id): string
  /** Check a webhook call and start the run. Throws WebhookError with an HTTP status. */
  triggerWebhook(id: Id, token: string, payload: string): RoutineRun
  /** Plan runs and start the timer (catch-up of runs missed while the app was closed). */
  start(): void
  /** Re-plan after settings changed (pause / resume). */
  refresh(): void
  /** Stop the timer and cancel running runs. */
  shutdown(): Promise<void>
}

/** The local webhook endpoint (127.0.0.1) that starts routines. See routines/webhook-server.ts. */
export interface WebhookHost {
  /** Start, or move to another port. Never throws: failures show in status(). */
  listen(port: number): Promise<WebhookStatus>
  close(): Promise<void>
  status(): WebhookStatus
  url(routineId: Id, port: number): string
}

export interface WebhookStatus {
  listening: boolean
  port?: number
  error?: string
}

// ---------------------------------------------------------------------------
// Everything, as wired by src/main/index.ts
// ---------------------------------------------------------------------------

export interface Services {
  dataDir: string
  bus: EventBus
  store: Store
  secrets: SecretVault
  memory: MemoryService
  skills: SkillService
  tools: ToolRegistry
  approvals: ApprovalService
  mcp: McpHost
  bridge: ToolBridge
  recipes: RecipeService
  attachments: AttachmentStore
  providers: ProviderService
  runtime: Runtime
  routines: RoutineService
  missions: MissionRunService
  webhooks: WebhookHost
}

export type { NewBot }
