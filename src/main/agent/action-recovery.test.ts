import { describe, expect, it } from 'vitest'
import { createHarness } from './testing/fakes'
import { textResult } from '../tools/define'
import { Orchestrator } from './orchestrator'

describe('native action wiring', () => {
  it('persists a native identity on the card and prevents repeat dispatch within that turn', async () => {
    const h = createHarness()
    try {
      let effects = 0
      h.services.tools.register({ name: 'effect', description: '', inputSchema: {}, source: 'builtin',
        defaultPermission: 'always', activityLabel: 'Fake action', execute: async () => { effects++; return textResult('receipt') } })
      const bot = h.bot('Worker'); const dm = h.runtime.openDm(bot.id)
      h.engine.script(bot.handle, async ({ turn }) => {
        const call = { id: 'same-model-call', name: 'effect', input: {} }
        await turn.runTool(call); await turn.runTool(call)
      })
      await h.send(dm.id, 'one task')
      expect(effects).toBe(1)
      const card = h.services.store.entries.page(dm.id, { limit: 100 }).entries.find((e) => e.kind === 'tool-call')!
      expect(card.toolCall?.actionId).toBeTruthy()
      expect(h.services.store.actions.get(card.toolCall!.actionId!)?.state).toBe('completed')
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })

  it('startup recovers a dispatched action and marks its card unresolved even beyond the old tail window', async () => {
    const h = createHarness()
    try {
      const bot = h.bot('Worker'); const dm = h.runtime.openDm(bot.id)
      const claim = h.services.store.actions.claim({ id: 'old-action', botId: bot.id, conversationId: dm.id,
        toolName: 'effect', inputDigest: 'digest', capability: 'cap' }, false)
      if (claim.kind !== 'claimed') throw new Error('claim failed')
      h.services.store.actions.dispatch('old-action', claim.record.attempt!)
      const card = h.services.store.entries.append({ conversationId: dm.id, kind: 'tool-call', author: { kind: 'bot', botId: bot.id },
        text: 'Action', mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false,
        toolCall: { callId: 'call', actionId: 'old-action', toolName: 'effect', title: 'Action', input: {}, status: 'running' } })
      for (let i = 0; i < 60; i++) h.services.store.entries.append({ conversationId: dm.id, kind: 'message', author: { kind: 'user' },
        text: 'later message', mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false })
      await h.runtime.shutdown()
      const restarted = new Orchestrator({ ...h.services, providers: h.providers }, { engines: { native: h.engine, codex: h.engine, 'claude-code': h.engine } })
      expect(h.services.store.actions.get('old-action')?.state).toBe('unknown')
      const recovered = h.services.store.entries.get(card.id)!.toolCall!
      expect(recovered.status).toBe('error')
      expect(recovered.resultText).toMatch(/unknown/i)
      await restarted.shutdown()
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })
})
