import type { WorkBrief, WorkReply } from './work-brief'
// Typed contract between the renderer and the main process.
// Every request/response channel and every push event is declared here once;
// the preload bridge only forwards names that appear in INVOKE_CHANNELS / EVENT_CHANNELS.

import { CONTENT_CHANNELS, type ContentInvoke } from './project-content'
import type { TurnContextInvoke } from './turn-context'
import { SESSION_CHANNELS, type SessionInvoke } from './project-sessions'
import { IMPROVEMENT_CHANNELS, type ImprovementInvoke } from './project-improvements'
import { ESCALATION_CHANNELS, type EscalationInvoke } from './escalations'
import type {
  AppSettings,
  ApprovalDecision,
  Artifact,
  ArtifactRevision,
  Bot,
  BotLiveState,
  BotMemoryProfile,
  BotRecipe,
  Conversation,
  Entry,
  GroupSettings,
  Id,
  JourneyRun,
  McpServerConfig,
  McpServerStatus,
  MemoryFact,
  ModelInfo,
  NewBot,
  PermissionMode,
  Project,
  ProjectSource,
  ProviderConfig,
  ProviderKind,
  ReviewDecision,
  Routine,
  RoutineInput,
  RoutineRun,
  SecretInfo,
  Skill,
  SkillWithBody,
  ToolInfo,
  UsageSummary
} from './domain'

export interface AppInfo {
  name: string
  version: string
  dataDir: string
  platform: string
  /** Warning state when false: OS encryption (safeStorage) is unavailable, so new secrets cannot
   *  be stored. Existing secrets remain readable. Optional so older renderer stubs stay valid. */
  encryptionAvailable?: boolean
}

export interface SendMessageRequest {
  conversationId: Id
  text: string
  /** Bot ids the composer resolved from @mention chips. */
  mentions: Id[]
  mentionsEveryone: boolean
  /** Absolute paths picked by the user; main copies them into the attachment store. */
  attachmentPaths: string[]
  replyToId?: Id
  clientNonce: string
}

export interface EntriesPage {
  entries: Entry[]
  /** True when older entries exist before the first returned one. */
  hasMore: boolean
}

export interface SaveProviderRequest {
  id?: Id
  kind: ProviderKind
  label: string
  baseUrl?: string
  defaultModelId: string
  enabled: boolean
  /** Plaintext key, sent once; stored encrypted. Omit to keep the existing key, '' to remove it. */
  apiKey?: string
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  /** What this route costs: subscription allowance, billed API key, or local. */
  billing: 'subscription' | 'api-key' | 'local' | 'unknown'
}

export type McpImportSource = 'claude' | 'codex' | 'cursor' | 'json'

/** An artifact with its snapshot revisions, oldest first. */
export interface ArtifactWithRevisions {
  artifact: Artifact
  revisions: Array<ArtifactRevision & { reviews: ReviewDecision[] }>
  /** Markdown content of the latest revision, when the host keeps snapshot content.
   *  Populated by the mission run (M1c): the deliverable file is re-read and returned only
   *  when it still matches the latest revision's recorded SHA-256. */
  content?: string
}

export interface InvokeMap extends ContentInvoke, TurnContextInvoke, SessionInvoke, ImprovementInvoke, EscalationInvoke {
  'work:list': { req: { conversationId: Id }; res: WorkBrief[] }
  'work:decide': { req: WorkReply & { conversationId: Id }; res: WorkBrief }
  'app:info': { req: void; res: AppInfo }

  // Bots
  'bots:list': { req: void; res: Bot[] }
  'bots:create': { req: NewBot; res: Bot }
  'bots:update': { req: { id: Id; patch: Partial<Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>> }; res: Bot }
  'bots:delete': { req: { id: Id }; res: void }
  'bots:export-recipe': { req: { id: Id }; res: BotRecipe }
  'bots:import-recipe': { req: { recipe: BotRecipe }; res: Bot }

  // Conversations
  'conv:list': { req: void; res: Conversation[] }
  'conv:open-dm': { req: { botId: Id }; res: Conversation }
  'conv:create-group': { req: { title?: string; botIds: Id[]; settings?: Partial<GroupSettings> }; res: Conversation }
  'conv:update': {
    req: { id: Id; patch: { title?: string; botIds?: Id[]; group?: Partial<GroupSettings>; notes?: string } }
    res: Conversation
  }
  'conv:delete': { req: { id: Id }; res: void }
  'conv:entries': { req: { conversationId: Id; beforeSeq?: number; limit?: number }; res: EntriesPage }
  'conv:send': { req: SendMessageRequest; res: Entry }
  /** Stop every running bot turn in the conversation. */
  'conv:stop': { req: { conversationId: Id }; res: void }
  /** Clear history (memory, skills, settings are kept). */
  'conv:reset': { req: { conversationId: Id }; res: void }
  'conv:mark-read': { req: { conversationId: Id }; res: void }
  'conv:live-states': { req: void; res: BotLiveState[] }

  // Approvals
  'approval:resolve': { req: { approvalId: Id; decision: ApprovalDecision }; res: void }

  // Memory
  'memory:list': { req: { botId: Id; query?: string; limit?: number }; res: MemoryFact[] }
  'memory:add': { req: { botId: Id; text: string; pinned?: boolean }; res: MemoryFact }
  'memory:update': { req: { id: Id; patch: { text?: string; pinned?: boolean } }; res: MemoryFact }
  'memory:delete': { req: { id: Id }; res: void }
  'memory:get-profile': { req: { botId: Id }; res: BotMemoryProfile }
  'memory:set-profile': { req: { botId: Id; content: string }; res: BotMemoryProfile }

  // Skills
  'skills:list': { req: { botId?: Id }; res: Skill[] }
  'skills:get': { req: { id: Id }; res: SkillWithBody }
  'skills:save': {
    req: { id?: Id; name: string; description: string; body: string; ownerBotId?: Id }
    res: Skill
  }
  'skills:delete': { req: { id: Id }; res: void }
  'skills:import-files': { req: { paths: string[]; assignToBotId?: Id }; res: Skill[] }
  'skills:rescan': { req: void; res: Skill[] }

  // Tools and permissions
  'tools:list': { req: { botId?: Id }; res: ToolInfo[] }
  /** botId omitted = global default. mode null = remove override. */
  'tools:set-permission': { req: { toolName: string; botId?: Id; mode: PermissionMode | null }; res: void }

  // MCP connectors
  'mcp:list': { req: void; res: { server: McpServerConfig; status: McpServerStatus }[] }
  'mcp:save': { req: Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'> & { id?: Id }; res: McpServerConfig }
  'mcp:delete': { req: { id: Id }; res: void }
  'mcp:restart': { req: { id: Id }; res: McpServerStatus }
  'mcp:tools': { req: { id: Id }; res: { name: string; description: string; disabled: boolean }[] }
  /** Import servers from another client's config, or from pasted mcpServers JSON. */
  'mcp:import': { req: { source: McpImportSource; json?: string }; res: McpServerConfig[] }

  // Model providers
  'providers:list': { req: void; res: ProviderConfig[] }
  'providers:save': { req: SaveProviderRequest; res: ProviderConfig }
  'providers:delete': { req: { id: Id }; res: void }
  'providers:test': { req: { id: Id }; res: ProviderTestResult }
  'providers:models': { req: { id: Id }; res: ModelInfo[] }

  // Secrets (names and descriptions only; values are write-only)
  'secrets:list': { req: { botId?: Id }; res: SecretInfo[] }
  'secrets:set': { req: { botId?: Id; name: string; description: string; value: string }; res: SecretInfo }
  'secrets:delete': { req: { id: Id }; res: void }

  // Routines (scheduled, on-demand and webhook runs)
  'routines:list': { req: { botId?: Id }; res: Routine[] }
  'routines:save': { req: RoutineInput; res: Routine }
  'routines:delete': { req: { id: Id }; res: void }
  /** Start a run now; it continues in the background (watch routines:changed). */
  'routines:run-now': { req: { id: Id }; res: RoutineRun }
  'routines:runs': { req: { routineId?: Id; botId?: Id; limit?: number }; res: RoutineRun[] }
  /** New webhook token (the old one stops working). Returned once, with the URL to call. */
  'routines:webhook-token': { req: { id: Id }; res: { token: string; url: string } }
  /** Whether the local webhook server is listening (and why not). */
  'routines:webhook-status': { req: void; res: { enabled: boolean; listening: boolean; port: number; error?: string } }

  // Usage (turn log totals)
  /** Totals for the last `days` local days, today included. */
  'usage:summary': { req: { days: number }; res: UsageSummary }

  // Settings
  'settings:get': { req: void; res: AppSettings }
  'settings:update': { req: Partial<AppSettings>; res: AppSettings }

  // Journey: record-only projects, note sources and artifacts (M1b slice)
  'projects:list': { req: void; res: Project[] }
  'projects:get': { req: { id: Id }; res: Project }
  'projects:create': { req: { name: string; description?: string }; res: Project }
  /** Copy the picked note files into the attachment store and record them as project sources.
   *  The snapshot service enforces md/txt/pdf and 10 MB; errors surface as plain messages. */
  'projects:attach-notes': { req: { projectId: Id; paths: string[] }; res: ProjectSource[] }
  'projects:list-sources': { req: { projectId: Id }; res: ProjectSource[] }
  /** Artifacts with their revisions (oldest first), each revision's review decisions, and the
   *  latest revision's content when the deliverable file still matches its snapshot. */
  'artifacts:list': { req: { projectId: Id }; res: ArtifactWithRevisions[] }

  // Journey: mission runs (M1c slice)
  /** Start a mission run for the project; it continues in the background (watch journey:changed). */
  'projects:start-mission': { req: { projectId: Id }; res: JourneyRun }
  /** Runs of a project, newest first. */
  'projects:list-runs': { req: { projectId: Id; limit?: number }; res: JourneyRun[] }

  // Native helpers
  /** directories: pick folders instead of files (e.g. importing skill folders). */
  'dialog:open-files': {
    req: { title?: string; filters?: { name: string; extensions: string[] }[]; directories?: boolean }
    res: string[]
  }
}

export interface EventMap {
  'work:changed': { conversationId: Id }
  'app:ready': { at: number }
  /** An entry was created or replaced (also fires when streaming finishes). */
  'conv:entry': { entry: Entry }
  /** Streaming text appended to an entry that is still isStreaming. */
  'conv:delta': { conversationId: Id; entryId: Id; textDelta: string }
  'conv:changed': { conversation: Conversation }
  'conv:deleted': { conversationId: Id }
  'bot:state': { state: BotLiveState }
  'bots:changed': { bots: Bot[] }
  'skills:changed': { at: number }
  /** A bot's memory changed (the bot used update_memory, or the user edited it). */
  'memory:changed': { botId: Id }
  'mcp:changed': { at: number }
  /** A bot's routines or their runs changed (saved, deleted, a run started or finished). */
  'routines:changed': { botId: Id }
  /** A project's mission runs, artifacts or reviews changed (a run started, moved or finished). */
  'journey:changed': { projectId: Id }
  'providers:changed': { at: number }
  'settings:changed': { settings: AppSettings }
  /** User clicked an OS notification; focus this conversation. */
  'nav:focus-conversation': { conversationId: Id }
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap


export const INVOKE_CHANNELS = [
  ...CONTENT_CHANNELS,
  'work:list', 'work:decide',
  'context:turns',
  ...SESSION_CHANNELS,
  ...IMPROVEMENT_CHANNELS,
  ...ESCALATION_CHANNELS,
  'app:info',
  'bots:list', 'bots:create', 'bots:update', 'bots:delete', 'bots:export-recipe', 'bots:import-recipe',
  'conv:list', 'conv:open-dm', 'conv:create-group', 'conv:update', 'conv:delete', 'conv:entries',
  'conv:send', 'conv:stop', 'conv:reset', 'conv:mark-read', 'conv:live-states',
  'approval:resolve',
  'memory:list', 'memory:add', 'memory:update', 'memory:delete', 'memory:get-profile', 'memory:set-profile',
  'skills:list', 'skills:get', 'skills:save', 'skills:delete', 'skills:import-files', 'skills:rescan',
  'tools:list', 'tools:set-permission',
  'mcp:list', 'mcp:save', 'mcp:delete', 'mcp:restart', 'mcp:tools', 'mcp:import',
  'providers:list', 'providers:save', 'providers:delete', 'providers:test', 'providers:models',
  'secrets:list', 'secrets:set', 'secrets:delete',
  'routines:list', 'routines:save', 'routines:delete', 'routines:run-now', 'routines:runs', 'routines:webhook-token',
  'routines:webhook-status',
  'usage:summary',
  'settings:get', 'settings:update',
  'projects:list', 'projects:get', 'projects:create', 'projects:attach-notes', 'projects:list-sources',
  'artifacts:list',
  'projects:start-mission', 'projects:list-runs',
  'dialog:open-files'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'work:changed',
  'app:ready', 'conv:entry', 'conv:delta', 'conv:changed', 'conv:deleted', 'bot:state',
  'bots:changed', 'skills:changed', 'memory:changed', 'mcp:changed', 'routines:changed', 'journey:changed',
  'providers:changed', 'settings:changed',
  'nav:focus-conversation'
] as const satisfies readonly EventChannel[]

// Compile-time check that the runtime lists cover every declared channel.
type Missing<A extends string, B extends readonly string[]> = Exclude<A, B[number]>
const _invokeComplete: Missing<InvokeChannel, typeof INVOKE_CHANNELS> extends never ? true : never = true
const _eventComplete: Missing<EventChannel, typeof EVENT_CHANNELS> extends never ? true : never = true
void _invokeComplete
void _eventComplete

export interface FaiBotsBridge {
  invoke<C extends InvokeChannel>(channel: C, req: InvokeMap[C]['req']): Promise<InvokeMap[C]['res']>
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}
