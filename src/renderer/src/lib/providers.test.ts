import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@shared/domain'
import { billingFor, modelSetupIssue } from './providers'

const provider: ProviderConfig = {
  id: 'local',
  kind: 'openai-compatible',
  label: 'Local model',
  defaultModelId: '',
  enabled: true,
  hasApiKey: false,
  createdAt: 0,
  updatedAt: 0
}
const route = { providerId: provider.id, modelId: '' }

describe('chat and routine model setup', () => {
  it('points a fresh profile or disabled provider to Settings', () => {
    expect(modelSetupIssue(route, [])?.target).toBe('providers')
    expect(modelSetupIssue(route, [{ ...provider, enabled: false }])?.target).toBe('providers')
    expect(modelSetupIssue({ ...route, providerId: '' }, [{ ...provider, enabled: false }])?.target).toBe('providers')
  })

  it('asks for a replacement when a bot points to a removed provider', () => {
    expect(modelSetupIssue({ ...route, providerId: 'removed' }, [provider])?.action).toBe('Choose provider')
  })

  it.each([null, undefined])('shows setup guidance for a missing model route (%s)', (missingRoute) => {
    expect(modelSetupIssue(missingRoute, [provider])?.action).toBe('Choose provider')
    expect(modelSetupIssue(missingRoute, [])?.target).toBe('providers')
  })

  it('accepts the explicit route or the provider default, including a keyless local server', () => {
    expect(modelSetupIssue({ ...route, modelId: 'my-model' }, [provider])).toBeUndefined()
    expect(modelSetupIssue({ ...route, modelId: '  ' }, [{ ...provider, defaultModelId: 'my-model' }])).toBeUndefined()
    expect(modelSetupIssue(route, [provider])?.action).toBe('Choose model')
  })

  it.each(['claude-code', 'codex'] as const)('allows the implicit %s model without an API key', (kind) => {
    expect(modelSetupIssue(route, [{ ...provider, kind }])).toBeUndefined()
  })

  it.each(['anthropic', 'openai', 'google', 'xai'] as const)('requires a stored key for %s', (kind) => {
    const config = { ...provider, kind, defaultModelId: 'my-model' }
    expect(modelSetupIssue(route, [config])?.target).toBe('providers')
    expect(modelSetupIssue(route, [{ ...config, hasApiKey: true }])).toBeUndefined()
  })

  it('accepts the built-in Anthropic model for a keyed account', () => {
    expect(modelSetupIssue(route, [{ ...provider, kind: 'anthropic', hasApiKey: true }])).toBeUndefined()
  })
})

describe('billing badges', () => {
  it('uses the same inferred route as the engine for Codex', () => {
    const codex = { ...provider, kind: 'codex' as const }
    expect(billingFor(codex)).toBe('subscription')
    expect(billingFor({ ...codex, hasApiKey: true })).toBe('api-key')
    expect(billingFor(codex, 'api-key')).toBe('api-key')
  })

  it.each(['127.0.0.1', '192.168.1.20', '10.0.0.8', '172.31.2.4', '169.254.2.4'])('recognizes a mapped local address (%s)', (host) => {
    expect(billingFor({ ...provider, baseUrl: `http://[::ffff:${host}]:11434/v1` })).toBe('local')
  })

  it('does not label mapped remote endpoints as local', () => {
    expect(billingFor({ ...provider, baseUrl: 'http://[::ffff:8.8.8.8]/v1' })).toBe('unknown')
    expect(billingFor({ ...provider, baseUrl: 'http://[::ffff:172.32.0.1]/v1', hasApiKey: true })).toBe('api-key')
  })
})
