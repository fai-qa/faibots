// The Codex TurnEngine: runs the bot's turn in Codex through the Codex SDK, on the user's
// `codex login` (ChatGPT plan), or on an API key only when the user stored one for this provider.
//   - one Codex thread per (conversation, bot); its id is BotContextState.engineSessionId
//   - the thread works in the bot's workspace folder (skipGitRepoCheck), sandboxed to it
//   - our system prompt is prepended to the first message of a thread
//   - FaiBots tools come through the ToolBridge, configured as a streamable-HTTP MCP server whose
//     bearer token is passed in an environment variable (not on the command line)
//   - runStreamed events become messages and tool cards
//
// Codex has no permission callback, so its own commands cannot raise FaiBots approval cards.
// It runs with approval policy "never" inside its sandbox: writes stay inside the workspace and
// network access stays off. A bot whose `shell` permission is "never" gets a read-only sandbox.
// FaiBots tools called through the bridge still go through the ToolRegistry and its approvals.

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { Codex, type CodexOptions, type Input, type ThreadEvent, type ThreadItem, type ThreadOptions, type UserInput } from '@openai/codex-sdk'
import type { PermissionMode } from '@shared/domain'
import type { Store, ToolBridge } from '../contracts'
import { DEFAULT_MODEL_ALIAS } from '../providers/catalog'
import { codexEnv, findCodexBinary, withPathDirs } from '../providers/external'
import type { RuntimeProviders } from '../providers/provider-service'
import { ProviderError } from '../providers/types'
import { BRIDGE_SERVER } from './claude-code-engine'
import { sessionBinding, type EngineTurn, type TurnEngine } from './engine'
import { contentText, statusFromText, turnPrompt } from './external-common'
import { promptText } from './prompt'

const BRIDGE_TOKEN_ENV = 'FAIBOTS_BRIDGE_TOKEN'
/** send_to_agent can wait 10 minutes and approvals longer; Codex's default MCP timeout is 60 s. */
const TOOL_TIMEOUT_SEC = 30 * 60
// These app tools keep their native permission checks, even when invoked by the subscription CLI.
const desktopTools = [
  'read_file', 'write_file', 'send_to_agent', 'list_bots', 'create_bot', 'pass_turn',
  'assign_to_agent', 'assignment_status', 'wait_for_assignment', 'cancel_assignment', 'group_work_snapshot',
  'plan_work', 'review_work', 'read_handoff'
]
const DESKTOP_BRIDGE_TOOLS = `{ ${desktopTools.map((tool) => `${tool} = { approval_mode = "approve" }`).join(', ')} }`
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/i

/** The slice of the Codex SDK the engine uses (tests pass a fake). */
export interface CodexLike {
  startThread(options?: ThreadOptions): ThreadLike
  resumeThread(id: string, options?: ThreadOptions): ThreadLike
}
export interface ThreadLike {
  runStreamed(input: Input, turnOptions?: { signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>
}

export interface CodexEngineDeps {
  store: Pick<Store, 'entries' | 'settings' | 'bots'>
  bridge: ToolBridge
  providers: Pick<RuntimeProviders, 'apiKey'>
  codex?: (options: CodexOptions) => CodexLike
}

/**
 * Hash of the system block for change detection. The block's only clock-driven part is the
 * "Today is ..." line of the environment section; it is left out so the block is not resent daily.
 * Soul, role, memory, skills and connectors are all included.
 */
function systemHash(turn: EngineTurn): string {
  const { stable, volatile } = turn.system
  const steady = `${stable}\n\u0000\n${volatile.replace(/^- Today is .*$/m, '')}`
  return createHash('sha256').update(steady).digest('hex')
}

function commandText(item: Extract<ThreadItem, { type: 'command_execution' }>): string {
  const exit = item.exit_code === undefined ? '' : `\n\nexit code ${item.exit_code}`
  return `${item.aggregated_output.trim()}${exit}`.trim()
}

export function createCodexEngine(deps: CodexEngineDeps): TurnEngine {
  const makeCodex = deps.codex ?? ((options: CodexOptions) => new Codex(options))

  const attempt = async (turn: EngineTurn, resume: string | undefined): Promise<{ produced: boolean; error?: Error }> => {
    const { recorder, route } = turn
    const workspace = turn.toolContext.workspaceDir
    const bot = deps.store.bots.get(turn.bot.id) ?? turn.bot
    const shellMode: PermissionMode | undefined = bot.toolPermissions['shell'] ?? deps.store.settings.get().toolPermissions['shell']
    const { text, newEntries, replayedEntries } = turnPrompt(turn, deps.store, !resume)

    const bridge = await deps.bridge.open(turn.toolContext)
    const token = /^Bearer\s+(.+)$/i.exec(bridge.headers['Authorization'] ?? bridge.headers['authorization'] ?? '')?.[1] ?? ''
    const apiKey = deps.providers.apiKey(route.provider.id)
    // Use the same executable as the connection check, including an unpacked or explicit local copy.
    // When given an executable, the SDK leaves adding its helper directory to the caller.
    const found = findCodexBinary()
    const serverNames = (value = '') => value.split(',')
      .map((name) => name.trim())
      .filter((name) => /^[a-zA-Z0-9_-]+$/.test(name) && name !== BRIDGE_SERVER)
    const disabledServers = serverNames(process.env['FAIBOTS_CODEX_DISABLED_SERVERS'])
    const disabledRuntimeServers = serverNames(process.env['FAIBOTS_CODEX_DISABLED_RUNTIME_SERVERS'])
    const codex = makeCodex({
      ...(apiKey && { apiKey }),
      ...(route.provider.baseUrl && { baseUrl: route.provider.baseUrl }),
      ...(found && { codexPathOverride: found.path }),
      env: withPathDirs(codexEnv({ [BRIDGE_TOKEN_ENV]: token }), found?.pathDirs ?? []),
      configOverrides: [
        `mcp_servers={ ${BRIDGE_SERVER} = { url = ${JSON.stringify(bridge.url)}, bearer_token_env_var = "${BRIDGE_TOKEN_ENV}", tool_timeout_sec = ${TOOL_TIMEOUT_SEC}, tools = ${DESKTOP_BRIDGE_TOOLS} } }`,
        ...disabledServers.map((name) => `mcp_servers.${name}.enabled=false`),
        // Runtime-injected servers have no transport in the underlying user configuration.
        ...disabledRuntimeServers.map((name) => `mcp_servers.${name}={ enabled = false, url = "http://127.0.0.1:1/mcp" }`),
        // These app tools still pass through the faibots registry and its workspace/approval rules.
        // The CLI has no callback for its own MCP approval prompts.
        'features.apps=false',
        'features.plugins=false',
        'features.skill_mcp_dependency_install=false',
        'web_search="disabled"'
      ]
    })
    const threadOptions: ThreadOptions = {
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      // Codex cannot raise approval cards for its own commands, so it only gets a writable
      // workspace when the user set shell to Always; otherwise it runs read-only and writes
      // through FaiBots's write_file / edit_file tools, which do ask.
      sandboxMode: shellMode === 'always' ? 'workspace-write' : 'read-only',
      approvalPolicy: 'never',
      ...(route.modelId && route.modelId !== DEFAULT_MODEL_ALIAS && { model: route.modelId }),
      ...(route.effort && { modelReasoningEffort: route.effort })
      // No additionalDirectories: they would make the attachment store writable. Codex's
      // sandbox can read attachments where they are.
    }

    const block = promptText(turn.system)
    const hash = systemHash(turn)
    // A resumed thread only gets the block again when it changed since the last delivery.
    const first = !resume
      ? `${block}\n\n---\n\n${text}`
      : turn.context.systemHash === hash
        ? text
        : `Updated instructions (these replace any earlier instructions):\n\n${block}\n\n---\n\n${text}`
    const images: UserInput[] = newEntries
      .flatMap((e) => e.attachments)
      .filter((a) => IMAGE_MIME.test(a.mimeType))
      .map((a) => ({ type: 'local_image', path: a.path }))
    const input: Input = images.length ? [{ type: 'text', text: first }, ...images] : first

    let produced = false
    let error: Error | undefined
    const texts = new Map<string, string>()

    const onItem = (stage: 'started' | 'updated' | 'completed', item: ThreadItem) => {
      switch (item.type) {
        case 'agent_message': {
          const before = texts.get(item.id) ?? ''
          if (item.text.startsWith(before) && item.text.length > before.length) {
            recorder.textDelta(item.text.slice(before.length))
            produced = true
          }
          texts.set(item.id, item.text)
          if (stage === 'completed') recorder.endText()
          return
        }
        case 'reasoning':
          recorder.phase('thinking')
          return
        case 'command_execution':
          if (stage === 'started') {
            const title = `Running \`${item.command.slice(0, 120)}\``
            recorder.toolStart(item.id, 'shell', title, { command: item.command })
            recorder.phase('tool', title)
            produced = true
          } else if (stage === 'completed') {
            const failed = item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0)
            recorder.toolEndText(item.id, failed ? 'error' : 'done', commandText(item))
            recorder.phase('thinking')
          }
          return
        case 'file_change':
          if (stage === 'completed') {
            const title = `Changed ${item.changes.length} file${item.changes.length === 1 ? '' : 's'}`
            recorder.toolStart(item.id, 'edit_file', title, { changes: item.changes })
            recorder.toolEndText(item.id, item.status === 'failed' ? 'error' : 'done', item.changes.map((c) => `${c.kind} ${c.path}`).join('\n'))
            produced = true
          }
          return
        case 'mcp_tool_call': {
          const name = item.server === BRIDGE_SERVER ? item.tool : `mcp__${item.server}__${item.tool}`
          if (stage === 'started') {
            const title = turn.activityFor(name, item.arguments)
            recorder.toolStart(item.id, name, title, item.arguments)
            recorder.phase('tool', title)
            produced = true
          } else if (stage === 'completed') {
            const resultText = item.error ? item.error.message : contentText(item.result?.content)
            const isError = item.status === 'failed' || !!item.error
            recorder.toolEndText(item.id, statusFromText(isError, resultText, turn.signal.aborted), resultText)
            recorder.phase('thinking')
          }
          return
        }
        case 'web_search':
          if (stage === 'started') {
            const title = `Searching the web for “${item.query}”`
            recorder.toolStart(item.id, 'web_search', title, { query: item.query })
            recorder.phase('tool', title)
          } else if (stage === 'completed') {
            recorder.toolEndText(item.id, 'done', '')
          }
          return
        default:
          return
      }
    }

    const handle = (event: ThreadEvent) => {
      switch (event.type) {
        case 'thread.started':
          turn.saveContext({ engineSessionId: event.thread_id, engineBinding: sessionBinding('codex', route) })
          return
        case 'turn.started':
          // Codex has accepted the input, so the block it carried is delivered: only now remember it.
          turn.saveContext({ engineBinding: sessionBinding('codex', route), systemHash: hash })
          recorder.phase('thinking')
          return
        case 'item.started':
          onItem('started', event.item)
          return
        case 'item.updated':
          onItem('updated', event.item)
          return
        case 'item.completed':
          onItem('completed', event.item)
          return
        case 'turn.completed':
          recorder.addUsage({ inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens })
          return
        case 'turn.failed':
          error ??= new ProviderError(`Codex: ${event.error.message}`)
          return
        case 'error':
          error ??= new ProviderError(`Codex: ${event.message}`)
          return
      }
    }

    try {
      mkdirSync(workspace, { recursive: true })
      const thread = resume ? codex.resumeThread(resume, threadOptions) : codex.startThread(threadOptions)
      turn.disclose?.(turn.tools.filter((t) => !t.name.startsWith('mcp__')).map(({ name }) => ({
        name, exposedAs: `mcp__${BRIDGE_SERVER}__${name}`, hostApproval: desktopTools.includes(name) ? 'app' : 'cli-default'
      })), [...replayedEntries, ...newEntries], [
        'Connector tools are unavailable through the Codex bridge. The CLI may withhold tools under its default approval policy.',
        `Codex shell sandbox: ${threadOptions.sandboxMode}. CLI approvals, web search, apps and plugins are disabled. Other host tools are not inventoried by faibots.`
      ])
      const { events } = await thread.runStreamed(input, { signal: turn.signal })
      for await (const event of events) {
        handle(event)
        if (turn.signal.aborted) break
      }
    } catch (err) {
      if (!turn.signal.aborted) error ??= new ProviderError(err instanceof Error ? err.message.slice(0, 600) : String(err))
    } finally {
      bridge.close()
      recorder.endText()
    }
    return { produced, ...(error && { error }) }
  }

  return {
    async run(turn) {
      let resume = turn.context.engineSessionId
      // A thread made by another engine is not ours to resume: start fresh (history is included).
      if (resume && turn.context.engineBinding && turn.context.engineBinding !== sessionBinding('codex', turn.route)) {
        turn.saveContext({ engineSessionId: undefined, engineBinding: undefined, systemHash: undefined })
        resume = undefined
      }
      let result = await attempt(turn, resume)
      if (result.error && resume && !result.produced && !turn.signal.aborted) {
        turn.saveContext({ engineSessionId: undefined, engineBinding: undefined, systemHash: undefined })
        result = await attempt(turn, undefined)
      }
      if (result.error && !turn.signal.aborted) {
        if (/model_not_found|model.+not supported when using Codex/i.test(result.error.message)) {
          throw new ProviderError(`${result.error.message} Open the bot profile and choose a model listed for your Codex account.`)
        }
        throw result.error
      }
    }
  }
}
