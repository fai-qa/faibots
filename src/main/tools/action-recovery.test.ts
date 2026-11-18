import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext, ToolDefinition, ToolResult } from '../contracts'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { createApprovalService } from './approvals'
import { textResult } from './define'
import { createToolRegistry } from './registry'
import { toolStatus } from '../agent/turn-recorder'

describe('durable native actions', () => {
  let store: PlatformStore
  let context: ToolContext
  let effects: string[]
  let bus: ReturnType<typeof fakeBus>
  let approvals: ReturnType<typeof createApprovalService>
  const makeRegistry = () => createToolRegistry({ store, bus, approvals,
    mcp: { toolsForBot: async () => [], allTools: async () => [] },
    secrets: { redact: (text) => text.replaceAll('secret-password', '[redacted]') } })
  const definition = (extra: Partial<ToolDefinition> = {}): ToolDefinition => ({
    name: 'effect', description: 'Fake service', inputSchema: {}, source: 'builtin',
    defaultPermission: 'always', activityLabel: 'Fake action',
    execute: async (input) => { effects.push(JSON.stringify(input)); return textResult('receipt-1') },
    ...extra
  })
  const pendingApproval = async () => {
    for (let i = 0; i < 50; i++) {
      const card = bus.of('conv:entry').find((e) => e.entry.approval?.status === 'pending')
      if (card) return card.entry.approval!.approvalId
      await new Promise((r) => setTimeout(r, 1))
    }
    throw new Error('No approval appeared')
  }
  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/test-home' })
    const bot = store.bots.create({ name: 'Recovery test' })
    const conversation = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
    context = { bot, conversation, turnId: 'turn-1', callId: 'call-1', actionId: 'action-1',
      signal: new AbortController().signal, chain: [], inGroup: false, workspaceDir: '/test-work' }
    bus = fakeBus()
    approvals = createApprovalService({ store, bus })
    effects = []
  })
  afterEach(() => store.close())

  it('returns the saved receipt on duplicate submission instead of repeating the effect', async () => {
    const registry = makeRegistry(); registry.register(definition())
    const first = await registry.execute('effect', { amount: 1 }, context)
    const second = await registry.execute('effect', { amount: 1 }, context)
    expect(effects).toHaveLength(1)
    expect(second).toEqual(first)
    expect(store.actions.get('action-1')).toMatchObject({ state: 'completed', approvedDigest: expect.any(String) })
  })

  it('blocks a reused identity with changed input even when tools are always allowed', async () => {
    const registry = makeRegistry(); registry.register(definition())
    await registry.execute('effect', { amount: 1 }, context)
    const changed = await registry.execute('effect', { amount: 100 }, context)
    expect(changed.isError).toBe(true)
    expect(effects).toEqual(['{"amount":1}'])
  })

  it('atomically claims across two registries before awaiting the external service', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const def = definition({ execute: async () => { effects.push('one'); await gate; return textResult('receipt') } })
    const a = makeRegistry(); const b = makeRegistry(); a.register(def); b.register(def)
    const first = a.execute('effect', {}, context)
    const second = await b.execute('effect', {}, context)
    release(); await first
    expect(effects).toEqual(['one'])
    expect(second.isError).toBe(true)
  })

  it('blocks same-ID and new-ID retries after an ambiguous failure without a recovery adapter', async () => {
    const registry = makeRegistry()
    registry.register(definition({ execute: async () => { effects.push('committed'); throw new Error('connection lost') } }))
    await registry.execute('effect', { amount: 1 }, context)
    await registry.execute('effect', { amount: 1 }, context)
    const bypass = await registry.execute('effect', { amount: 1 }, { ...context, actionId: 'new-id', callId: 'new-call' })
    expect(effects).toEqual(['committed'])
    expect(bypass.isError).toBe(true)
    expect(store.actions.get('action-1')?.state).toBe('unknown')
  })

  it.each(['timeout', 'transport failure', 'cancellation'])('keeps returned %s errors unknown after a partial effect', async (reason) => {
    const controller = new AbortController()
    const registry = makeRegistry()
    registry.register(definition({ execute: async () => {
      effects.push('partial effect')
      if (reason === 'cancellation') controller.abort()
      return { isError: true, content: [{ type: 'text', text: reason }] }
    } }))
    const result = await registry.execute('effect', { amount: 1 }, { ...context, signal: controller.signal })
    expect(result).toMatchObject({ recovery: { state: 'unknown' } })
    expect(toolStatus(result, controller.signal.aborted)).toBe('error')
    await registry.execute('effect', { amount: 1 }, { ...context, actionId: 'another-id' })
    expect(effects).toEqual(['partial effect'])
    expect(store.actions.get('action-1')?.state).toBe('unknown')
  })

  it('a recovery adapter error cannot certify that the original effect completed', async () => {
    const registry = makeRegistry()
    registry.register(definition({ execute: async () => { effects.push('committed'); throw new Error('lost') },
      recovery: { version: 'fake/v1', recover: async () => ({ isError: true, content: [{ type: 'text', text: 'Lookup timed out' }] }) }
    }))
    await registry.execute('effect', {}, context)
    await registry.execute('effect', {}, context)
    expect(store.actions.get('action-1')?.state).toBe('unknown')
    await registry.execute('effect', {}, { ...context, actionId: 'new-id' })
    expect(effects).toEqual(['committed'])
  })

  it('uses the original key for an explicitly supported recovery and returns the original receipt', async () => {
    const receipts = new Map<string, ToolResult>()
    const registry = makeRegistry()
    registry.register(definition({
      execute: async (_input, ctx) => { effects.push('committed'); receipts.set(ctx.actionId!, textResult('original')); throw new Error('lost reply') },
      recovery: { version: 'fake-service/v1', recover: async (_input, ctx) => receipts.get(ctx.actionId!) }
    }))
    await registry.execute('effect', {}, context)
    const recovered = await registry.execute('effect', {}, context)
    expect(effects).toEqual(['committed'])
    expect(recovered).toEqual(textResult('original'))
    expect(store.actions.get('action-1')?.state).toBe('completed')
  })

  it('does not let a newly changed recovery capability reinterpret an old unknown action', async () => {
    const first = makeRegistry()
    first.register(definition({ execute: async () => { effects.push('one'); throw new Error('lost') },
      recovery: { version: 'old', recover: async () => undefined } }))
    await first.execute('effect', {}, context)
    const second = makeRegistry()
    second.register(definition({ recovery: { version: 'new', recover: async () => { effects.push('wrong'); return textResult('wrong') } } }))
    expect((await second.execute('effect', {}, context)).isError).toBe(true)
    expect(effects).toEqual(['one'])
  })

  it('binds the approved payload to a snapshot before the caller can mutate it', async () => {
    const registry = makeRegistry(); registry.register(definition({ defaultPermission: 'ask' }))
    const input = { amount: 1 }
    const run = registry.execute('effect', input, context)
    const approval = await pendingApproval()
    input.amount = 99
    approvals.resolve(approval, 'allow_once')
    await run
    expect(effects).toEqual(['{"amount":1}'])
  })

  it('cancellation after approval but before dispatch has zero external effects', async () => {
    const controller = new AbortController()
    const registry = makeRegistry(); registry.register(definition({ defaultPermission: 'ask' }))
    const run = registry.execute('effect', {}, { ...context, signal: controller.signal })
    approvals.resolve(await pendingApproval(), 'allow_once')
    controller.abort()
    expect(await run).toMatchObject({ outcome: 'cancelled' })
    expect(effects).toEqual([])
    expect(store.actions.get('action-1')?.state).toBe('cancelled')
  })

  it('denial persists and a repeated submission cannot revive the action', async () => {
    const registry = makeRegistry(); registry.register(definition({ defaultPermission: 'ask' }))
    const run = registry.execute('effect', {}, context)
    approvals.resolve(await pendingApproval(), 'deny')
    await run
    expect(store.actions.get('action-1')?.state).toBe('denied')
    expect(await registry.execute('effect', {}, context)).toMatchObject({ outcome: 'denied' })
    expect(effects).toEqual([])
  })

  it('saves no raw input and only redacted text receipts, including display metadata', async () => {
    const registry = makeRegistry(); registry.register(definition({ execute: async () => textResult('secret-password', { title: 'secret-password' }) }))
    await registry.execute('effect', { password: 'secret-password' }, context)
    const record = JSON.stringify(store.actions.get('action-1'))
    expect(record).not.toContain('secret-password')
    expect(record).toContain('[redacted]')
  })
})
