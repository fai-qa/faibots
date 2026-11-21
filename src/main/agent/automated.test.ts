// Phase 2 runtime behaviour: automatic runs (routines), the turn log and the daily run limit.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntryTrigger } from '@shared/domain'
import { buildBotView } from './history'
import { createHarness, type Harness } from './testing/fakes'

const trigger = (name = 'Morning brief'): EntryTrigger => ({ kind: 'routine', routineId: 'r1', routineName: name, via: 'schedule' })

describe('automatic runs', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })
  afterEach(async () => {
    await h.runtime.shutdown()
    h.cleanup()
  })

  it('posts the task as faibots in the bot chat and returns the reply', async () => {
    const bot = h.bot('Stark')
    h.engine.script('stark', (api) => {
      api.turn.recorder.addUsage({ inputTokens: 120, outputTokens: 30 })
      api.say('Three things today: ...')
    })

    const result = await h.runtime.runAutomated({ botId: bot.id, text: 'Brief me on today', trigger: trigger() })

    expect(result).toMatchObject({ status: 'done', reply: 'Three things today: ...' })
    const entries = h.services.store.entries.page(result.conversationId, { limit: 10 }).entries
    expect(entries[0]).toMatchObject({ id: result.entryId, author: { kind: 'system' }, text: 'Brief me on today', trigger: trigger() })
    expect(h.services.store.conversations.get(result.conversationId)).toMatchObject({ kind: 'dm', botIds: [bot.id] })
    expect(h.engine.turns[0]).toMatchObject({ newTexts: ['Brief me on today'], inGroup: false })

    // The turn log knows it was a routine, and its tokens.
    const usage = h.services.store.turns.summary(0, Date.now() + 1).rows
    expect(usage).toEqual([
      expect.objectContaining({ botId: bot.id, turns: 1, automaticTurns: 1, inputTokens: 120, outputTokens: 30, providerId: h.providerId })
    ])
  })

  it('tells the bot the message came from a routine, not from the user', async () => {
    const bot = h.bot('Stark')
    const result = await h.runtime.runAutomated({ botId: bot.id, text: 'Check the inbox', trigger: trigger('Inbox check') })
    const entries = h.services.store.entries.page(result.conversationId, { limit: 10 }).entries
    const view = buildBotView({ botId: bot.id, entries, summary: '', nameOf: (a) => (a.kind === 'system' ? 'faibots' : 'Alex') })
    const first = view[0]
    expect(first?.role).toBe('user')
    const text = first?.role === 'user' && first.content[0]?.type === 'text' ? first.content[0].text : ''
    expect(text).toMatch(/^\[faibots\] Routine "Inbox check", started automatically on its schedule\./)
    expect(text).toContain('Check the inbox')
  })

  it('logs user turns too, but only automatic ones count against the daily limit', async () => {
    const bot = h.bot('Stark', { dailyRunLimit: 1 })
    const dm = h.runtime.openDm(bot.id)
    await h.send(dm.id, 'hi')
    await h.send(dm.id, 'and again')
    expect(h.services.store.turns.automaticRunsSince(bot.id, 0)).toBe(0)

    const first = await h.runtime.runAutomated({ botId: bot.id, text: 'Run one', trigger: trigger() })
    expect(first.status).toBe('done')
    const second = await h.runtime.runAutomated({ botId: bot.id, text: 'Run two', trigger: trigger() })
    expect(second).toMatchObject({ status: 'limited', reply: '' })
    expect(second.error).toContain('reached its daily limit of 1 automatic run')
    // The refusal is said in the chat, and no model was called for it.
    expect(h.transcript(dm.id).length).toBeGreaterThan(0)
    const events = h.services.store.entries.page(dm.id, { limit: 50 }).entries.filter((e) => e.kind === 'event')
    expect(events.at(-1)?.text).toContain('daily limit')
    expect(h.engine.turns).toHaveLength(3)

    // You can still talk to it yourself.
    await h.send(dm.id, 'you there?')
    expect(h.engine.turns).toHaveLength(4)
  })

  it('applies the limit when another bot asks', async () => {
    const asker = h.bot('Lead')
    h.bot('Helper', { dailyRunLimit: 1 })
    const results: string[] = []
    h.engine.script('lead', async (api) => {
      const r1 = await api.tool('send_to_agent', { to: 'helper', message: 'first?' })
      const r2 = await api.tool('send_to_agent', { to: 'helper', message: 'second?' })
      for (const r of [r1, r2]) results.push(r.content[0]?.type === 'text' ? r.content[0].text : '')
      api.say('done')
    })
    h.engine.script('helper', (api) => api.say('Here you go.'))

    const dm = h.runtime.openDm(asker.id)
    await h.send(dm.id, 'ask the helper twice')

    expect(results[0]).toContain('Here you go.')
    expect(results[1]).toContain('daily limit')
    const usage = h.services.store.turns.summary(0, Date.now() + 1).rows
    const helperRows = usage.filter((r) => r.botId !== asker.id)
    expect(helperRows.reduce((n, r) => n + r.automaticTurns, 0)).toBe(1)
  })

  it('reports an error when the bot has no model', async () => {
    const bot = h.services.store.bots.create({ name: 'Blank', model: { providerId: '', modelId: '' } })
    const result = await h.runtime.runAutomated({ botId: bot.id, text: 'Do it', trigger: trigger() })
    expect(result.status).toBe('error')
    expect(result.error).toContain('no model')
  })

  it('stops when the run is cancelled', async () => {
    const bot = h.bot('Slow')
    h.engine.script('slow', (api) => api.untilAborted())
    const abort = new AbortController()
    const pending = h.runtime.runAutomated({ botId: bot.id, text: 'Take your time', trigger: trigger(), signal: abort.signal })
    await new Promise((r) => setTimeout(r, 10))
    abort.abort()
    expect((await pending).status).toBe('cancelled')
  })
})
