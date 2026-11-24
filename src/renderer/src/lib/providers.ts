// Provider kinds, their labels and the billing route each one uses.

import { billingRoute, kindInfo as providerKind, resolveModelId } from '@shared/provider-catalog'
import type { BillingRoute, ModelRoute, ProviderConfig, ProviderKind } from '@shared/domain'

export interface ProviderKindInfo {
  kind: ProviderKind
  label: string
  description: string
  needsKey: boolean
  needsBaseUrl: boolean
  supportsEffort: boolean
  defaultLabel: string
  defaultModel: string
  baseUrlPlaceholder?: string
}

export const PROVIDER_KINDS: ProviderKindInfo[] = [
  {
    kind: 'anthropic',
    label: 'Anthropic API',
    description: 'Claude models with your Anthropic API key. Billed per token.',
    needsKey: true,
    needsBaseUrl: false,
    supportsEffort: true,
    defaultLabel: 'Anthropic',
    defaultModel: 'claude-opus-5-5'
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    description: 'Uses the Claude Code login on this computer, so it spends your Claude subscription.',
    needsKey: false,
    needsBaseUrl: false,
    supportsEffort: true,
    defaultLabel: 'Claude Code',
    defaultModel: 'default'
  },
  {
    kind: 'openai',
    label: 'OpenAI API',
    description: 'GPT models with your OpenAI API key. Billed per token.',
    needsKey: true,
    needsBaseUrl: false,
    supportsEffort: true,
    defaultLabel: 'OpenAI',
    defaultModel: ''
  },
  {
    kind: 'codex',
    label: 'Codex',
    description: 'Uses your `codex login` (ChatGPT plan) or a Codex API key.',
    needsKey: false,
    needsBaseUrl: false,
    supportsEffort: true,
    defaultLabel: 'Codex',
    defaultModel: ''
  },
  {
    kind: 'google',
    label: 'Google Gemini',
    description: 'Gemini models with a Google AI Studio API key.',
    needsKey: true,
    needsBaseUrl: false,
    supportsEffort: false,
    defaultLabel: 'Gemini',
    defaultModel: ''
  },
  {
    kind: 'xai',
    label: 'xAI',
    description: 'Grok models with an xAI API key.',
    needsKey: true,
    needsBaseUrl: false,
    supportsEffort: false,
    defaultLabel: 'xAI',
    defaultModel: ''
  },
  {
    kind: 'openai-compatible',
    label: 'Ollama / OpenAI-compatible',
    description: 'Local models with Ollama or LM Studio, or any server with an OpenAI-style API (OpenRouter, vLLM…).',
    needsKey: false,
    needsBaseUrl: true,
    supportsEffort: false,
    defaultLabel: 'Local models',
    defaultModel: '',
    baseUrlPlaceholder: 'http://localhost:11434/v1'
  }
]

export function kindInfo(kind: ProviderKind): ProviderKindInfo {
  return PROVIDER_KINDS.find((k) => k.kind === kind) ?? PROVIDER_KINDS[0]!
}

/** What a provider route costs. Prefer a test of the current configuration when available. */
export function billingFor(p: Pick<ProviderConfig, 'kind' | 'baseUrl' | 'hasApiKey'> | undefined, tested?: BillingRoute): BillingRoute {
  if (tested && tested !== 'unknown') return tested
  return p ? billingRoute(p) : 'unknown'
}

export const BILLING_LABELS: Record<BillingRoute, { label: string; hint: string }> = {
  subscription: { label: 'Subscription', hint: 'Spends your plan allowance, no per-token bill' },
  'api-key': { label: 'API key', hint: 'Billed per token to your API account' },
  local: { label: 'Local', hint: 'Runs on your own machine' },
  unknown: { label: 'Unknown', hint: 'Test the provider to find out how it is billed' }
}

export interface ModelSetupIssue {
  message: string
  action: string
  target: 'profile' | 'providers'
}

/** Check configuration only. The provider's live connection is tested separately. */
export function modelSetupIssue(route: ModelRoute | null | undefined, providers: ProviderConfig[]): ModelSetupIssue | undefined {
  const provider = providers.find((item) => item.id === route?.providerId)
  if (!provider) {
    if (providers.length === 0) return { message: 'Add a model provider to get started.', action: 'Open provider settings', target: 'providers' }
    if (!providers.some((item) => item.enabled)) return { message: 'All model providers are off.', action: 'Manage providers', target: 'providers' }
    return { message: 'Choose a provider for this bot.', action: 'Choose provider', target: 'profile' }
  }
  if (!provider.enabled) return { message: `${provider.label} is turned off.`, action: 'Manage providers', target: 'providers' }
  if (providerKind(provider.kind).needsApiKey && !provider.hasApiKey) {
    return { message: `${provider.label} needs an API key.`, action: 'Manage providers', target: 'providers' }
  }
  if (!resolveModelId(provider, route?.modelId ?? '')) return { message: 'Choose a model for this bot.', action: 'Choose model', target: 'profile' }
}

export function routeLabel(route: ModelRoute | null | undefined, providers: ProviderConfig[]): string {
  if (!route || !route.providerId) return 'No model'
  const p = providers.find((x) => x.id === route.providerId)
  if (!p) return 'Missing provider'
  const model = route.modelId || p.defaultModelId || 'default model'
  return `${model} via ${p.label}`
}
