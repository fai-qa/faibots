// Native-engine adapter for the Claude API, on the official @anthropic-ai/sdk.
//
// Request rules (from the claude-api skill and the SDK types):
//   - default model claude-opus-5-5; thinking is adaptive (never budget_tokens, never "disabled");
//     depth is set with output_config.effort
//   - streaming with max_tokens up to 64k; tool_choice stays auto (forced choice is a 400 on
//     Opus 5.5); no assistant prefill (the transcript always ends with a user turn)
//   - every assistant response is echoed back unchanged within the turn, thinking blocks included,
//     and all tool_result blocks of a step go back in one user message
//   - stop_reason is checked before any tool runs (refusal, max_tokens)
//   - prompt caching: explicit breakpoint after the stable system prompt, automatic caching of
//     the growing conversation
// Across turns the history is rebuilt as plain text from the transcript (no thinking blocks), so
// the "preserved thinking" prefix check never sees an edited history.

import Anthropic from '@anthropic-ai/sdk'
import type { ModelRoute } from '@shared/domain'
import type { ToolResult } from '../contracts'
import type { AnthropicModelsClient } from './models'
import {
  ProviderError,
  type ChatMessage,
  type CompleteRequest,
  type ModelAdapter,
  type ModelTurn,
  type StepEvents,
  type StepResult,
  type StepStop,
  type ToolCallRequest,
  type TurnSpec
} from './types'

type Effort = NonNullable<ModelRoute['effort']>

/** What we know about a model from the Models API (filled by ProviderService when it has a list). */
export interface AnthropicModelCaps {
  adaptiveThinking?: boolean
  /** Effort levels the model accepts; undefined = unknown. */
  effortLevels?: Effort[]
  maxOutputTokens?: number
}

/** The slice of the SDK client the adapter uses, so tests can pass a fake. */
export interface AnthropicClientLike {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): AnthropicStreamLike
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>
  }
}

export interface AnthropicStreamLike extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>
}

const STREAM_MAX_TOKENS = 64_000
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** Effort when the bot's route leaves it open. Opus 5.5 would default to medium; agentic work wants high. */
const DEFAULT_EFFORT: Effort = 'high'

// Used only when the Models API has not told us about a model. Families that take adaptive
// thinking and effort: Opus 4.6+, Sonnet 4.6+, Haiku 5+, Opus 5.x, Fable, Mythos.
const ADAPTIVE_FAMILY = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|haiku-5|fable|mythos)/
const LONG_OUTPUT_FAMILY = /^claude-(opus|sonnet|haiku)-(4-[5-9]|5)|^claude-(fable|mythos)/

export function createAnthropicClient(opts: { apiKey: string; baseUrl?: string }): AnthropicClientLike & AnthropicModelsClient {
  // Only the key the user stored for this provider: no ANTHROPIC_API_KEY / auth token / profile
  // fallback, so the billing route shown in the UI is the one that is used.
  const client = new Anthropic({
    apiKey: opts.apiKey,
    authToken: null,
    baseURL: opts.baseUrl ?? 'https://api.anthropic.com',
    maxRetries: 2,
    openTelemetry: false
  })
  return {
    messages: {
      stream: (params, options) => client.messages.stream(params, options),
      create: (params, options) => client.messages.create(params, options)
    },
    models: {
      list: (params, options) => client.models.list(params, options)
    }
  }
}

/** Highest supported effort at or below the requested one. */
function pickEffort(requested: Effort, supported: Effort[] | undefined): Effort | undefined {
  if (!supported) return requested
  for (let i = EFFORTS.indexOf(requested); i >= 0; i--) {
    const level = EFFORTS[i]!
    if (supported.includes(level)) return level
  }
  return undefined
}

/** thinking / output_config / max_tokens for a model, from its capabilities or its family. */
export function modelSettings(
  modelId: string,
  effort: Effort | undefined,
  caps: AnthropicModelCaps | undefined
): { thinking?: Anthropic.ThinkingConfigParam; output_config?: Anthropic.OutputConfig; max_tokens: number } {
  const family = ADAPTIVE_FAMILY.test(modelId)
  const adaptive = caps?.adaptiveThinking ?? family
  const effortKnown = caps?.effortLevels !== undefined || family
  const wanted = effort ?? (effortKnown ? DEFAULT_EFFORT : undefined)
  const chosen = wanted && pickEffort(wanted, caps?.effortLevels)
  const maxOut = caps?.maxOutputTokens ?? (LONG_OUTPUT_FAMILY.test(modelId) ? STREAM_MAX_TOKENS : 8192)
  return {
    ...(adaptive && { thinking: { type: 'adaptive' } }),
    ...(chosen && { output_config: { effort: chosen } }),
    max_tokens: Math.min(STREAM_MAX_TOKENS, maxOut)
  }
}

function toMessageParams(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = messages.map((m): Anthropic.MessageParam => {
    if (m.role === 'assistant') return { role: 'assistant', content: m.text }
    const content: Anthropic.ContentBlockParam[] = []
    for (const part of m.content) {
      if (part.type === 'text') {
        if (part.text) content.push({ type: 'text', text: part.text })
      } else if (IMAGE_TYPES.has(part.mediaType)) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType as 'image/png', data: part.dataBase64 }
        })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '(empty message)' })
    return { role: 'user', content }
  })
  // Never end on an assistant turn: that would be a prefill, which current models reject.
  if (out.length === 0 || out[out.length - 1]!.role === 'assistant') {
    out.push({ role: 'user', content: '(No new messages.)' })
  }
  return out
}

function toolResultBlock(call: ToolCallRequest, result: ToolResult): Anthropic.ToolResultBlockParam {
  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = []
  for (const block of result.content) {
    if (block.type === 'text') {
      if (block.text) content.push({ type: 'text', text: block.text })
    } else if (IMAGE_TYPES.has(block.mediaType)) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType as 'image/png', data: block.dataBase64 }
      })
    } else {
      content.push({ type: 'text', text: `[${block.mediaType} image omitted: unsupported type]` })
    }
  }
  if (content.length === 0) content.push({ type: 'text', text: result.isError ? 'Error.' : '(no output)' })
  return { type: 'tool_result', tool_use_id: call.id, content, ...(result.isError && { is_error: true }) }
}

function mapStop(message: Anthropic.Message): { stop: StepStop; detail?: string } {
  switch (message.stop_reason) {
    case 'tool_use':
      return { stop: 'tool_use' }
    case 'max_tokens':
      return { stop: 'max_tokens' }
    case 'refusal': {
      const details = message.stop_details
      const detail = [details?.category, details?.explanation].filter(Boolean).join(': ')
      return { stop: 'refusal', ...(detail && { detail }) }
    }
    case 'model_context_window_exceeded':
      return { stop: 'context' }
    default:
      // end_turn, stop_sequence, and pause_turn once we have stopped resuming.
      return { stop: 'end' }
  }
}

/** Turn SDK errors into short messages that are safe to show (never the key or headers). */
export function describeAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.APIUserAbortError) return err
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('The Anthropic API key was rejected (401). Check it in Settings → Models.')
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError(`Anthropic refused access (403): ${err.message}`)
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(`Anthropic does not know this model or endpoint (404): ${err.message}`)
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('Anthropic rate limit reached (429). Try again in a moment.', true)
  if (err instanceof Anthropic.BadRequestError) return new ProviderError(`Anthropic rejected the request (400): ${err.message}`)
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(`Could not reach Anthropic: ${err.message}`, true)
  if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic error ${err.status ?? ''}: ${err.message}`.trim(), true)
  return err instanceof Error ? err : new Error(String(err))
}

const MAX_PAUSE_RESUMES = 5

class AnthropicTurn implements ModelTurn {
  private readonly messages: Anthropic.MessageParam[]
  private readonly params: Omit<Anthropic.MessageStreamParams, 'messages'>

  constructor(
    private readonly client: AnthropicClientLike,
    spec: TurnSpec,
    caps: AnthropicModelCaps | undefined
  ) {
    this.messages = toMessageParams(spec.messages)
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: spec.system.stable || 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } }
    ]
    if (spec.system.volatile.trim()) system.push({ type: 'text', text: spec.system.volatile })
    const tools: Anthropic.Tool[] = spec.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.inputSchema, type: 'object' } as Anthropic.Tool.InputSchema
    }))
    this.params = {
      model: spec.modelId,
      system,
      ...(tools.length > 0 && { tools }),
      // Automatic caching of the conversation tail, on top of the system breakpoint.
      cache_control: { type: 'ephemeral' },
      ...modelSettings(spec.modelId, spec.effort, caps)
    }
  }

  /** The exact request body of the next step (used by tests). */
  nextRequest(): Anthropic.MessageStreamParams {
    return { ...this.params, messages: [...this.messages] }
  }

  async step(events: StepEvents, signal: AbortSignal): Promise<StepResult> {
    let text = ''
    let usage: StepResult['usage']
    for (let resumes = 0; ; resumes++) {
      let message: Anthropic.Message
      try {
        const stream = this.client.messages.stream(this.nextRequest(), { signal })
        let blockType: string | undefined
        for await (const event of stream) {
          if (event.type === 'content_block_start') {
            const block = event.content_block
            blockType = block.type
            if (block.type === 'thinking' || block.type === 'redacted_thinking') events.onThinking()
            else if (block.type === 'tool_use') events.onToolInputStart(block.name)
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              text += event.delta.text
              events.onTextDelta(event.delta.text)
            } else if (event.delta.type === 'thinking_delta') {
              events.onThinking()
            }
          } else if (event.type === 'content_block_stop') {
            if (blockType === 'text') events.onTextEnd()
            blockType = undefined
          }
        }
        message = await stream.finalMessage()
      } catch (err) {
        throw describeAnthropicError(err)
      }

      usage = {
        inputTokens:
          (usage?.inputTokens ?? 0) +
          message.usage.input_tokens +
          (message.usage.cache_read_input_tokens ?? 0) +
          (message.usage.cache_creation_input_tokens ?? 0),
        outputTokens: (usage?.outputTokens ?? 0) + message.usage.output_tokens
      }

      // A server-side loop paused: send the turn back unchanged and let it continue.
      if (message.stop_reason === 'pause_turn' && resumes < MAX_PAUSE_RESUMES) {
        this.messages.push({ role: 'assistant', content: message.content })
        continue
      }

      const { stop, detail } = mapStop(message)
      const toolCalls: ToolCallRequest[] = message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }))

      if (stop === 'tool_use' && toolCalls.length > 0) {
        // Echo the whole response (thinking, text, tool_use) before the results.
        this.messages.push({ role: 'assistant', content: message.content })
        return { stop, text, toolCalls, usage }
      }
      // Any other stop ends the turn; tool calls from a refused or truncated reply never run.
      return { stop: stop === 'tool_use' ? 'end' : stop, text, toolCalls: [], usage, ...(detail && { detail }) }
    }
  }

  addToolResults(results: { call: ToolCallRequest; result: ToolResult }[]): void {
    if (results.length === 0) return
    this.messages.push({ role: 'user', content: results.map(({ call, result }) => toolResultBlock(call, result)) })
  }
}

export function createAnthropicAdapter(deps: {
  client: AnthropicClientLike
  capabilities?: (modelId: string) => AnthropicModelCaps | undefined
}): ModelAdapter & { startTurn(spec: TurnSpec): AnthropicTurn } {
  return {
    startTurn(spec) {
      return new AnthropicTurn(deps.client, spec, deps.capabilities?.(spec.modelId))
    },

    async complete(request: CompleteRequest) {
      const settings = modelSettings(request.modelId, 'low', deps.capabilities?.(request.modelId))
      let message: Anthropic.Message
      try {
        message = await deps.client.messages.create(
          {
            model: request.modelId,
            system: request.system,
            messages: [{ role: 'user', content: request.prompt }],
            ...settings,
            max_tokens: Math.min(settings.max_tokens, request.maxTokens)
          },
          { signal: request.signal }
        )
      } catch (err) {
        throw describeAnthropicError(err)
      }
      if (message.stop_reason === 'refusal') throw new ProviderError('Claude declined this request.')
      return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()
    }
  }
}
