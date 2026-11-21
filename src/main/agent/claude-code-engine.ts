// The Claude Code TurnEngine: runs the bot's turn in Claude Code through the Claude Agent SDK's
// query(), on the user's own Claude Code login (subscription). Claude Code keeps its own loop,
// context and session; we:
//   - work in the bot's workspace folder, with no Claude Code settings files loaded (so a file the
//     bot writes into its workspace cannot widen its own permissions)
//   - append our system prompt (soul, room, memory, skills) to Claude Code's preset
//   - resume the bot's session for this conversation (BotContextState.engineSessionId)
//   - give it FaiBots's tools through the ToolBridge (HTTP MCP) and the bot's MCP connectors
//     through an in-process MCP server; both run calls through the ToolRegistry (approvals)
//   - route Claude Code's own permission prompts (Bash, Write, …) to FaiBots approval cards
//     through canUseTool, using the bot's permissions for the matching FaiBots tool
//   - stream text with includePartialMessages and turn tool_use blocks into tool cards

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionResult,
  SDKMessage,
  query as claudeQuery
} from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { PermissionMode } from '@shared/domain'
import type { ApprovalService, SecretVault, Store, ToolBridge, ToolContext, ToolDefinition, ToolRegistry } from '../contracts'
import { DEFAULT_MODEL_ALIAS } from '../providers/catalog'
import { claudeCodeEnv, claudeCodePathOption } from '../providers/external'
import { ProviderError } from '../providers/types'
import { privateTargetReason } from '../tools/builtin/web-fetch'
import { isReallyInside } from '../tools/paths'
import { sessionBinding, type EngineTurn, type TurnEngine } from './engine'
import { attachmentDirs, contentText, statusFromText, toCallToolResult, turnPrompt } from './external-common'
import { promptText } from './prompt'

export const BRIDGE_SERVER = 'faibots'
export const CONNECTORS_SERVER = 'connectors'
const MAX_TOOL_NAME = 64
/**
 * FaiBots tool calls can wait on an approval card or on another bot (send_to_agent waits up to
 * 10 minutes), far longer than Claude Code's default MCP call timeout.
 */
export const TOOL_TIMEOUT_MS = 30 * 60_000

/** Claude Code built-in tool -> the FaiBots tool whose permission governs it. */
const PERMISSION_OF: Record<string, string> = {
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  KillBash: 'shell',
  Read: 'read_file',
  NotebookRead: 'read_file',
  Grep: 'read_file',
  Glob: 'list_dir',
  LS: 'list_dir',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  NotebookEdit: 'edit_file',
  WebFetch: 'web_fetch',
  WebSearch: 'web_fetch'
}
const FILE_PERMISSIONS = new Set(['read_file', 'list_dir', 'write_file', 'edit_file'])
const READ_PERMISSIONS = new Set(['read_file', 'list_dir'])
/** Approval cards can wait for the user far longer than a hook's default timeout. */
const GATE_HOOK_TIMEOUT_SEC = 24 * 60 * 60

export const DECLINED_MESSAGE = 'The user declined this action. Do not retry it; ask them what they would like instead.'

export interface ClaudeCodeEngineDeps {
  store: Pick<Store, 'entries' | 'settings' | 'bots'>
  bridge: ToolBridge
  approvals: ApprovalService
  tools: Pick<ToolRegistry, 'execute' | 'setPermission'>
  secrets: Pick<SecretVault, 'redact'>
  query?: typeof claudeQuery
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Card title for a Claude Code tool call. */
export function claudeToolTitle(name: string, input: Record<string, unknown>, activityFor: (n: string, i?: unknown) => string): string {
  const file = str(input['file_path']) || str(input['notebook_path']) || str(input['path'])
  switch (name) {
    case 'Bash':
      return `Running \`${str(input['command']).slice(0, 120)}\``
    case 'Read':
    case 'NotebookRead':
      return `Reading ${file || 'a file'}`
    case 'Write':
      return `Writing ${file || 'a file'}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file || 'a file'}`
    case 'Glob':
    case 'Grep':
    case 'LS':
      return 'Searching files'
    case 'WebFetch':
      return `Reading ${str(input['url']) || 'a web page'}`
    case 'WebSearch':
      return `Searching the web${str(input['query']) ? ` for “${str(input['query'])}”` : ''}`
    case 'Task':
    case 'Agent':
      return 'Working with a helper agent'
    case 'TodoWrite':
      return 'Updating its to-do list'
    default:
      return activityFor(name, input)
  }
}

/** The approval card text for a Claude Code permission request. */
function permissionSummary(name: string, input: Record<string, unknown>, title: string | undefined): string {
  if (title) return title
  const file = str(input['file_path']) || str(input['notebook_path']) || str(input['path'])
  switch (name) {
    case 'Bash':
      return `Run \`${str(input['command'])}\``
    case 'Write':
      return `Write ${file}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Edit ${file}`
    case 'Read':
      return `Read ${file}`
    case 'WebFetch':
      return `Fetch ${str(input['url'])}`
    default:
      return `${name}: ${JSON.stringify(input).slice(0, 400)}`
  }
}

/** Connector tools as Claude Code will see them: mcp__connectors__<server>__<tool>, ≤ 64 characters. */
export function connectorToolNames(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const prefix = `mcp__${CONNECTORS_SERVER}__`
  const byExposed = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    if (!tool.name.startsWith('mcp__')) continue
    let exposed = tool.name.slice('mcp__'.length)
    if (prefix.length + exposed.length > MAX_TOOL_NAME) {
      const hash = createHash('sha256').update(tool.name).digest('hex').slice(0, 6)
      exposed = `${exposed.slice(0, MAX_TOOL_NAME - prefix.length - 7)}_${hash}`
    }
    byExposed.set(exposed, tool)
  }
  return byExposed
}

/** The display name of a tool Claude Code called (FaiBots and connector tools by their own names). */
function displayToolName(name: string, connectors: Map<string, ToolDefinition>): string {
  if (name.startsWith(`mcp__${BRIDGE_SERVER}__`)) return name.slice(`mcp__${BRIDGE_SERVER}__`.length)
  if (name.startsWith(`mcp__${CONNECTORS_SERVER}__`)) {
    return connectors.get(name.slice(`mcp__${CONNECTORS_SERVER}__`.length))?.name ?? name
  }
  return name
}

/** An in-process MCP server that serves the bot's connector tools through the ToolRegistry. */
function connectorServer(turn: EngineTurn, tools: Map<string, ToolDefinition>, registry: Pick<ToolRegistry, 'execute'>): McpServerConfig {
  const instance = new McpServer({ name: CONNECTORS_SERVER, version: '0.1.0' }, { capabilities: { tools: {} } })
  instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools].map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: { ...def.inputSchema, type: 'object' as const }
    }))
  }))
  instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const def = tools.get(request.params.name)
    if (!def) return { content: [{ type: 'text' as const, text: `Unknown tool "${request.params.name}".` }], isError: true }
    const ctx: ToolContext = { ...turn.toolContext, callId: randomUUID(), signal: AbortSignal.any([turn.signal, extra.signal]) }
    return toCallToolResult(await registry.execute(def.name, request.params.arguments ?? {}, ctx))
  })
  return { type: 'sdk', name: CONNECTORS_SERVER, instance, timeout: TOOL_TIMEOUT_MS }
}

function inputPath(input: Record<string, unknown>, workspaceDir: string): string | undefined {
  const raw = str(input['file_path']) || str(input['notebook_path']) || str(input['path'])
  if (!raw) return undefined
  return isAbsolute(raw) ? raw : resolve(workspaceDir, raw)
}

type GateDecision = { allow: true } | { allow: false; message: string }

/**
 * The FaiBots permission check for one Claude Code built-in tool call: the bot's permission for
 * the matching FaiBots tool, free file access inside the workspace (and reads of this turn's own
 * attachment files, never their shared folder), never a local or private address for WebFetch,
 * and an approval card otherwise.
 */
function gate(turn: EngineTurn, deps: ClaudeCodeEngineDeps, readableFiles: string[]) {
  const defaults = new Map<string, PermissionMode>(turn.tools.map((t) => [t.name, t.defaultPermission]))
  const deny = (message: string): GateDecision => ({ allow: false, message })

  return async (toolName: string, input: Record<string, unknown>, callId: string, signal: AbortSignal, title?: string): Promise<GateDecision> => {
    // An approval card cannot carry answers; in a chat the bot simply asks.
    if (toolName === 'AskUserQuestion') return deny('Ask your question in your reply instead; the user answers in the chat.')
    const permission = PERMISSION_OF[toolName] ?? toolName
    const bot = deps.store.bots.get(turn.bot.id) ?? turn.bot
    const mode: PermissionMode =
      bot.toolPermissions[permission] ?? deps.store.settings.get().toolPermissions[permission] ?? defaults.get(permission) ?? 'ask'
    if (mode === 'never') return deny(`${toolName} is turned off for you. Do not try it again; tell the user if you need it.`)
    if (toolName === 'WebFetch') {
      const blocked = await privateTargetReason(str(input['url']))
      if (blocked) return deny(`WebFetch cannot open local or private network addresses (${blocked}).`)
    }
    if (mode === 'always') return { allow: true }
    if (FILE_PERMISSIONS.has(permission)) {
      const workspace = turn.toolContext.workspaceDir
      const path = inputPath(input, workspace) ?? (toolName === 'Glob' || toolName === 'Grep' ? workspace : undefined)
      const free = READ_PERMISSIONS.has(permission) ? [workspace, ...readableFiles] : [workspace]
      if (path && free.some((dir) => isReallyInside(path, dir))) return { allow: true }
    }
    const ctx: ToolContext = { ...turn.toolContext, callId, signal: AbortSignal.any([turn.signal, signal]) }
    const decision = await deps.approvals.request({
      ctx,
      toolName: permission,
      summary: deps.secrets.redact(permissionSummary(toolName, input, title)),
      toolInput: JSON.parse(deps.secrets.redact(JSON.stringify(input)))
    })
    if (decision === 'always' || decision === 'never') {
      try {
        deps.tools.setPermission(permission, decision, bot.id)
      } catch (err) {
        console.warn('[claude-code] could not save permission:', err instanceof Error ? err.message : String(err))
      }
    }
    return decision === 'allow_once' || decision === 'always' ? { allow: true } : deny(ctx.signal.aborted ? 'Cancelled.' : DECLINED_MESSAGE)
  }
}

const isOwnTool = (name: string) => name.startsWith(`mcp__${BRIDGE_SERVER}__`) || name.startsWith(`mcp__${CONNECTORS_SERVER}__`)

/** Claude Code's permission prompts, answered with FaiBots permissions and approval cards. */
function permissionGate(turn: EngineTurn, deps: ClaudeCodeEngineDeps, readableFiles: string[]): CanUseTool {
  const check = gate(turn, deps, readableFiles)
  return async (toolName, input, options): Promise<PermissionResult> => {
    // FaiBots and connector tools check permissions themselves, in the registry.
    if (isOwnTool(toolName)) return { behavior: 'allow', updatedInput: input }
    const decision = await check(toolName, input, options.toolUseID, options.signal, options.title)
    return decision.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: decision.message }
  }
}

/**
 * The same gate as a PreToolUse hook. Claude Code allows its read-only tools (Read, Grep, Glob,
 * LS) without asking canUseTool, so without this a bot could read any file on the disk. The
 * hook runs before Claude Code's own rules, for every built-in tool that maps to a FaiBots
 * permission; other internal tools (TodoWrite, …) keep Claude Code's normal handling.
 */
function permissionHook(turn: EngineTurn, deps: ClaudeCodeEngineDeps, readableFiles: string[]): HookCallback {
  const check = gate(turn, deps, readableFiles)
  return async (input, toolUseID, options) => {
    if (input.hook_event_name !== 'PreToolUse' || isOwnTool(input.tool_name) || !(input.tool_name in PERMISSION_OF)) return {}
    const args = (input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {}) as Record<string, unknown>
    const decision = await check(input.tool_name, args, toolUseID ?? input.tool_use_id, options.signal)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.allow ? 'allow' : 'deny',
        ...(!decision.allow && { permissionDecisionReason: decision.message })
      }
    }
  }
}

const AUTH_ERRORS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error'])

function assistantError(code: string): ProviderError {
  if (AUTH_ERRORS.has(code)) {
    return new ProviderError(`Claude Code could not use your login (${code.replace(/_/g, ' ')}). Run \`claude\` in a terminal to sign in again.`)
  }
  if (code === 'rate_limit') return new ProviderError('Claude Code hit your plan’s usage limit. Try again later.', true)
  return new ProviderError(`Claude Code reported an error: ${code.replace(/_/g, ' ')}.`)
}

interface AttemptResult {
  /** Text or tool calls reached the chat. */
  produced: boolean
  error?: Error
}

/** The Agent SDK is large; load it on the first Claude Code turn, not at app start. */
const loadQuery = async (): Promise<typeof claudeQuery> => (await import('@anthropic-ai/claude-agent-sdk')).query

export function createClaudeCodeEngine(deps: ClaudeCodeEngineDeps): TurnEngine {
  const attempt = async (turn: EngineTurn, resume: string | undefined): Promise<AttemptResult> => {
    const query = deps.query ?? (await loadQuery())
    const { recorder } = turn
    const workspace = turn.toolContext.workspaceDir
    const { text: prompt, newEntries, replayedEntries } = turnPrompt(turn, deps.store, !resume)
    const connectors = connectorToolNames(turn.tools)
    const bridge = await deps.bridge.open(turn.toolContext)
    const abortController = new AbortController()
    const onAbort = () => abortController.abort()
    turn.signal.addEventListener('abort', onAbort, { once: true })

    const mcpServers: Record<string, McpServerConfig> = {
      [BRIDGE_SERVER]: { type: 'http', url: bridge.url, headers: bridge.headers, timeout: TOOL_TIMEOUT_MS }
    }
    if (connectors.size > 0) mcpServers[CONNECTORS_SERVER] = connectorServer(turn, connectors, deps.tools)

    const modelId = turn.route.modelId
    // Attachments share one store folder: Claude Code may look in it, but only this turn's own
    // files are free to read; anything else there asks.
    const readableFiles = newEntries.flatMap((e) => e.attachments.map((a) => a.path))
    const options: Options = {
      ...(turn.selectedResultTrigger && { persistSession: false }),
      cwd: workspace,
      additionalDirectories: attachmentDirs(newEntries),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: promptText(turn.system) },
      ...(resume && { resume }),
      includePartialMessages: true,
      mcpServers,
      allowedTools: [`mcp__${BRIDGE_SERVER}`, `mcp__${CONNECTORS_SERVER}`],
      canUseTool: permissionGate(turn, deps, readableFiles),
      hooks: { PreToolUse: [{ hooks: [permissionHook(turn, deps, readableFiles)], timeout: GATE_HOOK_TIMEOUT_SEC }] },
      // A turn is one reply; this bounds a runaway tool loop (native turns stop at 25 steps).
      maxTurns: 50,
      abortController,
      env: claudeCodeEnv(),
      ...claudeCodePathOption(),
      settingSources: [],
      permissionMode: 'default',
      ...(modelId && modelId !== DEFAULT_MODEL_ALIAS && { model: modelId }),
      ...(turn.route.effort && { effort: turn.route.effort })
    }

    let produced = false
    const streamed = new Set<string>()
    let currentMessageId: string | undefined
    let blockType: string | undefined
    let error: Error | undefined

    const handle = (msg: SDKMessage) => {
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') turn.saveContext({ engineSessionId: msg.session_id, engineBinding: sessionBinding('claude-code', turn.route) })
          else if (msg.subtype === 'api_retry') recorder.phase('thinking', 'Retrying after a hiccup')
          return
        case 'stream_event': {
          if (msg.parent_tool_use_id) return
          const event = msg.event
          if (event.type === 'message_start') {
            currentMessageId = event.message.id
          } else if (event.type === 'content_block_start') {
            blockType = event.content_block.type
            if (blockType === 'thinking' || blockType === 'redacted_thinking') recorder.phase('thinking')
            else if (event.content_block.type === 'tool_use') {
              recorder.endText()
              recorder.phase('tool', claudeToolTitle(displayToolName(event.content_block.name, connectors), {}, turn.activityFor))
            }
          } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            if (currentMessageId) streamed.add(currentMessageId)
            recorder.textDelta(event.delta.text)
            produced = true
          } else if (event.type === 'content_block_stop') {
            if (blockType === 'text') recorder.endText()
            blockType = undefined
          }
          return
        }
        case 'assistant': {
          if (msg.parent_tool_use_id) return
          if (msg.error && msg.error !== 'max_output_tokens') error = assistantError(msg.error)
          for (const block of msg.message.content) {
            if (block.type === 'text' && !streamed.has(msg.message.id)) {
              recorder.textDelta(block.text)
              recorder.endText()
              if (block.text.trim()) produced = true
            } else if (block.type === 'tool_use') {
              const input = (block.input ?? {}) as Record<string, unknown>
              const name = displayToolName(block.name, connectors)
              const title = name === block.name ? claudeToolTitle(name, input, turn.activityFor) : turn.activityFor(name, input)
              recorder.toolStart(block.id, name, title, input)
              recorder.phase('tool', title)
              produced = true
            }
          }
          return
        }
        case 'user': {
          if (msg.parent_tool_use_id) return
          const content = msg.message.content
          if (!Array.isArray(content)) return
          for (const block of content) {
            if (block.type !== 'tool_result') continue
            const text = contentText(block.content)
            recorder.toolEndText(block.tool_use_id, statusFromText(!!block.is_error, text, turn.signal.aborted), text)
          }
          recorder.phase('thinking')
          return
        }
        case 'result':
          turn.saveContext({ engineSessionId: msg.session_id, engineBinding: sessionBinding('claude-code', turn.route) })
          recorder.addUsage({
            inputTokens: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
            outputTokens: msg.usage.output_tokens
          })
          if (msg.subtype !== 'success') {
            error ??= new ProviderError(
              msg.subtype === 'error_max_turns' ? 'Claude Code stopped: it reached its turn limit.' : 'Claude Code stopped with an error.'
            )
          } else if (msg.is_error) {
            error ??= new ProviderError(`Claude Code: ${msg.result.slice(0, 500) || 'the request failed.'}`)
          }
          return
        default:
          return
      }
    }

    try {
      mkdirSync(workspace, { recursive: true })
      turn.disclose?.([
        ...turn.tools.filter((t) => !t.name.startsWith('mcp__')).map(({ name }) => ({ name, exposedAs: `mcp__${BRIDGE_SERVER}__${name}` })),
        ...[...connectors].map(([exposed, tool]) => ({ name: tool.name, exposedAs: `mcp__${CONNECTORS_SERVER}__${exposed}` }))
      ], [...replayedEntries, ...newEntries], ['Claude Code manages its built-in tools. Mapped file, shell and web actions use the faibots permission gate. The full host catalog is unavailable.'])
      const q = query({ prompt, options })
      try {
        for await (const msg of q) {
          handle(msg)
          if (turn.signal.aborted) break
        }
      } finally {
        q.close()
      }
    } catch (err) {
      if (!turn.signal.aborted) error ??= err instanceof Error ? err : new Error(String(err))
    } finally {
      turn.signal.removeEventListener('abort', onAbort)
      bridge.close()
      recorder.endText()
    }
    return { produced, ...(error && { error }) }
  }

  return {
    async run(turn) {
      let resume = turn.context.engineSessionId
      // A session made by another engine is not ours to resume: start fresh (history is included).
      if (resume && turn.context.engineBinding && turn.context.engineBinding !== sessionBinding('claude-code', turn.route)) {
        turn.saveContext({ engineSessionId: undefined, engineBinding: undefined, systemHash: undefined })
        resume = undefined
      }
      let result = await attempt(turn, resume)
      // A stored session can disappear (Claude Code cleaned it up, or another computer):
      // start a fresh one once, with the recent history included.
      if (result.error && resume && !result.produced && !turn.signal.aborted) {
        turn.saveContext({ engineSessionId: undefined, engineBinding: undefined })
        result = await attempt(turn, undefined)
      }
      if (result.error && !turn.signal.aborted) throw result.error
    }
  }
}
