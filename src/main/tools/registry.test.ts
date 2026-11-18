import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot, Conversation, Entry } from '@shared/domain'
import type { ToolContext, ToolDefinition, ToolRegistry } from '../contracts'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { createApprovalService } from './approvals'
import { defineTool, textResult } from './define'
import { createToolRegistry, MAX_RESULT_CHARS, truncateText, type McpToolSource } from './registry'
import { z } from 'zod'

const echoSchema = z.object({ text: z.string() })
type EchoSpec = Parameters<typeof defineTool<typeof echoSchema>>[0]

const echo = (name: string, defaultPermission: ToolDefinition['defaultPermission'], extra: Partial<EchoSpec> = {}) =>
  defineTool({
    name,
    description: 'Echo the text',
    schema: echoSchema,
    source: 'builtin',
    defaultPermission,
    activityLabel: 'Echoing',
    summarize: (input) => `Echo ${input.text}`,
    execute: async (input) => textResult(`echo: ${input.text}`),
    ...extra
  })

describe('ToolRegistry', () => {
  let store: PlatformStore
  let bus: ReturnType<typeof fakeBus>
  let registry: ToolRegistry
  let approvals: ReturnType<typeof createApprovalService>
  let bot: Bot
  let dm: Conversation
  let mcpTools: ToolDefinition[]
  const redacted = new Map<string, string>()

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    bot: store.bots.get(bot.id)!,
    conversation: dm,
    turnId: 't1',
    callId: 'c1',
    signal: new AbortController().signal,
    chain: [],
    inGroup: false,
    workspaceDir: '/tmp/ws',
    ...over
  })

  const lastApproval = (): Entry => bus.of('conv:entry').map((e) => e.entry).filter((e) => e.kind === 'approval').at(-1)!

  /** Wait until an approval card is posted, then answer it. */
  const answer = async (decision: 'allow_once' | 'always' | 'deny' | 'never') => {
    for (let i = 0; i < 50 && !bus.of('conv:entry').some((e) => e.entry.approval?.status === 'pending'); i++) {
      await new Promise((r) => setTimeout(r, 1))
    }
    approvals.resolve(lastApproval().approval!.approvalId, decision)
  }

  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/tmp' })
    bus = fakeBus()
    approvals = createApprovalService({ store, bus })
    mcpTools = []
    // Like the real host: only granted servers' tools, and clashing names get a _2 suffix by position.
    const mcp: McpToolSource = {
      toolsForBot: async (b) => {
        const seen = new Set<string>()
        return mcpTools
          .filter((t) => !t.serverId || b.mcpServerIds === 'all' || b.mcpServerIds.includes(t.serverId))
          .map((t) => {
            let name = t.name
            for (let n = 2; seen.has(name); n++) name = `${t.name}_${n}`
            seen.add(name)
            return name === t.name ? t : { ...t, name }
          })
      },
      allTools: async () => mcpTools
    }
    redacted.clear()
    registry = createToolRegistry({
      store,
      approvals,
      bus,
      mcp,
      secrets: { redact: (text) => [...redacted].reduce((t, [value, name]) => t.split(value).join(`«secret:${name}»`), text) }
    })
    bot = store.bots.create({ name: 'Ops' })
    dm = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
    registry.register(echo('free', 'always'))
    registry.register(echo('careful', 'ask'))
    registry.register(echo('off', 'never'))
    registry.register(echo('group_only', 'always', { isAvailable: (c) => c.inGroup }))
  })
  afterEach(() => store.close())

  it('rejects bad and duplicate names', () => {
    expect(() => registry.register(echo('free', 'always'))).toThrow(/already/)
    expect(() => registry.register(echo('has space', 'always'))).toThrow(/Invalid/)
    expect(() => registry.register(echo('mcp__x__y', 'always'))).toThrow(/reserved/)
  })

  it('resolves permission: bot override > global > tool default', async () => {
    const effective = async () => Object.fromEntries((await registry.info(bot.id)).map((t) => [t.name, t.effectivePermission]))
    expect(await effective()).toMatchObject({ free: 'always', careful: 'ask', off: 'never' })
    registry.setPermission('careful', 'always')
    registry.setPermission('free', 'never')
    expect(await effective()).toMatchObject({ free: 'never', careful: 'always' })
    registry.setPermission('free', 'ask', bot.id)
    registry.setPermission('careful', 'never', bot.id)
    expect(await effective()).toMatchObject({ free: 'ask', careful: 'never' })
    registry.setPermission('careful', null, bot.id)
    expect(await effective()).toMatchObject({ careful: 'always' })
    // The global listing ignores bot overrides.
    expect((await registry.info()).find((t) => t.name === 'free')?.effectivePermission).toBe('never')
    expect(bus.of('bots:changed').length).toBeGreaterThan(0)
    expect(bus.of('settings:changed').length).toBeGreaterThan(0)
  })

  describe('connector revoked during a turn', () => {
    const conn = (serverId: string, name: string, label: string, mode: ToolDefinition['defaultPermission'] = 'always'): ToolDefinition => ({
      ...echo(name, mode, { execute: async () => textResult(`ran ${label}`) }), source: 'mcp', serverId, remoteName: 'ping'
    })
    const grant = (ids: string[]) => { store.bots.update(bot.id, { mcpServerIds: ids }) }
    const ran = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text
    const gone = (name: string) => ({
      isError: true, outcome: 'denied',
      content: [{ text: expect.stringMatching(new RegExp(`${name} is no longer available to this bot.*Do not retry`)) }]
    })
    /** Turn-start snapshot as the orchestrator builds it from forTurn. */
    const turnCtx = async (over: Partial<ToolContext> = {}): Promise<ToolContext> => {
      const c = ctx(over)
      const offered = await registry.forTurn({ bot: c.bot, conversation: dm, inGroup: false })
      const map = new Map(offered.filter((t) => t.serverId && t.remoteName).map((t) => [t.name, { serverId: t.serverId!, remoteName: t.remoteName! }]))
      return { ...c, mcpTools: map }
    }

    it('stops the next call in the same turn, keeping other connectors and built-ins', async () => {
      mcpTools = [conn('a', 'mcp__a__ping', 'A'), conn('b', 'mcp__b__ping', 'B')]
      grant(['a', 'b'])
      const stale = await turnCtx()
      expect(ran(await registry.execute('mcp__a__ping', { text: 'x' }, stale))).toBe('ran A')
      grant(['b'])
      expect(await registry.execute('mcp__a__ping', { text: 'x' }, stale)).toMatchObject(gone('mcp__a__ping'))
      expect(ran(await registry.execute('mcp__b__ping', { text: 'x' }, stale))).toBe('ran B')
      expect(ran(await registry.execute('free', { text: 'x' }, stale))).toBe('echo: x')
    })

    it('denies a connector call with no turn-start map even when the grant is current', async () => {
      mcpTools = [conn('a', 'mcp__a__ping', 'A')]
      grant(['a'])
      const result = await registry.execute('mcp__a__ping', { text: 'x' }, ctx()) // no mcpTools
      expect(result).toMatchObject({
        isError: true,
        outcome: 'denied',
        content: [{ text: expect.stringMatching(/no verifiable connector grant/) }]
      })
    })

    it('stops a call whose grant is removed while the approval card is open', async () => {
      mcpTools = [conn('a', 'mcp__a__ping', 'A', 'ask')]
      grant(['a'])
      const pending = registry.execute('mcp__a__ping', { text: 'x' }, await turnCtx())
      for (let i = 0; i < 50 && !bus.of('conv:entry').some((e) => e.entry.approval?.status === 'pending'); i++) await new Promise((r) => setTimeout(r, 1))
      grant([])
      approvals.resolve(lastApproval().approval!.approvalId, 'allow_once')
      expect(await pending).toMatchObject(gone('mcp__a__ping'))
    })

    it('refuses a connector call when the bot was deleted', async () => {
      mcpTools = [conn('a', 'mcp__a__ping', 'A')]
      grant(['a'])
      const c = await turnCtx()
      store.bots.delete(bot.id)
      expect(await registry.execute('mcp__a__ping', { text: 'x' }, c)).toMatchObject(gone('mcp__a__ping'))
    })

    it('stops a revoked connector on the executeAction path', async () => {
      mcpTools = [conn('a', 'mcp__a__ping', 'A'), conn('b', 'mcp__b__ping', 'B')]
      grant(['a', 'b'])
      const stale = await turnCtx({ actionId: 'act-1' })
      grant(['b'])
      expect(await registry.execute('mcp__a__ping', { text: 'x' }, stale)).toMatchObject(gone('mcp__a__ping'))
      expect(ran(await registry.execute('mcp__b__ping', { text: 'x' }, { ...stale, actionId: 'act-2', callId: 'c2' }))).toBe('ran B')
    })

    it('identifies the connector by server, not by a name that dedupe reassigns', async () => {
      // Two servers sanitize to the same name: s2 is offered as mcp__x__ping_2 while both are granted.
      mcpTools = [conn('s1', 'mcp__x__ping', 'S1'), conn('s2', 'mcp__x__ping', 'S2')]
      grant(['s1', 's2'])
      const stale = await turnCtx()
      grant(['s2']) // s1 revoked: s2 now owns the plain name
      expect(await registry.execute('mcp__x__ping', { text: 'x' }, stale)).toMatchObject(gone('mcp__x__ping')) // never S2 under S1's name
      expect(ran(await registry.execute('mcp__x__ping_2', { text: 'x' }, stale))).toBe('ran S2')
      // Other direction: s2 revoked while s1 stays; s1 keeps its own name and s2's name stays refused.
      grant(['s1'])
      expect(ran(await registry.execute('mcp__x__ping', { text: 'x' }, stale))).toBe('ran S1')
      expect(await registry.execute('mcp__x__ping_2', { text: 'x' }, stale)).toMatchObject(gone('mcp__x__ping_2'))
    })

    it('does not let a server granted after turn start answer to a name it was not offered under', async () => {
      mcpTools = [conn('s1', 'mcp__x__ping', 'S1'), conn('s2', 'mcp__x__ping', 'S2')]
      grant(['s2'])
      const stale = await turnCtx() // offered: s2 as mcp__x__ping
      grant(['s1', 's2']) // s1 sorts first, takes the plain name
      expect(ran(await registry.execute('mcp__x__ping', { text: 'x' }, stale))).toBe('ran S2')
      expect(await registry.execute('mcp__x__ping_2', { text: 'x' }, stale)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Unknown tool/) }] })
    })
  })

  it('forTurn omits never tools and unavailable tools, includes MCP tools', async () => {
    mcpTools = [{ ...echo('mcp__srv__search', 'ask'), source: 'mcp', serverId: 's1' }]
    const names = async (inGroup: boolean) => (await registry.forTurn({ bot: ctx().bot, conversation: dm, inGroup })).map((t) => t.name)
    expect(await names(false)).toEqual(['free', 'careful', 'mcp__srv__search'])
    expect(await names(true)).toEqual(['free', 'careful', 'group_only', 'mcp__srv__search'])
  })

  it('runs always tools without asking and validates input', async () => {
    expect(await registry.execute('free', { text: 'hi' }, ctx())).toEqual({ content: [{ type: 'text', text: 'echo: hi' }] })
    const bad = await registry.execute('free', { text: 5 }, ctx())
    expect(bad.isError).toBe(true)
    expect((bad.content[0] as { text: string }).text).toContain('Invalid input')
    expect((await registry.execute('nope', {}, ctx())).isError).toBe(true)
    expect(await registry.execute('off', { text: 'x' }, ctx())).toMatchObject({ isError: true, outcome: 'denied' })
    expect((await registry.execute('group_only', { text: 'x' }, ctx())).isError).toBe(true)
    expect(bus.of('conv:entry')).toEqual([])
  })

  it('ask: posts a card, allow_once runs it and asks again next time', async () => {
    const run = registry.execute('careful', { text: 'hi' }, ctx())
    await answer('allow_once')
    expect(await run).toEqual({ content: [{ type: 'text', text: 'echo: hi' }] })
    const card = store.entries.get(lastApproval().id)!
    expect(card.approval).toMatchObject({ status: 'resolved', decision: 'allow_once', toolName: 'careful', summary: 'Echo hi' })
    expect(card.author).toEqual({ kind: 'bot', botId: bot.id })

    const again = registry.execute('careful', { text: 'again' }, ctx())
    await answer('allow_once')
    await again
    expect(bus.of('conv:entry').filter((e) => e.entry.approval?.status === 'pending')).toHaveLength(2)
  })

  it('ask: always saves the bot override, so the next call runs without a card', async () => {
    const run = registry.execute('careful', { text: 'hi' }, ctx())
    await answer('always')
    await run
    expect(store.bots.get(bot.id)!.toolPermissions).toEqual({ careful: 'always' })
    const cards = bus.of('conv:entry').length
    // ctx carries a stale bot (no override); the registry reads the fresh one.
    expect((await registry.execute('careful', { text: 'x' }, { ...ctx(), bot })).isError).toBeUndefined()
    expect(bus.of('conv:entry').length).toBe(cards)
  })

  it('ask: deny returns an error; never also hides the tool from later turns', async () => {
    const denied = registry.execute('careful', { text: 'hi' }, ctx())
    await answer('deny')
    expect(await denied).toMatchObject({ isError: true, outcome: 'denied' })
    expect(store.bots.get(bot.id)!.toolPermissions).toEqual({})

    const never = registry.execute('careful', { text: 'hi' }, ctx())
    await answer('never')
    expect((await never).isError).toBe(true)
    expect(store.bots.get(bot.id)!.toolPermissions).toEqual({ careful: 'never' })
    expect((await registry.forTurn({ bot: ctx().bot, conversation: dm, inGroup: false })).map((t) => t.name)).not.toContain('careful')
  })

  it('ask: stopping the turn expires the card and returns Cancelled', async () => {
    const controller = new AbortController()
    const run = registry.execute('careful', { text: 'hi' }, ctx({ signal: controller.signal }))
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    const result = await run
    expect(result).toMatchObject({ isError: true, outcome: 'cancelled', content: [{ text: 'Cancelled.' }] })
    expect(store.entries.get(lastApproval().id)!.approval!.status).toBe('expired')
  })

  it('autoAllow skips the card but never still wins', async () => {
    registry.register(echo('maybe', 'ask', { autoAllow: (input) => input.text === 'safe' }))
    expect((await registry.execute('maybe', { text: 'safe' }, ctx())).isError).toBeUndefined()
    expect(bus.of('conv:entry')).toEqual([])
    registry.setPermission('maybe', 'never', bot.id)
    expect((await registry.execute('maybe', { text: 'safe' }, ctx())).isError).toBe(true)
  })

  it('redacts secrets from results and approval cards, and truncates long output', async () => {
    redacted.set('hunter2-secret', 'PASSWORD')
    registry.register(echo('leaky', 'always', { execute: async () => textResult('pw=hunter2-secret') }))
    registry.register(echo('huge', 'always', { execute: async () => textResult('a'.repeat(50_000) + 'THE END') }))
    expect(await registry.execute('leaky', { text: '' }, ctx())).toEqual({ content: [{ type: 'text', text: 'pw=«secret:PASSWORD»' }] })

    const huge = (await registry.execute('huge', { text: '' }, ctx())).content[0] as { text: string }
    expect(huge.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS)
    expect(huge.text).toContain('characters omitted')
    expect(huge.text.endsWith('THE END')).toBe(true)

    const run = registry.execute('careful', { text: 'hunter2-secret' }, ctx())
    await answer('deny')
    await run
    const card = lastApproval().approval!
    expect(card.summary).toBe('Echo «secret:PASSWORD»')
    expect(card.input).toEqual({ text: '«secret:PASSWORD»' })
  })

  it('keeps many text blocks together within the 30k budget', async () => {
    registry.register(echo('chatty', 'always', {
      execute: async () => ({ content: Array.from({ length: 500 }, (_, i) => ({ type: 'text' as const, text: `${i} ${'z'.repeat(1000)}` })) })
    }))
    const result = await registry.execute('chatty', { text: '' }, ctx())
    const texts = result.content.map((c) => (c.type === 'text' ? c.text : ''))
    expect(texts.join('').length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 100)
    expect(texts.at(-1)).toMatch(/^\[… \d+ more text blocks omitted\]$/)
  })

  it('turns thrown tool errors into error results', async () => {
    registry.register(echo('boom', 'always', { execute: async () => { throw new Error('kaput') } }))
    expect(await registry.execute('boom', { text: '' }, ctx())).toMatchObject({ isError: true, content: [{ text: 'boom failed: kaput' }] })
  })

  it('refuses a connector call when the turn carries no connector map (by-name fallback is closed)', async () => {
    mcpTools = [{ ...echo('mcp__srv__ping', 'always'), source: 'mcp', serverId: 's1', remoteName: 'ping' }]
    const result = await registry.execute('mcp__srv__ping', { text: 'x' }, ctx())
    expect(result).toMatchObject({
      isError: true,
      outcome: 'denied',
      content: [{ text: expect.stringMatching(/no verifiable connector grant/) }]
    })
    expect(bus.of('conv:entry')).toEqual([]) // never executed, never asked for approval
  })
})

describe('truncateText', () => {
  it('keeps head and tail within the limit', () => {
    const out = truncateText(`${'h'.repeat(1000)}${'t'.repeat(1000)}`, 500)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out.startsWith('hhh')).toBe(true)
    expect(out.endsWith('ttt')).toBe(true)
    expect(truncateText('short', 500)).toBe('short')
  })
})

describe('ApprovalService', () => {
  let store: PlatformStore
  let bus: ReturnType<typeof fakeBus>

  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/tmp' })
    bus = fakeBus()
  })
  afterEach(() => store.close())

  it('mirrors exchange cards into the root conversation; either card resolves both', async () => {
    const approvals = createApprovalService({ store, bus })
    const a = store.bots.create({ name: 'A' })
    const b = store.bots.create({ name: 'B' })
    const root = store.conversations.create({ kind: 'dm', title: '', botIds: [a.id] })
    const ex1 = store.conversations.create({ kind: 'exchange', title: '', botIds: [a.id, b.id], origin: { conversationId: root.id, entryId: 'e', fromBotId: a.id } })
    const c = store.bots.create({ name: 'C' })
    const ex2 = store.conversations.create({ kind: 'exchange', title: '', botIds: [b.id, c.id], origin: { conversationId: ex1.id, entryId: 'e2', fromBotId: b.id } })

    const pending = approvals.request({
      ctx: { bot: c, conversation: ex2, turnId: 't', callId: 'k', signal: new AbortController().signal, chain: [a.id, b.id], inGroup: false, workspaceDir: '/w' },
      toolName: 'shell',
      summary: 'Run `ls`',
      toolInput: { command: 'ls' }
    })
    const cards = bus.of('conv:entry').map((e) => e.entry)
    expect(cards.map((e) => e.conversationId)).toEqual([ex2.id, root.id])
    expect(cards[0]!.approval!.approvalId).toBe(cards[1]!.approval!.approvalId)
    expect(store.conversations.get(root.id)!.unreadCount).toBe(1)

    approvals.resolve(cards[1]!.approval!.approvalId, 'allow_once')
    expect(await pending).toBe('allow_once')
    for (const card of cards) expect(store.entries.get(card.id)!.approval).toMatchObject({ status: 'resolved', decision: 'allow_once' })
  })

  it('tells subscribers when a card is posted and settled', async () => {
    const approvals = createApprovalService({ store, bus })
    const a = store.bots.create({ name: 'A' })
    const conv = store.conversations.create({ kind: 'dm', title: '', botIds: [a.id] })
    const events: string[] = []
    const off = approvals.subscribe((e) => events.push(`${e.state}:${e.toolName}:${e.ctx.bot.id === a.id}`))
    const ctx = { bot: a, conversation: conv, turnId: 't', callId: 'c', signal: new AbortController().signal, chain: [], inGroup: false, workspaceDir: '/w' }
    const first = approvals.request({ ctx, toolName: 'shell', summary: 's', toolInput: {} })
    approvals.resolve(bus.of('conv:entry').at(-1)!.entry.approval!.approvalId, 'deny')
    await first
    const controller = new AbortController()
    const second = approvals.request({ ctx: { ...ctx, signal: controller.signal }, toolName: 'write_file', summary: 's', toolInput: {} })
    controller.abort()
    await second
    off()
    await approvals.request({ ctx: { ...ctx, signal: AbortSignal.abort() }, toolName: 'x', summary: 's', toolInput: {} })
    expect(events).toEqual(['pending:shell:true', 'resolved:shell:true', 'pending:write_file:true', 'expired:write_file:true'])
  })

  it('expires cards left pending by a previous run', () => {
    const a = store.bots.create({ name: 'A' })
    const conv = store.conversations.create({ kind: 'dm', title: '', botIds: [a.id] })
    const old = store.entries.append({
      conversationId: conv.id, kind: 'approval', author: { kind: 'bot', botId: a.id }, text: 'x', mentions: [],
      mentionsEveryone: false, attachments: [], isStreaming: false,
      approval: { approvalId: 'old', toolName: 'shell', summary: 'x', input: {}, status: 'pending' }
    })
    const approvals = createApprovalService({ store, bus })
    expect(store.entries.get(old.id)!.approval!.status).toBe('expired')
    // Resolving a card nobody waits for is harmless.
    expect(() => approvals.resolve('old', 'allow_once')).not.toThrow()
  })
})
