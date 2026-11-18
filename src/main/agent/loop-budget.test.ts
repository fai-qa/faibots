import { describe, expect, it } from 'vitest'
import { createHarness } from './testing/fakes'
import { createNativeEngine, MAX_STEPS } from './native-engine'
import { ScriptedAdapter, callTools } from './testing/scripted-adapter'

const trigger = { kind: 'routine' as const, routineId: 'r', routineName: 'Check', via: 'manual' as const }

describe('automatic admission and stop evidence', () => {
  it('counts an in-flight routine before another conversation asks the same bot', async () => {
    const h = createHarness()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let entered!: () => void
    const ready = new Promise<void>((r) => { entered = r })
    try {
      const helper = h.bot('Helper', { dailyRunLimit: 1 }); const lead = h.bot('Lead')
      h.engine.script('helper', async (api) => { entered(); await gate; api.say('finished') })
      let answer = ''
      h.engine.script('lead', async (api) => {
        const result = await api.tool('send_to_agent', { to: 'helper', message: 'another task' })
        answer = JSON.stringify(result)
      })
      const first = h.runtime.runAutomated({ botId: helper.id, text: 'first task', trigger })
      await ready
      const second = h.runtime.send({ conversationId: h.runtime.openDm(lead.id).id, text: 'ask helper',
        attachmentPaths: [], mentions: [], mentionsEveryone: false, clientNonce: 'second-conversation' })
      await second
      // Let the second queue reach the admission gate without releasing the first turn.
      await new Promise((r) => setTimeout(r, 30))
      expect(h.engine.turns.filter((t) => t.botId === helper.id)).toHaveLength(1)
      expect(answer).toContain('daily limit')
      release(); await first; await h.runtime.idle()
      expect(h.services.store.turns.automaticRunsSince(helper.id, 0)).toBe(1)
    } finally { release?.(); await h.runtime.shutdown(); h.cleanup() }
  })

  it('does not reserve missing-provider or already-cancelled work', async () => {
    const h = createHarness()
    try {
      const bot = h.bot('No route', { dailyRunLimit: 1, model: { providerId: '', modelId: '' } })
      await h.runtime.runAutomated({ botId: bot.id, text: 'task', trigger })
      const stop = new AbortController(); stop.abort()
      const ready = h.bot('Ready', { dailyRunLimit: 1 })
      expect((await h.runtime.runAutomated({ botId: ready.id, text: 'task', trigger, signal: stop.signal })).status).toBe('cancelled')
      expect(h.services.store.turns.automaticRunsSince(bot.id, 0)).toBe(0)
      expect(h.services.store.turns.automaticRunsSince(ready.id, 0)).toBe(0)
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })

  it('partial text followed by cancellation is never done', async () => {
    const h = createHarness(); const stop = new AbortController()
    try {
      const bot = h.bot('Writer')
      h.engine.script('writer', (api) => { api.say('I started'); stop.abort() })
      expect((await h.runtime.runAutomated({ botId: bot.id, text: 'task', trigger, signal: stop.signal })).status).toBe('cancelled')
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })

  it('does not accept a final reply when a native action outcome remains unknown', async () => {
    const h = createHarness()
    try {
      const bot = h.bot('Worker')
      h.services.tools.register({ name: 'uncertain', source: 'builtin', description: '', inputSchema: {}, defaultPermission: 'always',
        activityLabel: 'Uncertain action', execute: async () => { throw new Error('connection lost after effect') } })
      h.engine.script('worker', async (api) => { await api.tool('uncertain', {}); api.say('Everything is done') })
      const result = await h.runtime.runAutomated({ botId: bot.id, text: 'task', trigger })
      expect(result.status).toBe('error')
      expect(result.error).toMatch(/unknown|unresolved/i)
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })

  it.each(['max_tokens', 'context', 'refusal', 'steps'] as const)('records %s as unsuccessful execution even with partial prose', async (reason) => {
    const adapter = new ScriptedAdapter()
    const h = createHarness({ engines: (services) => ({ native: createNativeEngine({ store: services.store,
      providers: { adapterFor: () => adapter, modelInfo: async () => undefined }, attachments: services.attachments }) }) })
    try {
      const bot = h.bot('Looper')
      if (reason === 'steps') for (let i = 0; i < MAX_STEPS + 1; i++) adapter.push(callTools([{ id: `c${i}`, name: 'list_bots', input: {} }], 'working'))
      else adapter.push((events) => { events.onTextDelta('partial'); return { stop: reason, text: 'partial', toolCalls: [] } })
      const result = await h.runtime.runAutomated({ botId: bot.id, text: 'task', trigger })
      expect(result.status).toBe('error')
      expect(result.error).toBeTruthy()
      if (reason === 'steps') expect(adapter.stepsRun).toBe(25)
      expect(h.services.store.turns.summary(0, Date.now() + 100).rows[0]?.errors).toBe(1)
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })
})
