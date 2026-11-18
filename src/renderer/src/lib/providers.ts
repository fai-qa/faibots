// Provider kinds, their labels and the billing route each one uses.

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

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.local')
  } catch {
    return false
  }
}

/** What a provider route costs. A test result, when we have one, wins over the guess. */
export function billingFor(p: ProviderConfig | undefined, tested?: BillingRoute): BillingRoute {
  if (tested && tested !== 'unknown') return tested
  if (!p) return 'unknown'
  switch (p.kind) {
    case 'claude-code':
    case 'codex':
      return 'subscription'
    case 'openai-compatible':
      return isLocalUrl(p.baseUrl) ? 'local' : 'api-key'
    default:
      return 'api-key'
  }
}

export const BILLING_LABELS: Record<BillingRoute, { label: string; hint: string }> = {
  subscription: { label: 'Subscription', hint: 'Spends your plan allowance, no per-token bill' },
  'api-key': { label: 'API key', hint: 'Billed per token to your API account' },
  local: { label: 'Local', hint: 'Runs on your own machine' },
  unknown: { label: 'Unknown', hint: 'Test the provider to find out how it is billed' }
}

export function routeLabel(route: ModelRoute | null | undefined, providers: ProviderConfig[]): string {
  if (!route || !route.providerId) return 'No model'
  const p = providers.find((x) => x.id === route.providerId)
  if (!p) return 'Missing provider'
  const model = route.modelId || p.defaultModelId || 'default model'
  return `${model} via ${p.label}`
}
