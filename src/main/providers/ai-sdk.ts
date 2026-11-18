// Native-engine adapter for OpenAI, Gemini, xAI and any OpenAI-compatible server (Ollama,
// LM Studio, OpenRouter, vLLM…), on the Vercel AI SDK v7.
//
// We call streamText for exactly one model step at a time and give it tools without `execute`,
// so the SDK never runs a tool itself: the native engine runs every call through FaiBots's
// ToolRegistry (permissions, approval cards, redaction) and hands the results back here. Within a
// turn the SDK's own response messages are kept as they are, so provider-specific parts such as
// OpenAI reasoning items or Gemini thought signatures go back unchanged.

import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createXai } from '@ai-sdk/xai'
import {
  APICallError,
  generateText,
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
  type UserModelMessage
} from 'ai'
import type { ProviderKind } from '@shared/domain'
import type { ToolResult } from '../contracts'
import {
  ProviderError,
  type ChatMessage,
  type CompleteRequest,
  type ModelAdapter,
  type ModelTurn,
  type StepEvents,
  type StepResult,
  type ToolCallRequest,
  type TurnSpec
} from './types'

export type AiSdkKind = Extract<ProviderKind, 'openai' | 'google' | 'xai' | 'openai-compatible'>

/** Creates the AI SDK language model for a model id. Tests pass a MockLanguageModelV4 factory. */
export type LanguageModelFactory = (modelId: string) => LanguageModel

const PROVIDER_NAMES: Record<AiSdkKind, string> = {
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  'openai-compatible': 'The model server'
}

/**
 * The provider factory for a kind. The key and base URL are always passed explicitly, so the
 * SDKs never fall back to OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / XAI_API_KEY from the
 * environment (that would be a silent switch of billing route).
 */
export function languageModelFactory(opts: { kind: AiSdkKind; apiKey?: string; baseUrl: string; label?: string }): LanguageModelFactory {
  const apiKey = opts.apiKey ?? ''
  switch (opts.kind) {
    case 'openai': {
      const provider = createOpenAI({ apiKey, baseURL: opts.baseUrl })
      return (modelId) => provider.responses(modelId)
    }
    case 'google': {
      const provider = createGoogle({ apiKey, baseURL: opts.baseUrl })
      return (modelId) => provider(modelId)
    }
    case 'xai': {
      const provider = createXai({ apiKey, baseURL: opts.baseUrl })
      return (modelId) => provider(modelId)
    }
    case 'openai-compatible': {
      const provider = createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: opts.baseUrl,
        ...(opts.apiKey && { apiKey: opts.apiKey }),
        includeUsage: true
      })
      return (modelId) => provider.chatModel(modelId)
    }
  }
}

function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const out: ModelMessage[] = messages.map((m): ModelMessage => {
    if (m.role === 'assistant') return { role: 'assistant', content: m.text }
    const content: Exclude<UserModelMessage['content'], string> = []
    for (const part of m.content) {
      if (part.type === 'text') {
        if (part.text) content.push({ type: 'text', text: part.text })
      } else {
        content.push({ type: 'file', mediaType: part.mediaType, data: { type: 'data', data: part.dataBase64 } })
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '(empty message)' })
    return { role: 'user', content }
  })
  if (out.length === 0 || out[out.length - 1]!.role === 'assistant') {
    out.push({ role: 'user', content: '(No new messages.)' })
  }
  return out
}

function toolResultPart(call: ToolCallRequest, result: ToolResult): ToolResultPart {
  const text = result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  const images = result.content.filter((b) => b.type === 'image')
  let output: ToolResultPart['output']
  if (result.isError) {
    output = { type: 'error-text', value: text || 'Error.' }
  } else if (images.length > 0) {
    output = {
      type: 'content',
      value: [
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...images.map((img) => ({
          type: 'file' as const,
          mediaType: img.mediaType,
          data: { type: 'data' as const, data: img.dataBase64 }
        }))
      ]
    }
  } else {
    output = { type: 'text', value: text || '(no output)' }
  }
  return { type: 'tool-result', toolCallId: call.id, toolName: call.name, output }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** Short, safe error messages (status and the provider's own words; never request headers). */
export function describeAiSdkError(err: unknown, kind: AiSdkKind): Error {
  if (err instanceof Error && err.name === 'AbortError') return err
  const who = PROVIDER_NAMES[kind]
  if (APICallError.isInstance(err)) {
    const status = err.statusCode
    if (status === 401) return new ProviderError(`${who} rejected the API key (401). Check it in Settings → Models.`)
    if (status === 403) return new ProviderError(`${who} refused access (403): ${err.message}`)
    if (status === 404) return new ProviderError(`${who} does not know this model or endpoint (404): ${err.message}`)
    if (status === 429) return new ProviderError(`${who} rate limit reached (429). Try again in a moment.`, true)
    return new ProviderError(`${who} returned an error${status ? ` (${status})` : ''}: ${err.message}`, err.isRetryable)
  }
  return new ProviderError(`${who} returned an error: ${errorText(err)}`)
}

class AiSdkTurn implements ModelTurn {
  private readonly messages: ModelMessage[]
  private readonly tools: ToolSet
  private readonly instructions: string

  constructor(
    private readonly model: LanguageModel,
    private readonly kind: AiSdkKind,
    private readonly spec: TurnSpec
  ) {
    this.messages = toModelMessages(spec.messages)
    this.tools = Object.fromEntries(
      spec.tools.map((t) => [t.name, tool({ description: t.description, inputSchema: jsonSchema({ ...t.inputSchema, type: 'object' }) })])
    )
    this.instructions = [spec.system.stable, spec.system.volatile].filter((s) => s.trim()).join('\n\n')
  }

  async step(events: StepEvents, signal: AbortSignal): Promise<StepResult> {
    let text = ''
    const toolCalls: ToolCallRequest[] = []
    let streamError: unknown
    let finishReason: string | undefined
    let usage: StepResult['usage']

    try {
      const result = streamText({
        model: this.model,
        instructions: this.instructions,
        messages: [...this.messages],
        ...(Object.keys(this.tools).length > 0 && { tools: this.tools }),
        ...(this.spec.effort && { reasoning: this.spec.effort }),
        abortSignal: signal,
        maxRetries: 2
      })
      for await (const part of result.stream) {
        switch (part.type) {
          case 'text-delta':
            text += part.text
            events.onTextDelta(part.text)
            break
          case 'text-end':
            events.onTextEnd()
            break
          case 'reasoning-start':
          case 'reasoning-delta':
            events.onThinking()
            break
          case 'tool-input-start':
            events.onToolInputStart(part.toolName)
            break
          case 'tool-call':
            toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              input: part.input,
              ...(part.dynamic && part.invalid && { inputError: errorText(part.error) || 'Invalid tool call.' })
            })
            break
          case 'finish-step':
            finishReason = part.finishReason
            usage = { inputTokens: part.usage.inputTokens, outputTokens: part.usage.outputTokens }
            break
          case 'error':
            streamError = part.error
            break
          default:
            break
        }
      }
      if (streamError !== undefined) throw streamError
      this.messages.push(...(await result.responseMessages))
    } catch (err) {
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Cancelled')
      throw describeAiSdkError(err, this.kind)
    }

    if (toolCalls.length > 0 && finishReason !== 'length' && finishReason !== 'content-filter') {
      return { stop: 'tool_use', text, toolCalls, usage }
    }
    switch (finishReason) {
      case 'length':
        return { stop: 'max_tokens', text, toolCalls: [], usage }
      case 'content-filter':
        return { stop: 'refusal', text, toolCalls: [], usage, detail: 'content filter' }
      default:
        return { stop: 'end', text, toolCalls: [], usage }
    }
  }

  addToolResults(results: { call: ToolCallRequest; result: ToolResult }[]): void {
    if (results.length === 0) return
    this.messages.push({ role: 'tool', content: results.map(({ call, result }) => toolResultPart(call, result)) })
  }
}

export function createAiSdkAdapter(deps: { kind: AiSdkKind; languageModel: LanguageModelFactory }): ModelAdapter {
  return {
    startTurn(spec) {
      return new AiSdkTurn(deps.languageModel(spec.modelId), deps.kind, spec)
    },

    async complete(request: CompleteRequest) {
      try {
        const result = await generateText({
          model: deps.languageModel(request.modelId),
          instructions: request.system,
          prompt: request.prompt,
          maxOutputTokens: request.maxTokens,
          abortSignal: request.signal,
          maxRetries: 2
        })
        return result.text.trim()
      } catch (err) {
        if (request.signal.aborted) throw err
        throw describeAiSdkError(err, deps.kind)
      }
    }
  }
}
