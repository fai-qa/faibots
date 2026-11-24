// What each provider kind is: which engine runs it, how it is billed, whether it needs a key.
// The UI shows the billing route next to every bot's model, so it must be right and never
// change on its own: we only ever use the key the user stored for that provider (never an
// environment variable), and subscription routes never receive an API key.

import type { BillingRoute, ProviderConfig, ProviderKind } from '@shared/domain'

export type EngineKind = 'native' | 'claude-code' | 'codex'

export interface ProviderKindInfo {
  kind: ProviderKind
  engine: EngineKind
  /** True when turns cannot run without a stored API key. */
  needsApiKey: boolean
  /** True when an API key may be stored at all. */
  acceptsApiKey: boolean
  /** Base URL used when the provider has none. */
  defaultBaseUrl?: string
  /** Model used when the bot's route and the provider leave it empty ('' = none, the user picks). */
  defaultModelId: string
}

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5'
/** Claude Code and Codex: let the tool use the model configured in its own settings. */
export const DEFAULT_MODEL_ALIAS = 'default'

export const PROVIDER_KINDS: Record<ProviderKind, ProviderKindInfo> = {
  anthropic: {
    kind: 'anthropic',
    engine: 'native',
    needsApiKey: true,
    acceptsApiKey: true,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModelId: DEFAULT_ANTHROPIC_MODEL
  },
  openai: {
    kind: 'openai',
    engine: 'native',
    needsApiKey: true,
    acceptsApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModelId: ''
  },
  google: {
    kind: 'google',
    engine: 'native',
    needsApiKey: true,
    acceptsApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModelId: ''
  },
  xai: {
    kind: 'xai',
    engine: 'native',
    needsApiKey: true,
    acceptsApiKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultModelId: ''
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    engine: 'native',
    needsApiKey: false,
    acceptsApiKey: true,
    defaultModelId: ''
  },
  'claude-code': {
    kind: 'claude-code',
    engine: 'claude-code',
    needsApiKey: false,
    acceptsApiKey: false,
    defaultModelId: DEFAULT_MODEL_ALIAS
  },
  codex: {
    kind: 'codex',
    engine: 'codex',
    needsApiKey: false,
    acceptsApiKey: true,
    defaultModelId: DEFAULT_MODEL_ALIAS
  }
}

export function kindInfo(kind: ProviderKind): ProviderKindInfo {
  const info = PROVIDER_KINDS[kind]
  if (!info) throw new Error(`Unknown provider kind "${kind}"`)
  return info
}

/** The base URL a provider talks to, without a trailing slash. */
export function baseUrlOf(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): string | undefined {
  const url = provider.baseUrl?.trim() || kindInfo(provider.kind).defaultBaseUrl
  return url?.replace(/\/+$/, '')
}

/** True for localhost, loopback and private-network addresses (an Ollama or LM Studio box). */
export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.includes(':')) {
    // IPv6: loopback, unique-local (fc00::/7) and link-local (fe80::/10).
    return host === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)
      || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)
  }
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/**
 * How a provider is billed, from its configuration alone. Claude Code's real route depends on how
 * the user signed in to Claude Code; ProviderService.test reports that one precisely.
 */
export function billingRoute(provider: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'hasApiKey'>): BillingRoute {
  switch (provider.kind) {
    case 'anthropic':
    case 'openai':
    case 'google':
    case 'xai':
      return 'api-key'
    case 'openai-compatible':
      if (isLocalUrl(provider.baseUrl)) return 'local'
      return provider.hasApiKey ? 'api-key' : 'unknown'
    case 'claude-code':
      return 'subscription'
    case 'codex':
      return provider.hasApiKey ? 'api-key' : 'subscription'
    default:
      return 'unknown'
  }
}

/** The model a route resolves to: the bot's choice, else the provider's default, else the kind's. */
export function resolveModelId(provider: Pick<ProviderConfig, 'kind' | 'defaultModelId'>, routeModelId: string): string {
  return routeModelId.trim() || provider.defaultModelId.trim() || kindInfo(provider.kind).defaultModelId
}
