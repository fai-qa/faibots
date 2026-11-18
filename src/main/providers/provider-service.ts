// ProviderService: model providers the user configured, their keys (write-only, kept in the
// secret vault), connection tests that report the billing route, and live model lists.
// The runtime also asks it to resolve a bot's ModelRoute and to build model adapters.

import { tmpdir } from 'node:os'
import type { ModelInfo, ModelRoute, ProviderConfig } from '@shared/domain'
import type { ProviderTestResult, SaveProviderRequest } from '@shared/ipc'
import type { EventBus, ProviderService, SecretVault, Store } from '../contracts'
import { createAiSdkAdapter, languageModelFactory, type AiSdkKind, type LanguageModelFactory } from './ai-sdk'
import { createAnthropicAdapter, createAnthropicClient, describeAnthropicError, type AnthropicClientLike } from './anthropic'
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_MODEL_ALIAS, baseUrlOf, billingRoute, kindInfo, resolveModelId, type EngineKind } from './catalog'
import { probeClaudeCode, probeCodex, type ClaudeCodeStatus, type CodexStatus } from './external'
import {
  CODEX_MODELS,
  LIST_TIMEOUT_MS,
  claudeCodeModelList,
  listAnthropicModels,
  listGoogleModels,
  listOpenAiStyleModels,
  modelsUrlBase,
  type AnthropicModelsClient,
  type ListedModel
} from './models'
import { ProviderError, type ModelAdapter } from './types'

const MODEL_CACHE_MS = 10 * 60_000

export interface ResolvedRoute {
  provider: ProviderConfig
  modelId: string
  effort?: ModelRoute['effort']
  engine: EngineKind
}

/** What the runtime needs on top of the IPC-facing ProviderService. */
export interface RuntimeProviders extends ProviderService {
  /** The provider and model behind a bot's route. Throws a ProviderError the user can act on. */
  resolve(route: ModelRoute): ResolvedRoute
  /** A native-engine adapter (anthropic, openai, google, xai, openai-compatible). */
  adapterFor(provider: ProviderConfig): ModelAdapter
  /** Listed details of one model (context window…), from a cached list; undefined when unknown. */
  modelInfo(providerId: string, modelId: string): Promise<ListedModel | undefined>
  /** The stored key of a provider (main process only; never sent to the renderer or logged). */
  apiKey(providerId: string): string | undefined
}

export interface ProviderServiceDeps {
  store: Pick<Store, 'providers'>
  secrets: Pick<SecretVault, 'getProviderKey' | 'setProviderKey'>
  bus: EventBus
  fetch?: typeof fetch
  anthropicClient?: (opts: { apiKey: string; baseUrl?: string }) => AnthropicClientLike & AnthropicModelsClient
  languageModel?: (opts: { kind: AiSdkKind; apiKey?: string; baseUrl: string }) => LanguageModelFactory
  probes?: {
    claudeCode(): Promise<ClaudeCodeStatus>
    codex(hasStoredKey: boolean): Promise<CodexStatus>
  }
}

const strip = (m: ListedModel): ModelInfo => {
  const { anthropic: _caps, ...info } = m
  return info
}

export function createProviderService(deps: ProviderServiceDeps): RuntimeProviders {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const makeAnthropic = deps.anthropicClient ?? createAnthropicClient
  const makeLanguageModel = deps.languageModel ?? languageModelFactory
  const probes = deps.probes ?? {
    claudeCode: () => probeClaudeCode({ cwd: tmpdir() }),
    codex: (hasStoredKey: boolean) => probeCodex({ hasStoredKey })
  }
  const cache = new Map<string, { at: number; models: ListedModel[] }>()

  const changed = () => deps.bus.emit('providers:changed', { at: Date.now() })

  const getProvider = (id: string): ProviderConfig => {
    const provider = deps.store.providers.get(id)
    if (!provider) throw new ProviderError('That model provider no longer exists.')
    return provider
  }

  const keyOf = (provider: ProviderConfig): string | undefined => {
    if (!provider.hasApiKey) return undefined
    return deps.secrets.getProviderKey(provider.id) || undefined
  }

  const requireKey = (provider: ProviderConfig): string => {
    const key = keyOf(provider)
    if (!key) throw new ProviderError(`${provider.label} has no API key. Add one in Settings → Models.`)
    return key
  }

  const anthropicClientFor = (provider: ProviderConfig) =>
    makeAnthropic({ apiKey: requireKey(provider), baseUrl: baseUrlOf(provider) })

  /** Fetch the provider's own model list (no caching). */
  const fetchModels = async (provider: ProviderConfig): Promise<ListedModel[]> => {
    const signal = AbortSignal.timeout(LIST_TIMEOUT_MS)
    switch (provider.kind) {
      case 'anthropic':
        try {
          return await listAnthropicModels(anthropicClientFor(provider), signal)
        } catch (err) {
          throw describeAnthropicError(err)
        }
      case 'openai':
      case 'xai':
        return listOpenAiStyleModels({
          fetch: fetchImpl,
          baseUrl: modelsUrlBase(provider),
          apiKey: requireKey(provider),
          filterChat: provider.kind === 'openai',
          signal
        })
      case 'openai-compatible':
        return listOpenAiStyleModels({ fetch: fetchImpl, baseUrl: modelsUrlBase(provider), apiKey: keyOf(provider), filterChat: false, signal })
      case 'google':
        return listGoogleModels({ fetch: fetchImpl, baseUrl: modelsUrlBase(provider), apiKey: requireKey(provider), signal })
      case 'claude-code': {
        const status = await probes.claudeCode()
        if (!status.ok && status.models.length === 0) throw new ProviderError(status.message)
        return claudeCodeModelList(status.models)
      }
      case 'codex':
        return CODEX_MODELS
    }
  }

  const cachedModels = async (provider: ProviderConfig): Promise<ListedModel[]> => {
    const hit = cache.get(provider.id)
    if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.models
    const models = await fetchModels(provider)
    cache.set(provider.id, { at: Date.now(), models })
    return models
  }

  const capabilitiesFor = (providerId: string) => (modelId: string) =>
    cache.get(providerId)?.models.find((m) => m.id === modelId)?.anthropic

  const service: RuntimeProviders = {
    list: () => deps.store.providers.list(),

    save(req: SaveProviderRequest) {
      const info = kindInfo(req.kind)
      const existing = req.id ? deps.store.providers.get(req.id) : undefined
      const newKey = req.apiKey === undefined ? undefined : req.apiKey.trim()
      if (newKey && !info.acceptsApiKey) {
        throw new Error('Claude Code uses your own Claude Code login. It does not take an API key.')
      }
      const defaultModelId =
        req.defaultModelId.trim() ||
        (req.kind === 'anthropic' ? DEFAULT_ANTHROPIC_MODEL : req.kind === 'claude-code' || req.kind === 'codex' ? DEFAULT_MODEL_ALIAS : '')
      const { apiKey: _plaintext, ...rest } = req
      const base = { ...rest, defaultModelId }

      let saved = deps.store.providers.save({ ...base, hasApiKey: newKey === undefined ? (existing?.hasApiKey ?? false) : false })
      if (newKey !== undefined) {
        deps.secrets.setProviderKey(saved.id, newKey || null)
        if (newKey) saved = deps.store.providers.save({ ...base, id: saved.id, hasApiKey: true })
      }
      cache.delete(saved.id)
      changed()
      return saved
    },

    delete(id) {
      deps.secrets.setProviderKey(id, null)
      deps.store.providers.delete(id)
      cache.delete(id)
      changed()
    },

    async test(id): Promise<ProviderTestResult> {
      let provider: ProviderConfig
      try {
        provider = getProvider(id)
      } catch (err) {
        return { ok: false, message: (err as Error).message, billing: 'unknown' }
      }
      const billing = billingRoute(provider)
      if (provider.kind === 'claude-code') {
        const status = await probes.claudeCode()
        if (status.models.length) cache.set(provider.id, { at: Date.now(), models: claudeCodeModelList(status.models) })
        return { ok: status.ok, message: status.message, billing: status.ok ? status.billing : 'unknown' }
      }
      if (provider.kind === 'codex') {
        const status = await probes.codex(!!keyOf(provider))
        return { ok: status.ok, message: status.message, billing: status.ok ? status.billing : billing }
      }
      if (kindInfo(provider.kind).needsApiKey && !keyOf(provider)) {
        return { ok: false, message: 'Add an API key first.', billing }
      }
      try {
        const models = await fetchModels(provider)
        cache.set(provider.id, { at: Date.now(), models })
        const where = billing === 'local' ? 'Runs on your own machine or network.' : billing === 'api-key' ? 'Billed per token to this API key.' : ''
        return { ok: true, message: `Connected. ${models.length} model${models.length === 1 ? '' : 's'} available. ${where}`.trim(), billing }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err), billing }
      }
    },

    async models(id) {
      const provider = getProvider(id)
      return (await cachedModels(provider)).map(strip)
    },

    resolve(route) {
      if (!route.providerId) throw new ProviderError('This bot has no model yet. Pick one in its Profile.')
      const provider = deps.store.providers.get(route.providerId)
      if (!provider) throw new ProviderError("This bot's model provider was removed. Pick another model in its Profile.")
      if (!provider.enabled) throw new ProviderError(`${provider.label} is turned off in Settings → Models.`)
      const info = kindInfo(provider.kind)
      const modelId = resolveModelId(provider, route.modelId)
      if (!modelId) throw new ProviderError(`Choose a model for ${provider.label} (in the bot's Profile or the provider's settings).`)
      if (info.needsApiKey && !keyOf(provider)) throw new ProviderError(`${provider.label} has no API key. Add one in Settings → Models.`)
      return { provider, modelId, ...(route.effort && { effort: route.effort }), engine: info.engine }
    },

    adapterFor(provider) {
      switch (provider.kind) {
        case 'anthropic':
          return createAnthropicAdapter({ client: anthropicClientFor(provider), capabilities: capabilitiesFor(provider.id) })
        case 'openai':
        case 'google':
        case 'xai':
        case 'openai-compatible': {
          const kind = provider.kind
          const apiKey = kind === 'openai-compatible' ? keyOf(provider) : requireKey(provider)
          return createAiSdkAdapter({ kind, languageModel: makeLanguageModel({ kind, apiKey, baseUrl: modelsUrlBase(provider) }) })
        }
        default:
          throw new ProviderError(`${provider.label} runs its own agent; it has no native model adapter.`)
      }
    },

    async modelInfo(providerId, modelId) {
      const provider = deps.store.providers.get(providerId)
      if (!provider || provider.kind === 'claude-code' || provider.kind === 'codex') return undefined
      try {
        return (await cachedModels(provider)).find((m) => m.id === modelId)
      } catch (err) {
        console.warn(`[providers] could not list models of ${provider.label}:`, err instanceof Error ? err.message : String(err))
        // Remember the failure briefly so every turn does not wait on a dead endpoint.
        cache.set(provider.id, { at: Date.now() - MODEL_CACHE_MS + 60_000, models: [] })
        return undefined
      }
    },

    apiKey(providerId) {
      const provider = deps.store.providers.get(providerId)
      return provider ? keyOf(provider) : undefined
    }
  }
  return service
}
