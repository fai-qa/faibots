// What every TurnEngine receives for one bot turn, and what it must do: run the bot until it is
// done, writing everything the chat shows through `recorder` and every FaiBots tool call through
// `runTool` (which keeps approvals and permissions in the ToolRegistry). Errors may be thrown;
// the orchestrator turns them into an event line.

import { createHash } from 'node:crypto'
import type { Bot,Conversation, Entry, Id } from '@shared/domain'
import type { OfferedTool } from '@shared/turn-context'
import type { BotContextState, ToolContext, ToolDefinition, ToolResult } from '../contracts'
import type { ResolvedRoute } from '../providers/provider-service'
import type { SystemPrompt, ToolCallRequest } from '../providers/types'
import type { TurnRecorder } from './turn-recorder'

export interface EngineTurn {
  turnId: Id
  bot: Bot
  conversation: Conversation
  route: ResolvedRoute
  system: SystemPrompt
  /** FaiBots tools this bot may call in this turn (MCP ones included). */
  tools: ToolDefinition[]
  /** Only the adapter's outbound tool metadata and selected references enter storage. */
  disclose?(tools: Pick<OfferedTool, 'name' | 'exposedAs' | 'hostApproval'>[], entries: Entry[], omissions: string[]): void
  toolContext: Omit<ToolContext, 'callId'>
  /** The bot's saved state for this conversation, as it was when the turn started. */
  context: BotContextState
  /** The turn sees entries up to this seq; later ones wait for its next turn. */
  upToSeq: number
  /** Per-turn instructions for the end of the newest message ('' = none). */
  turnNote: string
  recorder: TurnRecorder
  signal: AbortSignal
  nameOf(author: Entry['author']): string
  /** Activity label for a tool call, e.g. "Running a command", "Messaging Researcher". */
  activityFor(toolName: string, input?: unknown): string
  /** True once the bot called pass_turn in this turn. */
  passed(): boolean
  /** Run one tool call through the ToolRegistry, with its card and live phase. */
  runTool(call: ToolCallRequest): Promise<ToolResult>
  /** Save engine state for the next turn (summary, engine session id). */
  saveContext(patch: Partial<Omit<BotContextState, 'conversationId' | 'botId'>>): void
}

export interface TurnEngine {
  run(turn: EngineTurn): Promise<void>
}

/**
 * What a saved external session belongs to: the engine plus the provider identity from the route
 * (its stable id and a hash of its base URL; never a key). The model is deliberately not part of it.
 */
export function sessionBinding(engine: 'claude-code' | 'codex', route: ResolvedRoute): string {
  const url = route.provider.baseUrl ? createHash('sha1').update(route.provider.baseUrl).digest('hex').slice(0, 8) : ''
  return `${engine}:${route.provider.id}:${url}`
}

/** The engine already displayed this terminal stop; it must not become successful execution. */
export class IncompleteTurnError extends Error {}

// Re-exported for engines and tests.
export type { BotContextState, Conversation, ToolCallRequest }
