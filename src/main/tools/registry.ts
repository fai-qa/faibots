// The one gate every tool call goes through: permission (bot override > global > tool default),
// approval card when needed, execution, secret redaction and output truncation.

import type { ApprovalDecision, Bot, Id, PermissionMode, ToolInfo } from '@shared/domain'
import type {
  ApprovalService, EventBus, SecretVault, Store, ToolContext, ToolDefinition, ToolRegistry, ToolResult
} from '../contracts'
import { errorResult, type PlatformToolDefinition } from './define'
import { executeAction, snapshotInput } from './action-executor'

/** Total characters of text a tool result may hand to a model. */
export const MAX_RESULT_CHARS = 30_000

/** Where MCP tools come from (the McpHost). */
export interface McpToolSource {
  toolsForBot(bot: Bot): Promise<ToolDefinition[]>
  /** Every enabled server's tools, for the global permissions screen. */
  allTools(): Promise<ToolDefinition[]>
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = (omitted: number) => `\n\n[… ${omitted} characters omitted …]\n\n`
  const room = Math.max(0, max - marker(text.length).length)
  // Keep the start and the end: command output usually has its errors last.
  const head = Math.ceil(room * 0.7)
  const tail = room - head
  return text.slice(0, head) + marker(text.length - head - tail) + (tail > 0 ? text.slice(-tail) : '')
}

/** Redact secrets in every string inside a value (for approval cards stored in the transcript). */
function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)]))
  }
  return value
}

export function createToolRegistry(deps: {
  store: Pick<Store, 'bots' | 'settings' | 'actions'>
  approvals: ApprovalService
  secrets: Pick<SecretVault, 'redact'>
  mcp: McpToolSource
  bus: EventBus
}): ToolRegistry {
  const registered = new Map<string, PlatformToolDefinition>()

  const resolve = (def: Pick<ToolDefinition, 'name' | 'defaultPermission'>, bot?: Bot): PermissionMode =>
    bot?.toolPermissions[def.name] ?? deps.store.settings.get().toolPermissions[def.name] ?? def.defaultPermission

  const mcpTools = async (bot?: Bot): Promise<ToolDefinition[]> => {
    try {
      return bot ? await deps.mcp.toolsForBot(bot) : await deps.mcp.allTools()
    } catch (err) {
      console.warn('[tools] MCP tools unavailable:', err instanceof Error ? err.message : err)
      return []
    }
  }

  /** Redact every text block and keep the text of all blocks together within MAX_RESULT_CHARS. */
  const finalize = (result: ToolResult): ToolResult => {
    let budget = MAX_RESULT_CHARS
    let dropped = 0
    const content: ToolResult['content'] = []
    for (const block of result.content) {
      if (block.type !== 'text') {
        content.push(block)
        continue
      }
      // Too little room left for a useful excerpt: drop the rest instead of growing past the cap.
      if (budget < 200) {
        dropped++
        continue
      }
      const text = truncateText(deps.secrets.redact(block.text), budget)
      budget -= text.length
      content.push({ ...block, text })
    }
    if (dropped > 0) content.push({ type: 'text', text: `[… ${dropped} more text block${dropped > 1 ? 's' : ''} omitted]` })
    return { ...result, content, ...(result.display && { display: redactDeep(result.display, deps.secrets.redact) as ToolResult['display'] }) }
  }

  const setPermission = (toolName: string, mode: PermissionMode | null, botId?: Id) => {
    if (botId) {
      const bot = deps.store.bots.get(botId)
      if (!bot) throw new Error('Bot not found')
      const toolPermissions = { ...bot.toolPermissions }
      if (mode) toolPermissions[toolName] = mode
      else delete toolPermissions[toolName]
      deps.store.bots.update(botId, { toolPermissions })
      deps.bus.emit('bots:changed', { bots: deps.store.bots.list() })
    } else {
      const toolPermissions = { ...deps.store.settings.get().toolPermissions }
      if (mode) toolPermissions[toolName] = mode
      else delete toolPermissions[toolName]
      deps.bus.emit('settings:changed', { settings: deps.store.settings.update({ toolPermissions }) })
    }
  }

  const cancelled = (): ToolResult => ({ ...errorResult('Cancelled.'), outcome: 'cancelled' })
  const declined = (ctx: ToolContext): ToolResult =>
    ctx.signal.aborted
      ? cancelled()
      : { ...errorResult('The user declined this action. Do not retry it; ask them what they would like instead.'), outcome: 'denied' }

  return {
    register(def) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) throw new Error(`Invalid tool name "${def.name}"`)
      if (def.name.startsWith('mcp__')) throw new Error('mcp__ names are reserved for MCP tools')
      if (registered.has(def.name)) throw new Error(`Tool "${def.name}" is already registered`)
      registered.set(def.name, def)
    },

    async forTurn(ctx) {
      const defs = [...registered.values(), ...(await mcpTools(ctx.bot))]
      return defs.filter((def) => (def.isAvailable?.(ctx) ?? true) && resolve(def, ctx.bot) !== 'never')
    },

    async info(botId) {
      const bot = botId ? deps.store.bots.get(botId) : undefined
      const defs: PlatformToolDefinition[] = [...registered.values(), ...(await mcpTools(bot))]
      return defs.map((def): ToolInfo => ({
        name: def.name,
        description: def.description,
        source: def.source,
        ...(def.serverId && { serverId: def.serverId }),
        defaultPermission: def.defaultPermission,
        effectivePermission: resolve(def, bot),
        ...(def.autoAllowedInWorkspace && { autoAllowedInWorkspace: true })
      }))
    },

    setPermission,

    async execute(name, input, ctx) {
      if (ctx.signal.aborted) return cancelled()
      if (ctx.actionId) {
        try { input = snapshotInput(input) } catch { return errorResult('Action input must be serializable JSON.') }
      }
      const isConnector = !registered.has(name) && name.startsWith('mcp__')
      // Connector identity is fixed at turn start (ctx.mcpTools): names are renumbered when grants
      // change, so a name alone could now point at another server. Without that map the call has no
      // verifiable connector authority, so deny instead of resolving by name (fail closed): a caller
      // that passes no map gets a refusal, never an unverified execution.
      if (isConnector && !ctx.mcpTools) {
        return {
          ...errorResult(`${name} has no verifiable connector grant for this turn. Do not retry it.`),
          outcome: 'denied'
        }
      }
      const ref = isConnector ? ctx.mcpTools!.get(name) : undefined
      if (isConnector && !ref) return errorResult(`Unknown tool "${name}".`)
      // Identity check by server and remote tool name only; a by-name match can no longer satisfy a connector call.
      const sameTool = (d: ToolDefinition) => d.serverId === ref!.serverId && d.remoteName === ref!.remoteName
      /** The connector as the bot's stored grants allow it right now; undefined once the bot or the grant is gone. */
      const granted = async (): Promise<ToolDefinition | undefined> => {
        const stored = deps.store.bots.get(ctx.bot.id)
        const found = stored ? (await mcpTools(stored)).find(sameTool) : undefined
        return found && { ...found, name }
      }
      const revoked = (): ToolResult => ({
        ...errorResult(`${name} is no longer available to this bot: its connector was removed. Do not retry it.`),
        outcome: 'denied'
      })

      let def: PlatformToolDefinition | undefined = registered.get(name)
      if (!def && isConnector) {
        // Only the turn-start identity can satisfy a connector call; a stale by-name fallback is closed.
        def = await granted()
        if (!def) return revoked()
      }
      if (!def) return errorResult(`Unknown tool "${name}".`)
      if (def.isAvailable && !def.isAvailable(ctx)) return errorResult(`${name} is not available here.`)

      // Limit: a call already dispatched to the connector runs to completion; revoking does not cancel it.
      const authorize = async (dispatch: () => Promise<ToolResult>): Promise<ToolResult> => {
        // Read the bot fresh: an "Always" earlier in this turn changed its overrides.
        const stored = deps.store.bots.get(ctx.bot.id)
        const bot = stored ?? ctx.bot
        if (isConnector && !(await granted())) return revoked()
        const mode = resolve(def, bot)
        if (mode === 'never') {
          return { ...errorResult(`${name} is turned off for you. Do not try it again; tell the user if you need it.`), outcome: 'denied' }
        }

        let autoAllowed = false
        try {
          autoAllowed = mode === 'always' || !!def.autoAllow?.(input, ctx)
        } catch {
          autoAllowed = false
        }

        if (!autoAllowed) {
          let summary: string
          try {
            summary = def.summarize?.(input, ctx) ?? `${def.activityLabel}: ${JSON.stringify(input)}`
          } catch {
            summary = `${def.activityLabel}: ${JSON.stringify(input)}`
          }
          let decision: ApprovalDecision
          try {
            decision = await deps.approvals.request({
              ctx,
              toolName: name,
              summary: deps.secrets.redact(summary),
              toolInput: redactDeep(input, deps.secrets.redact)
            })
          } catch (err) {
            return errorResult(`Could not ask the user for approval: ${err instanceof Error ? err.message : String(err)}`)
          }
          if (decision === 'always' || decision === 'never') {
            try {
              setPermission(name, decision, bot.id)
            } catch (err) {
              console.warn('[tools] could not save permission:', err instanceof Error ? err.message : err)
            }
          }
          if (decision === 'deny' || decision === 'never') return declined(ctx)
        }

        if (ctx.signal.aborted) return cancelled()
        // The approval card may have been open a while: check the grant again right before dispatch.
        if (isConnector && !(await granted())) return revoked()
        return dispatch()
      }
      if (ctx.actionId && !def.requiresLiveRead) return executeAction({ actions: deps.store.actions, ctx, def, input, finalize, authorize })
      try { return finalize(await authorize(() => def.execute(input, ctx))) }
      catch (err) { return finalize(errorResult(`${name} failed: ${err instanceof Error ? err.message : String(err)}`)) }
    }
  }
}
