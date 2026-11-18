import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SaveProviderRequest } from '@shared/ipc'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { fakeSecrets } from '../agent/testing/fakes'
import { billingRoute, isLocalUrl, resolveModelId } from './catalog'
import { claudeCodeBilling, parseCodexLoginStatus, unpackedPath, withPathDirs } from './external'
import { createProviderService, type ProviderServiceDeps } from './provider-service'

describe('ProviderService', () => {
  let store: PlatformStore
  let secrets: ReturnType<typeof fakeSecrets>
  let bus: ReturnType<typeof fakeBus>
  let fetches: string[]
  let headers: Record<string, string>[]
  let responses: Record<string, { status: number; body: unknown }>

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    fetches.push(url)
    headers.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)))
    const match = Object.entries(responses).find(([prefix]) => url.startsWith(prefix))
    if (!match) throw new Error(`connect ECONNREFUSED ${url}`)
    return new Response(JSON.stringify(match[1].body), { status: match[1].status, headers: { 'content-type': 'application/json' } })
  }

  const anthropicModels: Partial<Anthropic.ModelInfo>[] = [
    {
      id: 'claude-opus-5-5',
      display_name: 'Claude Opus 5.5',
      lifecycle: 'active',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: {
        image_input: { supported: true },
        thinking: { supported: true, types: { adaptive: { supported: true } } },
        effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } }
      } as never
    },
    { id: 'claude-2', display_name: 'Old', lifecycle: 'retired', capabilities: null }
  ]

  const make = (over: Partial<ProviderServiceDeps> = {}) =>
    createProviderService({
      store,
      secrets,
      bus,
      fetch: fakeFetch,
      anthropicClient: () =>
        ({
          messages: { stream: () => { throw new Error('unused') }, create: async () => { throw new Error('unused') } },
          models: {
            list: async function* () {
              for (const m of anthropicModels) yield m as Anthropic.ModelInfo
            }
          }
        }) as never,
      probes: {
        claudeCode: async () => ({ ok: true, billing: 'subscription', message: 'Claude Code is signed in and uses your max subscription.', models: [{ value: 'opus', displayName: 'Opus', description: '' }] as never }),
        codex: async (hasKey) => parseCodexLoginStatus(0, 'Logged in using ChatGPT', hasKey)
      },
      ...over
    })

  const save = (service: ReturnType<typeof make>, req: Partial<SaveProviderRequest> & Pick<SaveProviderRequest, 'kind'>) =>
    service.save({ label: req.kind, defaultModelId: '', enabled: true, ...req })

  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/home/test' })
    secrets = fakeSecrets()
    bus = fakeBus()
    fetches = []
    headers = []
    responses = {}
  })
  afterEach(() => store.close())

  it('stores keys in the vault only, never in what it returns', () => {
    const service = make()
    const saved = save(service, { kind: 'openai', apiKey: '  sk-test-1234  ' })
    expect(saved.hasApiKey).toBe(true)
    expect(secrets.keys.get(saved.id)).toBe('sk-test-1234')
    expect(JSON.stringify(service.list())).not.toContain('sk-test-1234')
    expect(bus.of('providers:changed')).toHaveLength(1)

    // Omitting the key keeps it; '' removes it.
    expect(save(service, { id: saved.id, kind: 'openai', label: 'Renamed' }).hasApiKey).toBe(true)
    expect(secrets.keys.get(saved.id)).toBe('sk-test-1234')
    expect(save(service, { id: saved.id, kind: 'openai', apiKey: '' }).hasApiKey).toBe(false)
    expect(secrets.keys.has(saved.id)).toBe(false)
  })

  it('fills default models and refuses a key for Claude Code', () => {
    const service = make()
    expect(save(service, { kind: 'anthropic' }).defaultModelId).toBe('claude-opus-5-5')
    expect(save(service, { kind: 'claude-code' }).defaultModelId).toBe('default')
    expect(save(service, { kind: 'codex' }).defaultModelId).toBe('default')
    expect(save(service, { kind: 'openai' }).defaultModelId).toBe('')
    expect(() => save(service, { kind: 'claude-code', apiKey: 'sk-ant-x' })).toThrow(/does not take an API key/)
  })

  it('delete removes the key', () => {
    const service = make()
    const saved = save(service, { kind: 'xai', apiKey: 'xai-key' })
    service.delete(saved.id)
    expect(secrets.keys.size).toBe(0)
    expect(service.list()).toEqual([])
  })

  it('test(): API-key providers need a key and report the api-key route', async () => {
    const service = make()
    const noKey = save(service, { kind: 'anthropic' })
    expect(await service.test(noKey.id)).toEqual({ ok: false, message: 'Add an API key first.', billing: 'api-key' })
    const withKey = save(service, { kind: 'anthropic', apiKey: 'sk-ant-1' })
    expect(await service.test(withKey.id)).toEqual({ ok: true, message: 'Connected. 1 model available. Billed per token to this API key.', billing: 'api-key' })
  })

  it('test(): a local OpenAI-compatible server is the local route', async () => {
    responses['http://localhost:11434/v1/models'] = { status: 200, body: { object: 'list', data: [{ id: 'llama3.3:latest' }, { id: 'qwen3:8b' }] } }
    const service = make()
    const ollama = save(service, { kind: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })
    expect(await service.test(ollama.id)).toMatchObject({ ok: true, billing: 'local', message: expect.stringMatching(/2 models available/) })
    expect(headers[0]).not.toHaveProperty('authorization')
    expect(await service.models(ollama.id)).toEqual([
      { id: 'llama3.3:latest', label: 'llama3.3:latest', supportsTools: true },
      { id: 'qwen3:8b', label: 'qwen3:8b', supportsTools: true }
    ])
  })

  it('test(): reports a rejected key without echoing it', async () => {
    responses['https://api.openai.com/v1/models'] = { status: 401, body: { error: { message: 'Incorrect API key provided' } } }
    const service = make()
    const openai = save(service, { kind: 'openai', apiKey: 'sk-wrong-key' })
    const result = await service.test(openai.id)
    expect(result).toMatchObject({ ok: false, billing: 'api-key', message: expect.stringMatching(/rejected \(401\)/) })
    expect(result.message).not.toContain('sk-wrong-key')
    expect(headers[0]).toMatchObject({ authorization: 'Bearer sk-wrong-key' })
  })

  it('models(): live lists, filtered and cached', async () => {
    responses['https://api.openai.com/v1/models'] = {
      status: 200,
      body: { data: [{ id: 'gpt-5.1' }, { id: 'text-embedding-3-large' }, { id: 'whisper-1' }, { id: 'gpt-5.1-mini' }] }
    }
    const service = make()
    const openai = save(service, { kind: 'openai', apiKey: 'sk-1' })
    expect((await service.models(openai.id)).map((m) => m.id)).toEqual(['gpt-5.1', 'gpt-5.1-mini'])
    await service.models(openai.id)
    expect(fetches).toHaveLength(1)
  })

  it('models(): Gemini and Anthropic lists', async () => {
    responses['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'] = {
      status: 200,
      body: {
        models: [
          { name: 'models/gemini-3.5-pro', displayName: 'Gemini 3.5 Pro', inputTokenLimit: 1_048_576, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] }
        ]
      }
    }
    const service = make()
    const google = save(service, { kind: 'google', apiKey: 'g-key' })
    expect(await service.models(google.id)).toEqual([{ id: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro', contextWindow: 1_048_576, supportsTools: true }])
    expect(headers[0]).toMatchObject({ 'x-goog-api-key': 'g-key' })

    const anthropic = save(service, { kind: 'anthropic', apiKey: 'sk-ant' })
    expect(await service.models(anthropic.id)).toEqual([
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, supportsTools: true, supportsImages: true }
    ])
    // The runtime also sees the Claude capabilities behind the list.
    expect(await service.modelInfo(anthropic.id, 'claude-opus-5-5')).toMatchObject({
      anthropic: { adaptiveThinking: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], maxOutputTokens: 128_000 }
    })
  })

  it('test() and models() for Claude Code and Codex use their own logins', async () => {
    const service = make()
    const cc = save(service, { kind: 'claude-code' })
    expect(await service.test(cc.id)).toEqual({ ok: true, billing: 'subscription', message: 'Claude Code is signed in and uses your max subscription.' })
    expect((await service.models(cc.id)).map((m) => m.id)).toEqual(['default', 'opus'])
    const codex = save(service, { kind: 'codex' })
    expect(await service.test(codex.id)).toMatchObject({ ok: true, billing: 'subscription' })
    expect((await service.models(codex.id)).map((m) => m.id)).toEqual(['default'])
    const codexKey = save(service, { kind: 'codex', apiKey: 'sk-codex' })
    expect(await service.test(codexKey.id)).toMatchObject({ ok: true, billing: 'api-key' })
  })

  it('resolve(): explains what is missing', () => {
    const service = make()
    expect(() => service.resolve({ providerId: '', modelId: '' })).toThrow(/no model yet/)
    expect(() => service.resolve({ providerId: 'gone', modelId: '' })).toThrow(/was removed/)
    const off = save(service, { kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', enabled: false })
    expect(() => service.resolve({ providerId: off.id, modelId: 'x' })).toThrow(/turned off/)
    const noModel = save(service, { kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })
    expect(() => service.resolve({ providerId: noModel.id, modelId: '' })).toThrow(/Choose a model/)
    const noKey = save(service, { kind: 'anthropic' })
    expect(() => service.resolve({ providerId: noKey.id, modelId: '' })).toThrow(/has no API key/)

    const claude = save(service, { kind: 'anthropic', apiKey: 'sk-ant' })
    expect(service.resolve({ providerId: claude.id, modelId: '', effort: 'max' })).toMatchObject({
      modelId: 'claude-opus-5-5',
      effort: 'max',
      engine: 'native'
    })
    const cc = save(service, { kind: 'claude-code' })
    expect(service.resolve({ providerId: cc.id, modelId: 'sonnet' })).toMatchObject({ modelId: 'sonnet', engine: 'claude-code' })
  })
})

describe('catalog', () => {
  it('knows local addresses', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234', 'http://192.168.1.20:8000/v1', 'http://10.0.0.5', 'http://[::1]:11434', 'http://box.local:8080']) {
      expect(isLocalUrl(url)).toBe(true)
    }
    for (const url of ['https://openrouter.ai/api/v1', 'https://api.together.xyz/v1', 'http://172.32.0.1', 'not a url', undefined]) {
      expect(isLocalUrl(url)).toBe(false)
    }
  })

  it('shows the billing route of each kind', () => {
    const route = (kind: never, extra: object = {}) => billingRoute({ kind, hasApiKey: false, ...extra })
    expect(route('anthropic' as never)).toBe('api-key')
    expect(route('claude-code' as never)).toBe('subscription')
    expect(route('codex' as never)).toBe('subscription')
    expect(route('codex' as never, { hasApiKey: true })).toBe('api-key')
    expect(route('openai-compatible' as never, { baseUrl: 'http://localhost:11434/v1' })).toBe('local')
    expect(route('openai-compatible' as never, { baseUrl: 'https://openrouter.ai/api/v1', hasApiKey: true })).toBe('api-key')
  })

  it('resolves model ids: bot route, then provider default, then kind default', () => {
    expect(resolveModelId({ kind: 'anthropic', defaultModelId: '' }, '')).toBe('claude-opus-5-5')
    expect(resolveModelId({ kind: 'anthropic', defaultModelId: 'claude-sonnet-5-5' }, '')).toBe('claude-sonnet-5-5')
    expect(resolveModelId({ kind: 'anthropic', defaultModelId: 'claude-sonnet-5-5' }, 'claude-haiku-5-5')).toBe('claude-haiku-5-5')
    expect(resolveModelId({ kind: 'openai', defaultModelId: '' }, '')).toBe('')
  })
})

describe('subscription logins', () => {
  it('reads how a Claude Code login is billed', () => {
    expect(claudeCodeBilling({ email: 'a@b.c', subscriptionType: 'max' })).toEqual({ billing: 'subscription', signedIn: true, plan: 'max' })
    expect(claudeCodeBilling({ apiKeySource: '/login managed key' })).toEqual({ billing: 'api-key', signedIn: true })
    expect(claudeCodeBilling({ apiProvider: 'bedrock' })).toEqual({ billing: 'api-key', signedIn: true, plan: 'bedrock' })
    expect(claudeCodeBilling({})).toEqual({ billing: 'unknown', signedIn: false })
  })

  it('reads `codex login status` without repeating it', () => {
    expect(parseCodexLoginStatus(0, 'Logged in using ChatGPT', false)).toMatchObject({ ok: true, billing: 'subscription' })
    const apiKey = parseCodexLoginStatus(0, 'Logged in using an API key - sk-proj-***abcd', false)
    expect(apiKey).toMatchObject({ ok: true, billing: 'api-key' })
    expect(apiKey.message).not.toContain('sk-proj')
    expect(parseCodexLoginStatus(1, 'Not logged in', false)).toMatchObject({ ok: false })
  })

  it('runs engine binaries from app.asar.unpacked in the installed app', () => {
    expect(unpackedPath(String.raw`C:\Programs\FaiBots\resources\app.asar\node_modules\codex.exe`)).toBe(
      String.raw`C:\Programs\FaiBots\resources\app.asar.unpacked\node_modules\codex.exe`
    )
    expect(unpackedPath('/opt/FaiBots/resources/app.asar/node_modules/x/claude')).toBe('/opt/FaiBots/resources/app.asar.unpacked/node_modules/x/claude')
    // From source (no archive) and already-unpacked paths stay as they are.
    expect(unpackedPath('/repo/node_modules/x/claude')).toBe('/repo/node_modules/x/claude')
    expect(unpackedPath('/r/app.asar.unpacked/x')).toBe('/r/app.asar.unpacked/x')
    const sep = process.platform === 'win32' ? ';' : ':'
    expect(withPathDirs({ Path: '/usr/bin' }, ['/rg'])).toEqual({ Path: `/rg${sep}/usr/bin` })
  })
})
