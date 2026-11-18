import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolResult } from '../contracts'
import { findBot } from './collab-tools'
import { createHarness, type Harness } from './testing/fakes'

const text = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

describe('send_to_agent', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness({ runtime: { exchangeTimeoutMs: 200 } })
  })
  afterEach(async () => {
    await h.runtime.shutdown()
    h.cleanup()
  })

  it('opens an exchange, runs the other bot there and returns its reply', async () => {
    const writer = h.bot('Writer')
    const researcher = h.bot('Researcher', { description: 'Finds sources' })
    const dm = h.runtime.openDm(writer.id)
    let result: ToolResult | undefined
    h.engine.script('writer', async (api) => {
      result = await api.tool('send_to_agent', { to: '@researcher', message: 'Three sources on solar adoption, please.' })
      api.say('Got them.')
    })
    h.engine.script('researcher', (api) => api.say('1. IEA 2. IRENA 3. Ember'))

    await h.send(dm.id, 'Write a paragraph on solar adoption with sources')

    expect(result?.isError).toBeUndefined()
    expect(text(result!)).toBe('Researcher (@researcher) replied:\n\n1. IEA 2. IRENA 3. Ember')

    const exchange = h.services.store.conversations.findExchange(writer.id, researcher.id)!
    expect(exchange).toMatchObject({ kind: 'exchange', botIds: [writer.id, researcher.id], title: 'Writer ↔ Researcher' })
    expect(h.transcript(exchange.id)).toEqual([
      'writer: Three sources on solar adoption, please.',
      'researcher: 1. IEA 2. IRENA 3. Ember'
    ])

    // The researcher's turn ran in the exchange, with the writer waiting in the chain.
    const researcherTurn = h.engine.turns.find((t) => t.handle === 'researcher')!
    expect(researcherTurn).toMatchObject({ conversationId: exchange.id, chain: [writer.id], inGroup: false })

    // The card in the dm links to the exchange; the exchange remembers where it was opened.
    const card = h.services.store.entries.page(dm.id, { limit: 20 }).entries.find((e) => e.kind === 'tool-call')!
    expect(card.toolCall).toMatchObject({
      toolName: 'send_to_agent',
      status: 'done',
      title: 'Messaged Researcher',
      exchangeConversationId: exchange.id
    })
    expect(exchange.origin).toEqual({ conversationId: dm.id, entryId: card.id, fromBotId: writer.id })
    expect(h.transcript(dm.id).at(-1)).toBe('writer: Got them.')
    // While waiting, the writer's activity named the bot it was asking.
    expect(h.services.bus.of('bot:state').some((s) => s.state.activity === 'Messaging Researcher')).toBe(true)
  })

  it('reuses the exchange between the same two bots', async () => {
    const a = h.bot('Alpha')
    const b = h.bot('Beta')
    const dm = h.runtime.openDm(a.id)
    h.engine.script('alpha', async (api) => {
      await api.tool('send_to_agent', { to: 'beta', message: 'ping' })
    })
    h.engine.script('beta', (api) => api.say('pong'))
    await h.send(dm.id, 'one')
    await h.send(dm.id, 'two')
    const exchanges = h.services.store.conversations.list().filter((c) => c.kind === 'exchange')
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0]!.botIds).toEqual([a.id, b.id])
    expect(h.transcript(exchanges[0]!.id)).toEqual(['alpha: ping', 'beta: pong', 'alpha: ping', 'beta: pong'])
  })

  it('rejects a loop back to a bot that is already waiting', async () => {
    const a = h.bot('Alpha')
    h.bot('Beta')
    const dm = h.runtime.openDm(a.id)
    let loop: ToolResult | undefined
    h.engine.script('alpha', async (api) => {
      await api.tool('send_to_agent', { to: '@beta', message: 'help' })
    })
    h.engine.script('beta', async (api) => {
      loop = await api.tool('send_to_agent', { to: '@alpha', message: 'what do you mean?' })
      api.say('Answering without asking back.')
    })
    await h.send(dm.id, 'go')
    expect(loop?.isError).toBe(true)
    expect(text(loop!)).toMatch(/Alpha is already waiting for an answer in this chain \(Alpha → Beta\)/)
  })

  it('stops chains deeper than three bots', async () => {
    const names = ['A1', 'B2', 'C3', 'D4', 'E5']
    const bots = names.map((n) => h.bot(n))
    const dm = h.runtime.openDm(bots[0]!.id)
    const results: Record<string, ToolResult> = {}
    for (let i = 0; i < 4; i++) {
      const next = names[i + 1]!.toLowerCase()
      h.engine.script(names[i]!.toLowerCase(), async (api) => {
        results[names[i]!] = await api.tool('send_to_agent', { to: next, message: `from ${names[i]}` })
        api.say(`${names[i]} done`)
      })
    }
    h.engine.script('e5', (api) => api.say('E5 should never run'))
    await h.send(dm.id, 'start the chain')

    // A1 -> B2 -> C3 -> D4 is three hops; D4 -> E5 would be the fourth.
    expect(results['D4']?.isError).toBe(true)
    expect(text(results['D4']!)).toMatch(/already 3 bots deep/)
    expect(h.engine.turns.map((t) => t.handle)).toEqual(['a1', 'b2', 'c3', 'd4'])
    expect(h.engine.turns.find((t) => t.handle === 'd4')!.chain).toEqual([bots[0]!.id, bots[1]!.id, bots[2]!.id])
    expect(results['A1']?.isError).toBeUndefined()
  })

  it('limits how often bots ask each other: 5 per turn, 12 per chain', async () => {
    const lead = h.bot('Lead')
    h.bot('Helper')
    const dm = h.runtime.openDm(lead.id)
    const results: ToolResult[] = []
    h.engine.script('lead', async (api) => {
      for (let i = 0; i < 7; i++) results.push(await api.tool('send_to_agent', { to: '@helper', message: `question ${i}` }))
      api.say('done')
    })
    h.engine.script('helper', (api) => api.say('answer'))
    await h.send(dm.id, 'ask a lot')
    expect(results.slice(0, 5).every((r) => !r.isError)).toBe(true)
    expect(results[5]).toMatchObject({ isError: true })
    expect(text(results[5]!)).toMatch(/already asked other bots 5 times/)

    // Fan-out: each asked bot asks again; the shared chain budget stops it at 12 asks in total.
    const fan = h.bot('Fan')
    const a = h.bot('Aa')
    const b = h.bot('Bb')
    let asks = 0
    let refused = 0
    const askEach = async (api: { tool: (n: string, i: unknown) => Promise<ToolResult>; say: (t: string) => void }, targets: string[]) => {
      for (const to of targets) {
        const r = await api.tool('send_to_agent', { to, message: 'help' })
        if (r.isError && /12 times/.test(text(r))) refused++
        else if (!r.isError) asks++
      }
      api.say('ok')
    }
    h.engine.script('fan', (api) => askEach(api, ['@aa', '@bb', '@aa', '@bb', '@aa']))
    h.engine.script('aa', (api) => askEach(api, ['@bb', '@bb', '@bb']))
    h.engine.script('bb', (api) => api.say('leaf'))
    await h.send(h.runtime.openDm(fan.id).id, 'fan out')
    expect(asks + refused).toBeGreaterThan(12)
    expect(asks).toBeLessThanOrEqual(12)
    expect(refused).toBeGreaterThan(0)
    void a
    void b
  })

  it('times out when the other bot does not answer', async () => {
    const a = h.bot('Alpha')
    h.bot('Slow')
    const dm = h.runtime.openDm(a.id)
    let result: ToolResult | undefined
    h.engine.script('alpha', async (api) => {
      result = await api.tool('send_to_agent', { to: 'slow', message: 'take your time' })
    })
    h.engine.script('slow', (api) => api.untilAborted())
    await h.send(dm.id, 'go')
    expect(result?.isError).toBe(true)
    expect(text(result!)).toMatch(/Slow did not answer within/)
  })

  it('returns an error with the reason and labelled partial text when the child writes then fails', async () => {
    const writer = h.bot('Writer')
    const researcher = h.bot('Researcher')
    const dm = h.runtime.openDm(writer.id)
    let result: ToolResult | undefined
    h.engine.script('writer', async (api) => {
      result = await api.tool('send_to_agent', { to: '@researcher', message: 'Sources?' })
    })
    h.engine.script('researcher', (api) => {
      api.say('1. IEA and then')
      throw new Error('provider fell over')
    })
    await h.send(dm.id, 'go')
    expect(result?.isError).toBe(true)
    const t = text(result!)
    expect(t).not.toContain('replied')
    expect(t).toContain('provider fell over')
    expect(t).toMatch(/partial, unfinished/i)
    expect(t).toContain('1. IEA and then')
    const exchange = h.services.store.conversations.findExchange(writer.id, researcher.id)!
    expect(result?.display).toMatchObject({ exchangeConversationId: exchange.id })
  })

  it('keeps the plain failure message when the child errors without text', async () => {
    const writer = h.bot('Writer')
    h.bot('Researcher')
    const dm = h.runtime.openDm(writer.id)
    let result: ToolResult | undefined
    h.engine.script('writer', async (api) => {
      result = await api.tool('send_to_agent', { to: '@researcher', message: 'Sources?' })
    })
    h.engine.script('researcher', () => {
      throw new Error('provider fell over')
    })
    await h.send(dm.id, 'go')
    expect(result?.isError).toBe(true)
    expect(text(result!)).toContain('Researcher could not answer: provider fell over')
    expect(text(result!)).not.toMatch(/partial/i)
  })

  it('keeps the timeout message and labelled partial text when the child wrote before timing out', async () => {
    const a = h.bot('Alpha')
    const slow = h.bot('Slow')
    const dm = h.runtime.openDm(a.id)
    let result: ToolResult | undefined
    h.engine.script('alpha', async (api) => {
      result = await api.tool('send_to_agent', { to: 'slow', message: 'take your time' })
    })
    h.engine.script('slow', async (api) => {
      api.say('half a thought')
      await api.untilAborted()
    })
    await h.send(dm.id, 'go')
    expect(result?.isError).toBe(true)
    const t = text(result!)
    expect(t).toMatch(/Slow did not answer within/)
    expect(t).toMatch(/partial, unfinished/i)
    expect(t).toContain('half a thought')
    const exchange = h.services.store.conversations.findExchange(a.id, slow.id)!
    expect(result?.display).toMatchObject({ exchangeConversationId: exchange.id })
  })

  it('refuses unknown and ambiguous targets, and the bot itself', async () => {
    const a = h.bot('Alpha')
    h.bot('Research Lead')
    h.bot('Research Bot')
    const dm = h.runtime.openDm(a.id)
    const results: ToolResult[] = []
    h.engine.script('alpha', async (api) => {
      results.push(await api.tool('send_to_agent', { to: 'nobody', message: 'x' }))
      results.push(await api.tool('send_to_agent', { to: '@research', message: 'x' }))
      results.push(await api.tool('send_to_agent', { to: '@alpha', message: 'x' }))
    })
    await h.send(dm.id, 'go')
    expect(results.map((r) => r.isError)).toEqual([true, true, true])
    expect(text(results[0]!)).toMatch(/Bots you can ask: @researchlead, @researchbot/)
    expect(text(results[1]!)).toMatch(/no single bot called "@research"/)
    expect(text(results[2]!)).toMatch(/no single bot called "@alpha"/)
  })

  it('stopping cancels the exchange turn but does not certify absence of dispatched effects', async () => {
    const a = h.bot('Alpha')
    h.bot('Beta')
    const dm = h.runtime.openDm(a.id)
    let betaRunning!: () => void
    const running = new Promise<void>((r) => (betaRunning = r))
    let cancelled = false
    h.engine.script('alpha', async (api) => {
      await api.tool('send_to_agent', { to: 'beta', message: 'long job' })
    })
    h.engine.script('beta', async (api) => {
      betaRunning()
      await api.untilAborted()
      cancelled = true
    })
    void h.runtime.send({ conversationId: dm.id, text: 'go', mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: 'n1' })
    await running
    h.runtime.stop(dm.id)
    await h.runtime.idle()
    expect(cancelled).toBe(true)
    const card = h.services.store.entries.page(dm.id, { limit: 20 }).entries.find((e) => e.kind === 'tool-call')!
    expect(card.toolCall?.status).toBe('error')
    expect(card.toolCall?.resultText).toMatch(/outcome is unknown/i)
    expect(h.services.store.actions.get(card.toolCall!.actionId!)?.state).toBe('unknown')
  })
})

describe('list_bots, create_bot, pass_turn', () => {
  let h: Harness
  beforeEach(() => {
    h = createHarness()
  })
  afterEach(async () => {
    await h.runtime.shutdown()
    h.cleanup()
  })

  it('registers the collab tools with their defaults; pass_turn only in groups', async () => {
    const info = await h.services.tools.info()
    const defaults = Object.fromEntries(info.map((t) => [t.name, t.defaultPermission]))
    expect(defaults).toMatchObject({ send_to_agent: 'always', list_bots: 'always', create_bot: 'ask', pass_turn: 'always' })

    const bot = h.bot('Solo')
    const dm = h.runtime.openDm(bot.id)
    const dmTools = (await h.services.tools.forTurn({ bot, conversation: dm, inGroup: false })).map((t) => t.name)
    const groupTools = (await h.services.tools.forTurn({ bot, conversation: dm, inGroup: true })).map((t) => t.name)
    expect(dmTools).not.toContain('pass_turn')
    expect(groupTools).toContain('pass_turn')
    expect(dmTools).toEqual(expect.arrayContaining(['send_to_agent', 'list_bots', 'create_bot']))
  })

  it('list_bots describes the other bots', async () => {
    const a = h.bot('Alpha')
    h.bot('Beta', { label: 'Numbers', description: 'Does the maths', isPrimary: true })
    h.bot('Ghost', { hidden: true })
    const dm = h.runtime.openDm(a.id)
    let result: ToolResult | undefined
    h.engine.script('alpha', async (api) => {
      result = await api.tool('list_bots', {})
    })
    await h.send(dm.id, 'who is around?')
    expect(text(result!)).toBe('- @beta: Beta, Numbers (primary bot). Does the maths')
  })

  it('create_bot asks first and creates nothing when denied', async () => {
    const a = h.bot('Alpha')
    const dm = h.runtime.openDm(a.id)
    let result: ToolResult | undefined
    h.engine.script('alpha', async (api) => {
      result = await api.tool('create_bot', { name: 'Intern', description: 'Helps' })
    })
    const done = h.send(dm.id, 'hire an intern')
    for (let i = 0; i < 50 && !h.services.bus.of('conv:entry').some((e) => e.entry.kind === 'approval'); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const card = h.services.bus.of('conv:entry').find((e) => e.entry.kind === 'approval')!.entry
    expect(card.approval).toMatchObject({ toolName: 'create_bot', summary: 'Create a new bot "Intern": Helps' })
    h.services.approvals.resolve(card.approval!.approvalId, 'deny')
    await done
    expect(result?.isError).toBe(true)
    expect(h.services.store.bots.list().map((b) => b.name)).toEqual(['Alpha'])
    const toolCard = h.services.store.entries.page(dm.id, { limit: 20 }).entries.find((e) => e.kind === 'tool-call')!
    expect(toolCard.toolCall?.status).toBe('denied')
  })
})

describe('findBot', () => {
  const bots = [
    { id: '1', name: 'Research Lead', handle: 'researchlead' },
    { id: '2', name: 'Writer', handle: 'writer' }
  ].map((b) => ({ ...b, label: '', description: '', soul: '' })) as never[]

  it('finds by handle, name, first word and id', () => {
    expect((findBot(bots, '@researchlead') as { id: string } | undefined)?.id).toBe('1')
    expect((findBot(bots, 'Research Lead') as { id: string } | undefined)?.id).toBe('1')
    expect((findBot(bots, 'research') as { id: string } | undefined)?.id).toBe('1')
    expect((findBot(bots, '2') as { id: string } | undefined)?.id).toBe('2')
    expect(findBot(bots, 'nobody')).toBeUndefined()
  })
})
