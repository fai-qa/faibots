// FaiBots domain model, shared by the main process and the renderer.
// Plain serialisable data only (it crosses IPC). Timestamps are epoch ms.

export type Id = string

// ---------------------------------------------------------------------------
// Bot identity ("soul")
// ---------------------------------------------------------------------------

/** Supported avatar hues. */
export const BOT_COLORS = [
  'black', 'brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray'
] as const
export type BotColor = (typeof BOT_COLORS)[number]

/** Supported avatar shapes. */
export const AVATAR_SHAPES = [
  'blob', 'pebble', 'bean', 'egg', 'squircle', 'capsule', 'hex', 'gem', 'shield', 'dome',
  'cloud', 'teardrop', 'leaf', 'square', 'sparkle', 'clover', 'flower', 'heart', 'star'
] as const
export type AvatarShape = (typeof AVATAR_SHAPES)[number]

export interface BotAvatar {
  shape: AvatarShape
  color: BotColor
  /** Optional custom image stored as a data URL (png/jpeg/webp, small). */
  imageDataUrl?: string
}

/** Which engine and model a bot thinks with. */
export interface ModelRoute {
  providerId: Id
  /** Provider model id, e.g. "claude-opus-5-5", "gpt-5.1", "llama3.3". Empty = provider default. */
  modelId: string
  /** Reasoning effort where the provider supports it. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface Bot {
  id: Id
  /** Display name, e.g. "Researcher". */
  name: string
  /** @-mention handle, lowercase, no spaces, unique. Derived from name unless set. */
  handle: string
  /** Short role label shown under the name, e.g. "Research, marketing". */
  label: string
  /** One or two sentences: what this bot is for. Used by other bots to decide who to ask. */
  description: string
  /**
   * The soul: free-form Markdown persona (identity, voice, values, boundaries, working style).
   * Injected into every turn as the bot's identity. Peers see its short description.
   */
  soul: string
  avatar: BotAvatar
  model: ModelRoute
  /** At most one primary bot coordinates the others. */
  isPrimary: boolean
  /** Per-bot tool permission overrides, keyed by tool name. */
  toolPermissions: Record<string, PermissionMode>
  /** MCP servers this bot may use. 'all' = every enabled server. */
  mcpServerIds: Id[] | 'all'
  /** Skills assigned from the library (skill ids). The bot's own private skills are always included. */
  skillIds: Id[]
  /** Desktop notification when this bot finishes or waits for you. */
  notify: boolean
  /**
   * Most automatic runs per day (routines, webhook runs, being asked by another bot); 0 = no limit.
   * Messages you send the bot yourself never count against this limit.
   */
  dailyRunLimit: number
  pinned: boolean
  hidden: boolean
  createdAt: number
  updatedAt: number
}

export type NewBot = Pick<Bot, 'name'> & Partial<Omit<Bot, 'id' | 'createdAt' | 'updatedAt'>>

// ---------------------------------------------------------------------------
// Conversations and transcript entries
// ---------------------------------------------------------------------------

/**
 * dm       user <-> one bot
 * group    user + several bots
 * exchange bot <-> bot side conversation created by send_to_agent (read-only for the user)
 */
export type ConversationKind = 'dm' | 'group' | 'exchange'

/** How a group decides which bots take a turn when nobody is @mentioned. */
export type GroupTurnPolicy =
  /** Every member reads the message and may reply or pass. */
  | 'open'
  /** Only @mentioned bots reply; with no mention the primary bot (or first member) replies. */
  | 'mentions'
  /** A cheap routing call picks which members should answer. */
  | 'router'

export interface GroupSettings {
  turnPolicy: GroupTurnPolicy
  /**
   * Rounds per user message. Round 1 answers the user; each later round offers the bots'
   * new posts to the other members. PASS is the default.
   */
  maxRounds: number
  /** Hard cap on bot posts triggered by one user message across all rounds (loop guard). */
  maxBotPosts: number
  /** Let bot posts start follow-up rounds (bots replying to bots inside the group). */
  allowBotToBot: boolean
  /** Run member turns within a round in parallel (true) or one after another (false). */
  parallel: boolean
}

export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  turnPolicy: 'open',
  maxRounds: 3,
  maxBotPosts: 8,
  allowBotToBot: true,
  parallel: true
}

/** Maximum bots in one group. */
export const MAX_GROUP_BOTS = 8

export interface Conversation {
  id: Id
  kind: ConversationKind
  title: string
  /** Bot members. dm: exactly one. exchange: exactly two (initiator first). */
  botIds: Id[]
  group?: GroupSettings
  /** For exchanges: the conversation and tool call that opened it. */
  origin?: { conversationId: Id; entryId: Id; fromBotId: Id }
  /** Shared notes all members can read and update (group memory). */
  notes: string
  lastEntryAt: number
  unreadCount: number
  createdAt: number
  updatedAt: number
}

export type Author =
  | { kind: 'user' }
  | { kind: 'bot'; botId: Id }
  | { kind: 'system' }

export type EntryKind =
  /** Normal chat text from the user or a bot. */
  | 'message'
  /** A tool invocation by a bot, with its result once done. */
  | 'tool-call'
  /** Human-in-the-loop card waiting for the user. */
  | 'approval'
  /** System line: "X was added", "Researcher passed", errors, resets. */
  | 'event'

export interface Attachment {
  id: Id
  name: string
  mimeType: string
  sizeBytes: number
  /** Absolute path in the app's attachment store. */
  path: string
}

export interface ToolCallInfo {
  callId: string
  /** Durable host identity for native calls; external engine cards may not have one. */
  actionId?: string
  toolName: string
  /** Human label, e.g. "Messaging Researcher", "Running a command". */
  title: string
  input: unknown
  status: 'running' | 'done' | 'error' | 'denied' | 'cancelled'
  /** Short text result shown in the card (full result may be truncated). */
  resultText?: string
  /** For send_to_agent: the exchange conversation the user can open. */
  exchangeConversationId?: Id
}

export type ApprovalDecision = 'allow_once' | 'always' | 'deny' | 'never'

export interface ApprovalInfo {
  approvalId: Id
  toolName: string
  /** What will happen, in plain words: "Run `npm test` in C:\\work". */
  summary: string
  /** Raw input for the details expander. */
  input: unknown
  status: 'pending' | 'resolved' | 'expired'
  decision?: ApprovalDecision
}

export interface Entry {
  id: Id
  conversationId: Id
  /** Monotonic per conversation. */
  seq: number
  kind: EntryKind
  author: Author
  /** Markdown text (message), title (event). */
  text: string
  /** Bots @mentioned in this message (resolved ids). */
  mentions: Id[]
  mentionsEveryone: boolean
  replyToId?: Id
  attachments: Attachment[]
  toolCall?: ToolCallInfo
  approval?: ApprovalInfo
  /** True while a bot is still generating this entry. */
  isStreaming: boolean
  /** Idempotency key for user sends. */
  clientNonce?: string
  /** Model/engine metadata for bot messages. */
  meta?: { providerId?: Id; modelId?: string; inputTokens?: number; outputTokens?: number }
  /** Set on the message FaiBots posts for an automatic run (author is 'system'). */
  trigger?: EntryTrigger
  createdAt: number
  updatedAt: number
}

/** What started an automatic run. */
export type EntryTrigger =
  | {
      kind: 'routine'
      routineId: Id
      routineName: string
      via: RoutineRunTrigger
    }
  /** A mission run (first journey, M1c): FaiBots runs the primary bot on a project's sources. */
  | {
      kind: 'mission'
      projectId: Id
      projectName: string
      artifactName: string
    }

// ---------------------------------------------------------------------------
// Live bot state (typing / working / waiting indicators)
// ---------------------------------------------------------------------------

export type BotPhase = 'idle' | 'reading' | 'thinking' | 'typing' | 'tool' | 'waiting'

export interface BotLiveState {
  botId: Id
  conversationId: Id
  phase: BotPhase
  /** e.g. "Running a few commands", "Checking with Researcher". */
  activity?: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Per-bot memory
// ---------------------------------------------------------------------------

export type MemoryTier = 'profile' | 'log'

export interface MemoryFact {
  id: Id
  botId: Id
  /** 'log' = dated fact/episode. Profile lives in BotMemoryProfile. */
  tier: 'log'
  text: string
  pinned: boolean
  source?: { conversationId: Id; entryId?: Id }
  createdBy: 'bot' | 'user'
  createdAt: number
  updatedAt: number
}

/** The always-in-context memory document for a bot ("what I know about my person and my work"). */
export interface BotMemoryProfile {
  botId: Id
  content: string
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Skills (SKILL.md)
// ---------------------------------------------------------------------------

export type SkillSource =
  /** Created in FaiBots's own library folder. */
  | 'library'
  /** Created by a bot with update_skill (private to that bot unless shared). */
  | 'bot'
  /** Read-only, discovered in ~/.claude/skills, ~/.codex/skills, ~/.agents/skills. */
  | 'external'

export interface Skill {
  id: Id
  /** Frontmatter `name`, unique slug. */
  name: string
  /** Frontmatter `description`: "Use when…". Shown to the model to decide when to load it. */
  description: string
  source: SkillSource
  /** Folder that contains SKILL.md. */
  dir: string
  /** Bot that owns a private skill (source 'bot'). */
  ownerBotId?: Id
  readOnly: boolean
  updatedAt: number
}

export interface SkillWithBody extends Skill {
  /** Markdown body after the frontmatter. */
  body: string
  /** Other files in the skill folder (relative paths). */
  resources: string[]
}

/** Maximum assigned skills per bot. */
export const MAX_SKILLS_PER_BOT = 250
export const MAX_SKILL_CHARS = 256_000

// ---------------------------------------------------------------------------
// Tools and permissions
// ---------------------------------------------------------------------------

export type PermissionMode = 'always' | 'ask' | 'never'

export interface ToolInfo {
  name: string
  description: string
  source: 'builtin' | 'faibots' | 'mcp'
  /** For MCP tools. */
  serverId?: Id
  defaultPermission: PermissionMode
  /** Effective permission for the bot being viewed (override > global > default). */
  effectivePermission: PermissionMode
  /** File tools run without asking inside the bot's workspace, whatever their permission says. */
  autoAllowedInWorkspace?: boolean
}

// ---------------------------------------------------------------------------
// MCP connectors
// ---------------------------------------------------------------------------

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerConfig {
  id: Id
  /** Key in mcpServers, unique. */
  name: string
  transport: McpTransport
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  startupTimeoutSec?: number
  // http / sse
  url?: string
  headers?: Record<string, string>
  enabled: boolean
  /** Tools hidden from every bot. */
  disabledTools: string[]
  /** Extra instructions added to the system prompt when this server's tools are present. */
  customInstructions: string
  createdAt: number
  updatedAt: number
}

export type McpServerStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'ready'; toolCount: number }
  | { state: 'error'; message: string }

// ---------------------------------------------------------------------------
// Model providers
// ---------------------------------------------------------------------------

export type ProviderKind =
  /** Anthropic API key, official @anthropic-ai/sdk. Billed per token. */
  | 'anthropic'
  /** OpenAI API key. Billed per token. */
  | 'openai'
  /** Google Gemini API key. */
  | 'google'
  /** xAI (Grok) API key. */
  | 'xai'
  /** Any OpenAI-compatible endpoint: Ollama, LM Studio, OpenRouter, vLLM… */
  | 'openai-compatible'
  /** The user's installed Claude Code login (subscription), via the Claude Agent SDK. */
  | 'claude-code'
  /** Codex with the user's ChatGPT login (or Codex API key), via the Codex SDK. */
  | 'codex'

/** Whether a route spends a subscription allowance or bills an API key. Shown in the UI. */
export type BillingRoute = 'subscription' | 'api-key' | 'local' | 'unknown'

export interface ProviderConfig {
  id: Id
  kind: ProviderKind
  label: string
  /** Override base URL (required for openai-compatible). */
  baseUrl?: string
  /** True when an API key is stored in the secret vault for this provider. */
  hasApiKey: boolean
  defaultModelId: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface ModelInfo {
  id: string
  label: string
  contextWindow?: number
  supportsTools: boolean
  supportsImages?: boolean
}

// ---------------------------------------------------------------------------
// Secrets (values never leave the main process)
// ---------------------------------------------------------------------------

export interface SecretInfo {
  id: Id
  /** Env-var style name for bot secrets, e.g. CRM_API_TOKEN. */
  name: string
  description: string
  /** Bot that owns it; undefined = provider/app secret. */
  botId?: Id
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  /** Colour 1:1 bubbles with the bot's colour. */
  botColorInChat: boolean
  /** Model used for new bots and for routing/summaries when a bot has none. */
  defaultModel: ModelRoute | null
  /** Global tool permission defaults keyed by tool name. */
  toolPermissions: Record<string, PermissionMode>
  /** Folder bots work in by default (each bot gets a subfolder). */
  workspaceRoot: string
  notifications: { enabled: boolean; sound: boolean }
  /** Fraction of the context window at which native engines compact history. */
  compactAt: number
  userName: string
  /** Routines only run while FaiBots runs, so it can stay in the tray when the window closes. */
  background: {
    /** Closing the window hides FaiBots to the tray instead of quitting. */
    keepRunning: boolean
    /** Start with Windows / macOS sign-in, straight to the tray. */
    openAtLogin: boolean
    /** Scheduled routines wait until this is turned off again (Run now and webhooks still work). */
    routinesPaused: boolean
  }
  /** Local webhook endpoint (127.0.0.1 only) that lets other apps start a routine. */
  webhooks: { enabled: boolean; port: number }
}

// ---------------------------------------------------------------------------
// Routines run on a schedule, on demand, or in response to a webhook.
// ---------------------------------------------------------------------------

export type RoutineSchedule =
  /** Every N minutes, counted from the last planned run. */
  | { kind: 'interval'; everyMinutes: number }
  /** At a local time on some weekdays (0 = Sunday … 6 = Saturday). */
  | { kind: 'daily'; time: string; days: number[] }
  /** No schedule: runs only from Run now, a webhook or another bot. */
  | { kind: 'manual' }

export interface Routine {
  id: Id
  botId: Id
  name: string
  /** What the bot is asked to do on every run. Posted in the bot's chat. */
  prompt: string
  /** Owner-defined checks. A reply or successful execution alone is not acceptance. */
  acceptance?: RoutineAcceptanceContract | null
  schedule: RoutineSchedule
  enabled: boolean
  /** Other apps may start it through the local webhook. */
  webhookEnabled: boolean
  /** A webhook token exists (only its hash is stored; it is shown once). */
  hasWebhookToken: boolean
  /** Who made it: you, or the bot itself with create_routine. */
  createdBy: 'user' | 'bot'
  lastRunAt?: number
  /** Next planned run; undefined when disabled or manual. */
  nextRunAt?: number
  createdAt: number
  updatedAt: number
}

export type RoutineInput = Pick<Routine, 'botId' | 'name' | 'prompt' | 'schedule'> &
    Partial<Pick<Routine, 'enabled' | 'webhookEnabled' | 'acceptance'>> & { id?: Id }

export type RoutineRunTrigger =
  /** Its schedule came up. */
  | 'schedule'
  /** Run now, from the app. */
  | 'manual'
  | 'webhook'
  /** A planned run was missed while FaiBots was closed and ran at the next start. */
  | 'catch-up'

export type RoutineRunStatus = 'running' | 'done' | 'error' | 'skipped' | 'cancelled'

export interface RoutineAcceptanceCheck {
  /** Relative to this bot's workspace, never an absolute path. */
  path: string
  contains?: string
  sha256?: string
}

export interface RoutineAcceptanceContract { checks: RoutineAcceptanceCheck[] }

export interface RoutineAcceptanceEvidence {
  status: 'pending' | 'passed' | 'failed' | 'unverified'
  /** Canonical location captured before execution; a later junction must not redefine trust. */
  workspacePath?: string
  checkedAt?: number
  reason?: string
  checks: Array<RoutineAcceptanceCheck & {
    status: 'pending' | 'passed' | 'failed' | 'unverified'
    beforeSha256?: string
    baselineError?: string
    observedSha256?: string
    bytes?: number
    reason?: string
  }>
}

export interface RoutineRun {
  id: Id
  routineId: Id
  botId: Id
  trigger: RoutineRunTrigger
  status: RoutineRunStatus
  startedAt: number
  endedAt?: number
  /** Where the run happened (the bot's chat) and the message that started it. */
  conversationId?: Id
  entryId?: Id
  /** Start of the bot's reply, or why the run was skipped. */
  summary: string
  error?: string
  /** Execution status is independent of this host-verified deliverable verdict. */
  acceptance?: RoutineAcceptanceEvidence
}

export const MIN_ROUTINE_INTERVAL_MINUTES = 5
export const MAX_ROUTINES_PER_BOT = 20
export const MAX_ROUTINE_PROMPT_CHARS = 8_000

// ---------------------------------------------------------------------------
// Journey: projects, note sources, versioned Markdown artifacts, reviews
// (first journey slice; Spaces deferred, projects are record-only)
// ---------------------------------------------------------------------------

/** The note formats a project source may use (owner decision: md/txt/pdf only). */
export type NoteKind = 'md' | 'txt' | 'pdf'

/** A record-only project: no filesystem folder, no host/environment rows (owner decision a). */
export interface Project {
  id: Id
  /** Display label; never resolved by label alone. */
  name: string
  description: string
  createdAt: number
  updatedAt: number
}

/**
 * A note attached to a project. Keeps the attachment id plus a self-contained identity
 * (name, full SHA-256, size, kind) so the record stays resolvable after the attachment
 * file is reconciled (DATABASE.md:32).
 */
export interface ProjectSource {
  id: Id
  projectId: Id
  attachmentId: Id
  name: string
  /** Full SHA-256 of the note bytes at attach time (owner decision j). */
  sha256: string
  sizeBytes: number
  kind: NoteKind
  createdAt: number
}

/** The project deliverable (owner decision c: Markdown only). Revisions hold its content identity. */
export type ArtifactKind = 'proposal'
/** Draft: revisions exist, nothing is reviewed yet. Reviewed: a review decision was recorded. */
export type ArtifactStatus = 'draft' | 'reviewed'

export interface Artifact {
  id: Id
  projectId: Id
  name: string
  kind: ArtifactKind
  /** Host state: a mission run moves it from draft to reviewed when a review decision lands. */
  status: ArtifactStatus
  createdAt: number
  updatedAt: number
}

/** Where a revision came from: the project and the source notes it was built from (FJ-08). */
export interface ArtifactProvenance {
  projectId?: Id
  sources?: { attachmentId: Id; name: string; sha256: string }[]
  note?: string
  /** The workspace file the revision snapshot was observed from (FJ-06 capture). */
  file?: { workspace: string; path: string }
}

/** One host-snapshotted version of an artifact (FJ-06/FJ-07): revision number, hash, provenance. */
export interface ArtifactRevision {
  id: Id
  artifactId: Id
  /** 1-based per artifact. */
  revisionNo: number
  sha256: string
  provenance: ArtifactProvenance
  createdAt: number
}

export type ReviewDecisionKind = 'accepted' | 'repair' | 'partial' | 'rejected'

/** Reviewed acceptance of one artifact revision (FJ-06b, DATABASE.md:57). */
export interface ReviewDecision {
  id: Id
  artifactRevisionId: Id
  rubric: string
  /** The reviewer identity (a human, or a bot id). */
  reviewer: string
  decision: ReviewDecisionKind
  explanation: string
  createdAt: number
}

// ---------------------------------------------------------------------------
// Mission runs (first journey, M1c): one run = draft turn, revision snapshot,
// one reviewer exchange, one recorded review decision, and its B1-B11 budgets.
// ---------------------------------------------------------------------------

/**
 * One selected source for a turn (manifest-lite, FJ-09): its path plus the identity
 * the model can cite. Shared by the prompt builder and the mission-run service.
 */
export interface ManifestLiteSource {
  /** Path the source is known by (bot-relative), never an absolute path. */
  path: string
  /** Full SHA-256 of the source bytes at selection time, when known. */
  sha256?: string
  /** Display name, when it differs from the path's file name. */
  name?: string
}

/** Honest run states, from first-journey mission states (DATABASE.md:59). */
export type JourneyRunStatus = 'working' | 'waiting_review' | 'complete' | 'partial' | 'failed'

/**
 * The B1-B11 numeric budgets (first-journey.md, FJ-10), computed exactly from the
 * run's rows once it ends. Keys stay absent until their number is measured, so a
 * missing budget is unknown, never zero-invented.
 */
export interface JourneyRunBudgets {
  /** B1: model turns recorded during the run (primary + reviewer + any asked bots). */
  b1?: number
  /** B2: turns that ended in error, and the error rate over B1. */
  b2?: { errors: number; rate: number }
  /** B3: tokens used, and how many turns reported zero tokens (unknown usage stays separate). */
  b3?: { inputTokens: number; outputTokens: number; zeroTokenTurns: number }
  /** B4: wall-clock time, both the span and the sum of turn durations. */
  b4?: { wallMs: number; totalMs: number }
  /** B5: bot message entries written during the run. */
  b5?: number
  /** B6: tool-call entries by final card status. */
  b6?: { done: number; error: number; denied: number; cancelled: number; running: number }
  /** B7: send_to_agent tool calls (the reviewer exchange). */
  b7?: number
  /** B8: bytes that went in: staged source notes plus entry attachments. */
  b8?: { sourceBytes: number; entryAttachmentBytes: number; total: number }
  /** B9: the deliverable file as the host observed it (stat + full SHA-256). */
  b9?: { bytes: number; sha256: string }
  /** B10: host acceptance checks passed/total, and repair rounds (revisions - 1). */
  b10?: { checksPassed: number; checksTotal: number; repairs: number }
  /** B11: automatic run admissions recorded during the run (admissions ∪ turns). */
  b11?: number
}

export interface JourneyRun {
  id: Id
  projectId: Id
  /** The artifact this run produced; absent only when the run failed before creating it. */
  artifactId?: Id
  status: JourneyRunStatus
  /** Why a run is partial or failed (never fabricated; absent otherwise). */
  error?: string
  budgets: JourneyRunBudgets
  startedAt: number
  endedAt?: number
}

// ---------------------------------------------------------------------------
// Usage (every bot turn is logged with its tokens)
// ---------------------------------------------------------------------------

/** What started a bot turn. 'routine' and 'agent' are automatic and count against dailyRunLimit. */
export type TurnTrigger = 'user' | 'group' | 'agent' | 'routine'

export interface UsageRow {
  botId: Id
  /** Local calendar day, YYYY-MM-DD. */
  day: string
  providerId: Id
  modelId: string
  turns: number
  automaticTurns: number
  errors: number
  inputTokens: number
  outputTokens: number
}

export interface UsageSummary {
  from: number
  to: number
  rows: UsageRow[]
}

// ---------------------------------------------------------------------------
// Bot recipe export and import
// ---------------------------------------------------------------------------

export interface BotRecipe {
  format: 'faibots.bot-recipe'
  version: 1
  profile: { name: string; label: string; description: string; avatarColor: BotColor; avatarShape: AvatarShape }
  soul: string
  memory: { tier: MemoryTier; content: string; createdAt?: string }[]
  skills: { name: string; description: string; content: string }[]
  mcpServers: { name: string; description?: string }[]
}
