import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ToolContext, ToolDefinition, ToolResult } from '../contracts'
import { createHarness } from '../agent/testing/fakes'
import { executeAction } from './action-executor'
import { errorResult } from './define'

const refusal = (): ToolResult => ({ ...errorResult('refused'), refusedBeforeRun: true })

function setup() {
  const h = createHarness()
  const bot = h.bot('Worker')
  const dm = h.runtime.openDm(bot.id)
  const def = { name: 'effect', source: 'builtin', execute: async () => refusal(),
    recovery: { version: '1', recover: async () => refusal() } } as unknown as ToolDefinition
  const ctx = { bot, conversation: dm, actionId: 'act-1', workspaceDir: '', signal: new AbortController().signal } as unknown as ToolContext
  const run = () => executeAction({ actions: h.services.store.actions, ctx, def, input: {}, finalize: (r) => r,
    authorize: (dispatch) => dispatch() })
  return { h, bot, dm, run }
}

describe('refusedBeforeRun', () => {
  it('a fresh refusal leaves the action completed, not unknown', async () => {
    const { h, run } = setup()
    try {
      const result = await run()
      expect(result.recovery).toBeUndefined()
      expect(h.services.store.actions.get('act-1')?.state).toBe('completed')
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })

  it('a recovering action stays unknown even if the recovery reports a refusal', async () => {
    const { h, bot, dm, run } = setup()
    try {
      // An earlier dispatch that never finished, then the same action runs again.
      const claim = h.services.store.actions.claim({ id: 'act-1', botId: bot.id, conversationId: dm.id, toolName: 'effect',
        inputDigest: createHash('sha256').update(JSON.stringify(['', {}])).digest('hex'),
        capability: JSON.stringify(['builtin', '', '1']) }, true)
      if (claim.kind !== 'claimed') throw new Error('claim failed')
      h.services.store.actions.dispatch('act-1', claim.record.attempt!)
      h.services.store.actions.recoverInterrupted()
      const result = await run()
      expect(result.recovery?.state).toBe('unknown')
    } finally { await h.runtime.shutdown(); h.cleanup() }
  })
})
