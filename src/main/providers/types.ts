// Provider-neutral shapes the native engine speaks. Each ModelAdapter translates them to its SDK
// (the official Anthropic SDK, or the Vercel AI SDK for OpenAI, Gemini, xAI and compatible servers)
// and keeps the provider's own message format for the turn in progress, so things like Claude's
// thinking blocks or OpenAI reasoning items go back to the model exactly as they came.

import type { ModelRoute } from '@shared/domain'
import type { JsonSchema, ToolResult } from '../contracts'

/** One piece of user-side content. */
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }

/**
 * The conversation as one bot sees it, before the current turn. Other speakers are user turns
 * (prefixed with their name); the bot's own earlier messages are assistant turns.
 */
export type ChatMessage =
  | { role: 'user'; content: ChatPart[] }
  | { role: 'assistant'; text: string }

export interface ToolSpec {
  name: string
  description: string
  inputSchema: JsonSchema
}

/**
 * The system prompt in two parts. `stable` (rules, identity, soul, room, skills, connectors)
 * rarely changes and is cached; `volatile` (memory, today's date) comes after the cache break.
 */
export interface SystemPrompt {
  stable: string
  volatile: string
}

export interface ToolCallRequest {
  /** The model's id for this call. */
  id: string
  name: string
  input: unknown
  /** Set when the model's arguments could not be used (bad JSON, unknown tool). */
  inputError?: string
}

export type StepStop =
  /** The model finished its reply. */
  | 'end'
  /** The model wants the tool calls run. */
  | 'tool_use'
  /** The reply hit the output limit. */
  | 'max_tokens'
  /** The model (or the provider's safety system) declined. */
  | 'refusal'
  /** The prompt no longer fits the model's context window. */
  | 'context'

export interface StepResult {
  stop: StepStop
  /** All text the model wrote in this step. */
  text: string
  toolCalls: ToolCallRequest[]
  usage?: { inputTokens?: number; outputTokens?: number }
  /** Extra words for a refusal or an odd stop, safe to show the user. */
  detail?: string
}

/** Streaming callbacks for one model step. */
export interface StepEvents {
  onTextDelta(delta: string): void
  /** A text block ended; the next text starts a new chat message. */
  onTextEnd(): void
  onThinking(): void
  /** The model started writing a call to this tool. */
  onToolInputStart(name: string): void
}

/** One bot turn against one model: a sequence of steps with tool results in between. */
export interface ModelTurn {
  /** One model call. Streams through `events`; resolves when the response is complete. */
  step(events: StepEvents, signal: AbortSignal): Promise<StepResult>
  /** The results of every tool call of the last step, in call order, sent back as one batch. */
  addToolResults(results: { call: ToolCallRequest; result: ToolResult }[]): void
}

export interface TurnSpec {
  modelId: string
  effort?: ModelRoute['effort']
  system: SystemPrompt
  /** Must end with a user message. */
  messages: ChatMessage[]
  tools: ToolSpec[]
}

export interface CompleteRequest {
  modelId: string
  system: string
  prompt: string
  maxTokens: number
  signal: AbortSignal
}

export interface ModelAdapter {
  startTurn(spec: TurnSpec): ModelTurn
  /** One plain completion without tools (summaries, routing). */
  complete(request: CompleteRequest): Promise<string>
}

/** An error whose message is safe and useful to show in the chat. */
export class ProviderError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message)
    this.name = 'ProviderError'
  }
}
