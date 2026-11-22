// Assembles the runtime: the three engines, the orchestrator, and the collab tools in the registry.

import type { EngineKind } from '../providers/catalog'
import { createClaudeCodeEngine } from './claude-code-engine'
import { createCodexEngine } from './codex-engine'
import { collabTools } from './collab-tools'
import type { TurnEngine } from './engine'
import { createNativeEngine } from './native-engine'
import { Orchestrator, type RuntimeDeps } from './orchestrator'

export interface CreateRuntimeOptions {
  /** Replace engines (tests use a fake). */
  engines?: Partial<Record<EngineKind, TurnEngine>>
  exchangeTimeoutMs?: number
  now?: () => Date
}

export function createRuntime(deps: RuntimeDeps, options: CreateRuntimeOptions = {}): Orchestrator {
  const { store, providers, attachments, bridge, approvals, tools, secrets, bus } = deps
  const engines: Record<EngineKind, TurnEngine> = {
    native: options.engines?.native ?? createNativeEngine({ store, providers, attachments }),
    'claude-code': options.engines?.['claude-code'] ?? createClaudeCodeEngine({ store, bridge, approvals, tools, secrets }),
    codex: options.engines?.codex ?? createCodexEngine({ store, bridge, providers })
  }
  const runtime = new Orchestrator(deps, {
    engines,
    ...(options.exchangeTimeoutMs !== undefined && { exchangeTimeoutMs: options.exchangeTimeoutMs }),
    ...(options.now && { now: options.now })
  })
  for (const tool of collabTools({ store, skills: deps.skills, tools, bus, runtime })) tools.register(tool)
  return runtime
}

export { Orchestrator, MAX_CHAIN_DEPTH, MAX_ASKS_PER_TURN, MAX_ASKS_PER_CHAIN, EXCHANGE_TIMEOUT_MS, normalizeGroupSettings, type TurnOutcome } from './orchestrator'
export type { EngineTurn, TurnEngine } from './engine'
