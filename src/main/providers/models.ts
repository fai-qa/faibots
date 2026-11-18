// Live model lists. Every list comes from the provider itself; we never make up model ids.
// Claude Code and Codex pick their own model when a bot leaves it on "default".

import type { ModelInfo, ProviderConfig } from '@shared/domain'
import type Anthropic from '@anthropic-ai/sdk'
import { DEFAULT_MODEL_ALIAS, baseUrlOf } from './catalog'
import type { AnthropicModelCaps } from './anthropic'
import { ProviderError } from './types'

export const LIST_TIMEOUT_MS = 15_000

/** The slice of the Anthropic client used to list models. */
export interface AnthropicModelsClient {
  models: { list(params?: { limit?: number }, options?: { signal?: AbortSignal }): AsyncIterable<Anthropic.ModelInfo> }
}

/** A listed model plus provider details the runtime uses (context window, Claude capabilities). */
export interface ListedModel extends ModelInfo {
  anthropic?: AnthropicModelCaps
}

const EFFORT_KEYS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export async function listAnthropicModels(client: AnthropicModelsClient, signal: AbortSignal): Promise<ListedModel[]> {
  const out: ListedModel[] = []
  for await (const m of client.models.list({ limit: 100 }, { signal })) {
    if (m.lifecycle === 'retired') continue
    const caps = m.capabilities
    const effortLevels = caps?.effort?.supported
      ? EFFORT_KEYS.filter((level) => caps.effort[level]?.supported)
      : caps
        ? []
        : undefined
    out.push({
      id: m.id,
      label: m.display_name || m.id,
      ...(m.max_input_tokens && { contextWindow: m.max_input_tokens }),
      supportsTools: true,
      ...(caps && { supportsImages: caps.image_input.supported }),
      anthropic: {
        ...(caps && { adaptiveThinking: caps.thinking.supported && caps.thinking.types.adaptive.supported }),
        ...(effortLevels && { effortLevels }),
        ...(m.max_tokens && { maxOutputTokens: m.max_tokens })
      }
    })
  }
  return out
}

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal })
  } catch (err) {
    if (signal.aborted) throw new ProviderError('The provider did not answer in time.')
    throw new ProviderError(`Could not reach ${new URL(url).host}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300).replace(/\s+/g, ' ').trim()
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError(`The API key was rejected (${res.status}).${body ? ` ${body}` : ''}`)
    }
    throw new ProviderError(`${new URL(url).host} answered ${res.status}.${body ? ` ${body}` : ''}`)
  }
  try {
    return await res.json()
  } catch {
    throw new ProviderError(`${new URL(url).host} did not return JSON. Is the base URL right (it usually ends in /v1)?`)
  }
}

/** Embedding, speech, image and moderation models in OpenAI's list cannot chat. */
const NOT_CHAT = /(embed|tts|whisper|transcribe|dall-e|gpt-image|moderation|davinci|babbage|realtime|audio|sora|computer-use)/i

/** GET {base}/models, the OpenAI shape (OpenAI, xAI, Ollama, LM Studio, OpenRouter, vLLM…). */
export async function listOpenAiStyleModels(opts: {
  fetch: typeof fetch
  baseUrl: string
  apiKey?: string
  filterChat: boolean
  signal: AbortSignal
}): Promise<ListedModel[]> {
  const json = (await getJson(
    opts.fetch,
    `${opts.baseUrl}/models`,
    opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
    opts.signal
  )) as { data?: Array<{ id?: unknown; context_length?: unknown; context_window?: unknown; name?: unknown }> }
  const rows = Array.isArray(json.data) ? json.data : []
  return rows
    .filter((r): r is typeof r & { id: string } => typeof r.id === 'string' && r.id.length > 0)
    .filter((r) => !opts.filterChat || !NOT_CHAT.test(r.id))
    .map((r) => {
      const window = typeof r.context_length === 'number' ? r.context_length : typeof r.context_window === 'number' ? r.context_window : undefined
      return {
        id: r.id,
        label: typeof r.name === 'string' && r.name ? r.name : r.id,
        ...(window && { contextWindow: window }),
        supportsTools: true
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Gemini: GET {base}/models, keeping models that can generate content. */
export async function listGoogleModels(opts: { fetch: typeof fetch; baseUrl: string; apiKey: string; signal: AbortSignal }): Promise<ListedModel[]> {
  const out: ListedModel[] = []
  let pageToken = ''
  for (let page = 0; page < 10; page++) {
    const url = `${opts.baseUrl}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const json = (await getJson(opts.fetch, url, { 'x-goog-api-key': opts.apiKey }, opts.signal)) as {
      models?: Array<{ name?: string; displayName?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }>
      nextPageToken?: string
    }
    for (const m of json.models ?? []) {
      if (!m.name || !m.supportedGenerationMethods?.includes('generateContent')) continue
      const id = m.name.replace(/^models\//, '')
      if (NOT_CHAT.test(id)) continue
      out.push({ id, label: m.displayName || id, ...(m.inputTokenLimit && { contextWindow: m.inputTokenLimit }), supportsTools: true })
    }
    if (!json.nextPageToken) break
    pageToken = json.nextPageToken
  }
  return out
}

/** Claude Code's own list (its aliases and models), with "default" first. */
export function claudeCodeModelList(models: Array<{ value: string; displayName: string }>): ModelInfo[] {
  const out: ModelInfo[] = [{ id: DEFAULT_MODEL_ALIAS, label: 'Default (Claude Code decides)', supportsTools: true }]
  for (const m of models) {
    if (!m.value || m.value === DEFAULT_MODEL_ALIAS) continue
    out.push({ id: m.value, label: m.displayName || m.value, supportsTools: true })
  }
  return out
}

/** Codex has no model list API: "default" uses the model in the user's Codex config. */
export const CODEX_MODELS: ModelInfo[] = [
  { id: DEFAULT_MODEL_ALIAS, label: 'Default (from your Codex settings)', supportsTools: true }
]

export function modelsUrlBase(provider: ProviderConfig): string {
  const base = baseUrlOf(provider)
  if (!base) throw new ProviderError('This provider needs a base URL, e.g. http://localhost:11434/v1')
  return base
}
