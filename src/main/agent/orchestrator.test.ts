import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotPhase } from '@shared/domain'
import { z } from 'zod'
import type { ToolDefinition } from '../contracts'
import { createToolRegistry } from '../tools'
import { defineTool, textResult } from '../tools/define'
import { createRuntime } from './index'
import { createHarness, type Harness, type TurnApi } from './testing/fakes'

describe('orchestrator', () => {
  let h: Harness

  beforeEach(() => {
    h = createHarness()
  })
  afterEach(async () => {
    await h.runtime.shutdown()
    h.cleanup()
  })

  describe('dm', () => {
    it('stores the user message, runs one bot turn and streams its reply', async () => {
      const bot = h.bot('Researcher')
      const dm = h.runtime.openDm(bot.id)
      expect(h.runtime.openDm(bot.id).id).toBe(dm.id)
      h.engine.script('researcher', (api) => api.say('Here is what I found.'))

      await h.send(dm.id, 'Find me three sources')

      expect(h.transcript(dm.id)).toEqual(['you: Find me three sources', 'researcher: Here is what I found.'])
      expect(h.engine.turns).toHaveLength(1)
      expect(h.engine.turns[0]).toMatchObject({ inGroup: false, chain: [], turnNote: '', newTexts: ['Find me three sources'] })

      // Streamed: created empty and streaming, deltas, then finalised.
      const reply = h.services.store.entries.page(dm.id, { limit: 10 }).entries[1]!
      const created = h.services.bus.of('conv:entry').find((e) => e.entry.id === reply.id)!
      expect(created.entry).toMatchObject({ isStreaming: true, text: '' })
      const deltas = h.services.bus.of('conv:delta').filter((d) => d.entryId === reply.id).map((d) => d.textDelta)
      expect(deltas.join('')).toBe('Here is what I found.')
      expect(reply).toMatchObject({ isStreaming: false, meta: { providerId: h.providerId, modelId: 'test-model' } })

      // Live phases: reading -> typing -> idle, and nothing left in the live table.
      const phases = h.services.bus.of('bot:state').map((s) => s.state.phase)
      expect(phases[0]).toBe<BotPhase>('reading')
      expect(phases).toContain<BotPhase>('typing')
      expect(phases[phases.length - 1]).toBe<BotPhase>('idle')
      expect(h.runtime.liveStates()).toEqual([])

      // The bot has now seen the message; conversation unread counts the reply.
      expect(h.services.store.botContext.get(dm.id, bot.id).lastSeenSeq).toBe(1)
      expect(h.services.store.conversations.get(dm.id)!.unreadCount).toBe(1)
      expect(h.services.bus.of('conv:changed').length).toBeGreaterThan(0)
    })

    it('is idempotent on clientNonce', async () => {
      const bot = h.bot('Echo')
      const dm = h.runtime.openDm(bot.id)
      const req = { conversationId: dm.id, text: 'hi', mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: 'same' }
      const first = await h.runtime.send(req)
      const second = await h.runtime.send(req)
      await h.runtime.idle()
      expect(second.id).toBe(first.id)
      expect(h.engine.turns).toHaveLength(1)
    })

    it('explains when the bot has no model', async () => {
      const bot = h.services.store.bots.create({ name: 'Blank', model: { providerId: '', modelId: '' } })
      const dm = h.runtime.openDm(bot.id)
      await h.send(dm.id, 'hello?')
      const events = h.services.store.entries.page(dm.id, { limit: 10 }).entries.filter((e) => e.kind === 'event')
      expect(events.map((e) => e.text)).toEqual(['Blank could not answer: This bot has no model yet. Pick one in its Profile.'])
      expect(h.engine.turns).toHaveLength(0)
    })

    it('turns an engine error into an event line', async () => {
      const bot = h.bot('Fragile')
      const dm = h.runtime.openDm(bot.id)
      h.engine.script('fragile', () => {
        throw new Error('model server is down')
      })
      await h.send(dm.id, 'hi')
      const last = h.services.store.entries.page(dm.id, { limit: 10 }).entries.at(-1)!
      expect(last).toMatchObject({ kind: 'event', text: 'Fragile could not answer: model server is down' })
    })

    it('rejects posts into exchanges', async () => {
      const a = h.bot('Alpha')
      const b = h.bot('Beta')
      const exchange = h.services.store.conversations.create({ kind: 'exchange', title: 'x', botIds: [a.id, b.id] })
      await expect(
        h.runtime.send({ conversationId: exchange.id, text: 'hi', mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: 'n' })
      ).rejects.toThrow(/read-only/)
    })
  })

  describe('group rounds', () => {
    it('open round: every member reads, one answers and one passes', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob])
      h.engine.script('ada', (api) => api.say('Ada here, I can help.'))
      h.engine.script('bob', async (api) => {
        await api.pass()
      })

      await h.send(room.id, 'Who can help with the launch plan?')

      expect(h.transcript(room.id)).toEqual(['you: Who can help with the launch plan?', 'ada: Ada here, I can help.'])
      // Round 1: both. Round 2: only Bob is offered Ada's post (Ada never answers herself); he passes.
      expect(h.engine.turns.map((t) => t.handle)).toEqual(['ada', 'bob', 'bob'])
      expect(h.engine.turns[0]!.turnNote).toMatch(/nobody addressed you/i)
      expect(h.engine.turns[2]!.newTexts).toEqual(['Ada here, I can help.'])
      // Passing leaves nothing in the chat: no message, no tool card, no event line.
      expect(h.services.store.entries.page(room.id, { limit: 50 }).entries.map((e) => e.kind)).toEqual(['message', 'message'])
    })

    it('says so when nobody had anything to add', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob])
      h.engine.otherwise(async (api) => {
        await api.pass()
      })
      await h.send(room.id, 'ok thanks')
      const events = h.services.store.entries.page(room.id, { limit: 50 }).entries.filter((e) => e.kind === 'event')
      expect(events.map((e) => e.text)).toEqual(['No one had anything to add. @mention a bot to ask it directly.'])
    })

    it('a mentioned bot must answer and cannot pass; the others do not run', async () => {
      const ada = h.bot('Ada Lovelace')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob])
      let passResult = ''
      h.engine.script('adalovelace', async (api) => {
        const result = await api.pass()
        passResult = result.content[0]?.type === 'text' ? result.content[0].text : ''
        api.say('Fine, here is my answer.')
      })
      h.engine.script('bob', async (api) => {
        await api.pass()
      })

      await h.send(room.id, '@ada can you check the numbers?')

      // Round 1: only Ada. Round 2: Ada's post is offered to Bob (open policy), who passes.
      expect(h.engine.turns.map((t) => t.handle)).toEqual(['adalovelace', 'bob'])
      expect(h.engine.turns[0]!.turnNote).toMatch(/you were addressed/i)
      expect(passResult).toMatch(/cannot pass/)
      expect(h.transcript(room.id)).toEqual(['you: @ada can you check the numbers?', 'adalovelace: Fine, here is my answer.'])
      const userMessage = h.services.store.entries.page(room.id, { limit: 1, beforeSeq: 2 }).entries[0]!
      expect(userMessage.mentions).toEqual([ada.id])
      expect(h.engine.turns[1]!.turnNote).toMatch(/nobody addressed you/i)
    })

    it('@everyone addresses all members', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob], { allowBotToBot: false })
      await h.send(room.id, 'Status update please @everyone')
      expect(h.engine.turns.map((t) => t.handle).sort()).toEqual(['ada', 'bob'])
      expect(h.engine.turns.every((t) => /addressed/.test(t.turnNote))).toBe(true)
    })

    it('mentions policy: with no mention only the primary bot answers', async () => {
      const ada = h.bot('Ada', { isPrimary: false })
      const bob = h.bot('Bob', { isPrimary: true })
      const room = h.group([ada, bob], { turnPolicy: 'mentions' })
      await h.send(room.id, 'Anyone?')
      expect(h.engine.turns.map((t) => t.handle)).toEqual(['bob'])
    })

    it('a bot post that mentions another bot starts a follow-up round', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const cy = h.bot('Cy')
      const room = h.group([ada, bob, cy], { turnPolicy: 'mentions' })
      h.engine.script('ada', (api) => (api.turn.toolContext.chain.length === 0 && api.turn.turnNote.includes('addressed') ? api.say('@bob what do you think?') : undefined))
      h.engine.script('bob', (api) => api.say('Looks good to me.'))
      h.engine.script('cy', (api) => api.say('Cy should not speak'))

      await h.send(room.id, '@ada draft the plan')

      expect(h.transcript(room.id)).toEqual([
        'you: @ada draft the plan',
        'ada: @bob what do you think?',
        'bob: Looks good to me.',
        // Round 3: Bob's post has no mention, so in mentions policy nobody else runs.
      ])
      expect(h.engine.turns.map((t) => t.handle)).toEqual(['ada', 'bob'])
      const adaPost = h.services.store.entries.page(room.id, { limit: 50 }).entries.find((e) => e.text.startsWith('@bob'))!
      expect(adaPost.mentions).toEqual([bob.id])
    })

    it('stops after maxRounds and flags the last round as winding down', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob], { maxRounds: 3, maxBotPosts: 50 })
      h.engine.otherwise((api) => api.say(`${api.turn.bot.name} again`))

      await h.send(room.id, 'Debate!')

      // Round 1: ada + bob. Round 2: each sees the other's post. Round 3 (last): same.
      expect(h.engine.turns).toHaveLength(6)
      const notes = h.engine.turns.map((t) => t.turnNote)
      expect(notes.slice(0, 4).every((n) => !/last round/.test(n))).toBe(true)
      expect(notes.slice(4).every((n) => /last round/.test(n))).toBe(true)
      expect(h.transcript(room.id)).toHaveLength(1 + 6)
    })

    it('stops at maxBotPosts and says so', async () => {
      const bots = ['Ada', 'Bob', 'Cy'].map((n) => h.bot(n))
      const room = h.group(bots, { maxRounds: 5, maxBotPosts: 2, parallel: false })
      h.engine.otherwise((api) => api.say(`${api.turn.bot.name} speaking`))

      await h.send(room.id, 'Go')

      const posts = h.transcript(room.id).slice(1)
      expect(posts).toEqual(['ada: Ada speaking', 'bob: Bob speaking'])
      const events = h.services.store.entries.page(room.id, { limit: 50 }).entries.filter((e) => e.kind === 'event')
      expect(events.map((e) => e.text)).toEqual(['Reached the limit of 2 bot replies for one message.'])
    })

    it('without allowBotToBot only round 1 runs', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob], { allowBotToBot: false })
      await h.send(room.id, 'Hi all')
      expect(h.engine.turns).toHaveLength(2)
    })

    it('runs turns of a round in parallel when allowed', async () => {
      const bots = ['Ada', 'Bob', 'Cy'].map((n) => h.bot(n))
      const room = h.group(bots, { allowBotToBot: false, parallel: true })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      h.engine.otherwise(async (api) => {
        if (h.engine.running === 3) release()
        await gate
        api.say('done')
      })
      await h.send(room.id, 'everyone at once')
      expect(h.engine.maxRunning).toBe(3)
    })

    it('router policy asks the default model who should answer', async () => {
      const h2 = createHarness({
        providers: {
          languageModel: () => () => routerModel('{"handles": ["bob"]}')
        }
      })
      try {
        const ada = h2.bot('Ada', { description: 'Writes copy' })
        const bob = h2.bot('Bob', { description: 'Does the numbers' })
        h2.services.store.settings.update({ defaultModel: { providerId: h2.providerId, modelId: 'router-model' } })
        const room = h2.group([ada, bob], { turnPolicy: 'router', allowBotToBot: false })
        await h2.send(room.id, 'What is our burn rate?')
        expect(h2.engine.turns.map((t) => t.handle)).toEqual(['bob'])
        expect(h2.engine.turns[0]!.turnNote).toMatch(/addressed/)
      } finally {
        await h2.runtime.shutdown()
        h2.cleanup()
      }
    })

    it('router policy falls back to open when there is no default model', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob], { turnPolicy: 'router', allowBotToBot: false })
      await h.send(room.id, 'hello')
      expect(h.engine.turns.map((t) => t.handle).sort()).toEqual(['ada', 'bob'])
    })

    it('validates groups', () => {
      const bots = Array.from({ length: 9 }, (_, i) => h.bot(`Bot ${i}`))
      expect(() => h.runtime.createGroup({ botIds: bots.map((b) => b.id) })).toThrow(/at most 8/)
      expect(() => h.runtime.createGroup({ botIds: [] })).toThrow(/at least one/)
      const g = h.runtime.createGroup({ botIds: [bots[0]!.id, bots[1]!.id], settings: { maxRounds: 99 } })
      expect(g).toMatchObject({ kind: 'group', title: 'Bot 0, Bot 1', group: { maxRounds: 10, turnPolicy: 'open', maxBotPosts: 8 } })
    })
  })

  describe('stop and queueing', () => {
    it('stop cancels running and queued turns of the conversation', async () => {
      const ada = h.bot('Ada')
      const dm = h.runtime.openDm(ada.id)
      let started!: () => void
      const running = new Promise<void>((r) => (started = r))
      h.engine.script('ada', async (api) => {
        api.turn.recorder.textDelta('Starting a long answer')
        started()
        await api.untilAborted()
      })
      const send = (text: string, n: string) =>
        h.runtime.send({ conversationId: dm.id, text, mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: n })

      await send('first', 'a')
      await running
      await send('second', 'b') // queued behind the first turn
      expect(h.runtime.liveStates().map((s) => s.phase)).toEqual(['typing'])

      h.runtime.stop(dm.id)
      await h.runtime.idle()

      expect(h.engine.turns).toHaveLength(1) // the queued turn never started
      expect(h.runtime.liveStates()).toEqual([])
      const reply = h.services.store.entries.page(dm.id, { limit: 10 }).entries.find((e) => e.author.kind === 'bot')!
      expect(reply).toMatchObject({ isStreaming: false, text: 'Starting a long answer' })

      // After a stop the conversation works again.
      h.engine.script('ada', (api) => api.say('Back.'))
      await h.send(dm.id, 'third')
      expect(h.transcript(dm.id).at(-1)).toBe('ada: Back.')
      // The third turn sees everything it had not seen yet.
      expect(h.engine.turns.at(-1)!.newTexts).toEqual(['second', 'third'])
    })

    it('runs one turn at a time per bot and conversation; the later turn sees the newest messages', async () => {
      const ada = h.bot('Ada')
      const dm = h.runtime.openDm(ada.id)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let calls = 0
      h.engine.script('ada', async (api) => {
        calls++
        if (calls === 1) await gate
        api.say(`reply ${calls}`)
      })
      const send = (text: string, n: string) =>
        h.runtime.send({ conversationId: dm.id, text, mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: n })
      await send('one', '1')
      await send('two', '2')
      await send('three', '3')
      release()
      await h.runtime.idle()

      expect(h.engine.maxRunning).toBe(1)
      // Turn 1 saw "one"; turn 2 saw "two" and "three"; turn 3 had nothing new and was skipped.
      expect(h.engine.turns.map((t) => t.newTexts)).toEqual([['one'], ['two', 'three']])
      expect(h.transcript(dm.id)).toEqual(['you: one', 'you: two', 'you: three', 'ada: reply 1', 'ada: reply 2'])
    })

    it('a new user message supersedes the older cascade after its current round', async () => {
      const ada = h.bot('Ada')
      const bob = h.bot('Bob')
      const room = h.group([ada, bob], { maxRounds: 3, maxBotPosts: 50 })
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let first = true
      h.engine.otherwise(async (api) => {
        if (first) {
          first = false
          await gate
        }
        api.say(`${api.turn.bot.name} says hi`)
      })
      const send = (text: string, n: string) =>
        h.runtime.send({ conversationId: room.id, text, mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: n })
      await send('first message', 'x1')
      await send('second message', 'x2')
      release()
      await h.runtime.idle()
      // Without superseding there would be up to 2 cascades × 3 rounds × 2 bots = 12 turns.
      expect(h.engine.turns.length).toBeLessThan(12)
      expect(h.transcript(room.id).slice(0, 2)).toEqual(['you: first message', 'you: second message'])
    })

    it('reset clears the history and the bots’ context', async () => {
      const ada = h.bot('Ada')
      const dm = h.runtime.openDm(ada.id)
      await h.send(dm.id, 'remember this')
      h.runtime.reset(dm.id)
      expect(h.transcript(dm.id)).toEqual([])
      expect(h.services.store.botContext.get(dm.id, ada.id)).toMatchObject({ lastSeenSeq: 0, summary: '' })
    })
  })

  describe('robustness', () => {
    it('closes entries a crash left streaming or running', async () => {
      const ada = h.bot('Ada')
      const dm = h.runtime.openDm(ada.id)
      const base = { conversationId: dm.id, author: { kind: 'bot' as const, botId: ada.id }, mentions: [], mentionsEveryone: false, attachments: [] }
      const half = h.services.store.entries.append({ ...base, kind: 'message', text: 'half an ans', isStreaming: true })
      const card = h.services.store.entries.append({
        ...base,
        kind: 'tool-call',
        text: 'Running a command',
        isStreaming: false,
        toolCall: { callId: 'c', toolName: 'shell', title: 'Running a command', input: {}, status: 'running' }
      })
      // A new runtime over the same store, as after a restart (with its own tool registry).
      const tools = createToolRegistry({ ...h.services, mcp: { toolsForBot: async () => [], allTools: async () => [] } })
      const engines = { native: h.engine, 'claude-code': h.engine, codex: h.engine }
      const restarted = createRuntime({ ...h.services, tools, providers: h.providers }, { engines })
      expect(h.services.store.entries.get(half.id)!.isStreaming).toBe(false)
      expect(h.services.store.entries.get(card.id)!.toolCall!.status).toBe('cancelled')
      await restarted.shutdown()
    })

    it('a reset during a turn ends it cleanly and does not bring back old engine state', async () => {
      const ada = h.bot('Ada')
      const dm = h.runtime.openDm(ada.id)
      let started!: () => void
      const running = new Promise<void>((r) => (started = r))
      h.engine.script('ada', async (api) => {
        api.turn.recorder.textDelta('Working on it')
        started()
        await api.untilAborted()
        api.turn.saveContext({ engineSessionId: 'stale-session' })
        api.turn.recorder.textDelta(' (late text)')
      })
      void h.runtime.send({ conversationId: dm.id, text: 'go', mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: 'r1' })
      await running
      h.runtime.reset(dm.id)
      await h.runtime.idle()
      expect(h.services.store.botContext.get(dm.id, ada.id).engineSessionId).toBeUndefined()
      expect(h.runtime.liveStates()).toEqual([])
    })

    it('a bot deleted in the middle of its turn does not break anything', async () => {
      const ada = h.bot('Ada')
      const dm = h.runtime.openDm(ada.id)
      h.engine.script('ada', async (api) => {
        h.services.store.bots.delete(ada.id) // its dm goes with it
        api.say('Still talking?')
        await api.tool('list_bots', {})
      })
      await h.send(dm.id, 'hello')
      expect(h.services.store.conversations.get(dm.id)).toBeUndefined()
      expect(h.runtime.liveStates()).toEqual([])
    })

    it('in an open round a bot without a model sits out quietly and catches up later', async () => {
      const ada = h.bot('Ada')
      const blank = h.services.store.bots.create({ name: 'Blank', model: { providerId: '', modelId: '' } })
      const room = h.group([ada, blank], { allowBotToBot: false, parallel: false })
      await h.send(room.id, 'first')
      const events = h.services.store.entries.page(room.id, { limit: 20 }).entries.filter((e) => e.kind === 'event')
      expect(events).toEqual([])
      expect(h.services.store.botContext.get(room.id, blank.id).lastSeenSeq).toBe(0)

      h.services.store.bots.update(blank.id, { model: { providerId: h.providerId, modelId: '' } })
      await h.send(room.id, 'second')
      // Members go in order (not parallel): Ada answers first, then Blank sees everything it missed.
      expect(h.engine.turns.find((t) => t.handle === 'blank')!.newTexts).toEqual(['first', 'Hello from Ada', 'second', 'Hello from Ada'])
    })

    it('two bots asking the same bot at once both get its answer', async () => {
      const a = h.bot('Alpha')
      const b = h.bot('Beta')
      h.bot('Oracle')
      const dmA = h.runtime.openDm(a.id)
      const dmB = h.runtime.openDm(b.id)
      const answers: string[] = []
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const ask = async (api: TurnApi) => {
        const result = await api.tool('send_to_agent', { to: 'oracle', message: `question from ${api.turn.bot.name}` })
        answers.push(result.content[0]?.type === 'text' ? result.content[0].text : '')
      }
      h.engine.script('alpha', ask).script('beta', ask)
      let oracleTurns = 0
      h.engine.script('oracle', async (api) => {
        oracleTurns++
        await gate
        api.say('The answer is 42.')
      })
      const send = (conversationId: string, n: string) =>
        h.runtime.send({ conversationId, text: 'ask the oracle', mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: n })
      await send(dmA.id, 'q1')
      await send(dmB.id, 'q2')
      for (let i = 0; i < 50 && oracleTurns === 0; i++) await new Promise((r) => setTimeout(r, 5))
      // Let the second question land in the exchange before the oracle answers.
      await new Promise((r) => setTimeout(r, 20))
      release()
      await h.runtime.idle()
      expect(answers).toHaveLength(2)
      expect(answers.every((a) => a.endsWith('The answer is 42.'))).toBe(true)
    })

    /** One parent asks the same child twice at once; both questions queue behind a held turn slot, so the
     *  child's first real turn answers both and the second queued turn is skipped. */
    const askTwice = async (oracle: (api: TurnApi) => Promise<void> | void) => {
      const a = h.bot('Alpha')
      const o = h.bot('Oracle')
      const dmA = h.runtime.openDm(a.id)
      const exchange = h.services.store.conversations.create({ kind: 'exchange', title: 'x', botIds: [a.id, o.id] })
      const results: Array<{ isError?: boolean; text: string }> = []
      h.engine.script('alpha', async (api) => {
        const ask = (n: number) => api.tool('send_to_agent', { to: 'oracle', message: `question ${n}` })
        for (const r of await Promise.all([ask(1), ask(2)])) results.push({ isError: r.isError, text: r.content[0]?.type === 'text' ? r.content[0].text : '' })
      })
      h.engine.script('oracle', oracle)
      let release!: () => void
      const hold = new Promise<void>((r) => (release = r))
      const queues = (h.runtime as unknown as { queues: { run(key: string, task: () => Promise<unknown>): Promise<unknown> } }).queues
      void queues.run(`${exchange.id}\u0000${o.id}`, () => hold)
      await h.runtime.send({ conversationId: dmA.id, text: 'ask twice', mentions: [], mentionsEveryone: false, attachmentPaths: [], clientNonce: 'twice' })
      const asked = () => h.services.store.entries.page(exchange.id, { limit: 10 }).entries.filter((e) => e.kind === 'message').length
      for (let i = 0; i < 200 && asked() < 2; i++) await new Promise((r) => setTimeout(r, 5))
      expect(asked()).toBe(2)
      release()
      await h.runtime.idle()
      return results
    }

    it('does not turn a failed turn’s partial text into a success for a second concurrent ask', async () => {
      const results = await askTwice((api) => {
        api.say('Half an answ')
        throw new Error('model fell over')
      })
      expect(results).toHaveLength(2)
      for (const r of results) {
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/could not answer: model fell over/)
        expect(r.text).toContain('Half an answ')
      }
    })

    it('still answers a second concurrent ask from an earlier successful turn', async () => {
      const results = await askTwice((api) => api.say('All done.'))
      expect(results).toHaveLength(2)
      for (const r of results) {
        expect(r.isError).toBeFalsy()
        expect(r.text).toContain('replied:')
        expect(r.text).toContain('All done.')
      }
    })
  })

  describe('production wiring', () => {
    it('stops a connector revoked mid-turn at the next call, through the real registry and turn snapshot', async () => {
      const connector = (serverId: string, label: string): ToolDefinition => ({
        ...defineTool({
          name: `mcp__${serverId}__ping`,
          description: 'Ping',
          schema: z.object({ text: z.string() }),
          source: 'builtin',
          defaultPermission: 'always',
          activityLabel: 'Pinging',
          summarize: () => 'Ping',
          execute: async () => textResult(`ran ${label}`)
        }),
        source: 'mcp',
        serverId,
        remoteName: 'ping'
      })
      const all = [connector('a', 'A'), connector('b', 'B')]
      // Only the McpToolSource is faked: it honours the bot's stored grants like the real host.
      h.services.mcp.toolsForBot = async (b) => all.filter((t) => b.mcpServerIds === 'all' || b.mcpServerIds.includes(t.serverId!))
      const ops = h.bot('Ops')
      h.services.store.bots.update(ops.id, { mcpServerIds: ['a', 'b'] })
      const dm = h.runtime.openDm(ops.id)
      const texts: string[] = []
      let snapshot: unknown
      const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0]?.text ?? ''
      h.engine.script('ops', async (api) => {
        snapshot = api.turn.toolContext.mcpTools?.get('mcp__a__ping')
        texts.push(text(await api.tool('mcp__a__ping', { text: 'x' })))
        h.services.store.bots.update(ops.id, { mcpServerIds: ['b'] })
        texts.push(text(await api.tool('mcp__a__ping', { text: 'x' })))
        texts.push(text(await api.tool('mcp__b__ping', { text: 'x' })))
      })
      await h.send(dm.id, 'go')
      expect(snapshot).toEqual({ serverId: 'a', remoteName: 'ping' })
      expect(texts[0]).toBe('ran A')
      expect(texts[1]).toMatch(/mcp__a__ping is no longer available to this bot.*Do not retry/)
      expect(texts[2]).toBe('ran B')
    })

    it('ends a group turn with exactly maxBotPosts messages and the limit notice (text, tool, text, tool, text)', async () => {
      const ada = h.bot('Ada')
      const room = h.group([ada], { maxRounds: 1, maxBotPosts: 2 })
      h.engine.script('ada', async (api) => {
        api.say('one')
        await api.tool('list_bots', {})
        api.say('two')
        await api.tool('list_bots', {})
        api.say('three')
      })
      await h.send(room.id, 'Go')
      expect(h.transcript(room.id).slice(1)).toEqual(['ada: one', 'ada: two'])
      const events = h.services.store.entries.page(room.id, { limit: 50 }).entries.filter((e) => e.kind === 'event')
      expect(events.map((e) => e.text)).toEqual(['Reached the limit of 2 bot replies for one message.'])
    })
  })

  it('shows the waiting phase while an approval card is open', async () => {
    const ada = h.bot('Ada')
    const dm = h.runtime.openDm(ada.id)
    h.engine.script('ada', async (api) => {
      await api.tool('create_bot', { name: 'Helper' })
      api.say('Asked.')
    })
    const done = h.send(dm.id, 'make a helper bot')
    // Wait for the card, then approve it.
    for (let i = 0; i < 50 && !h.services.bus.of('conv:entry').some((e) => e.entry.kind === 'approval'); i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(h.runtime.liveStates()).toMatchObject([{ phase: 'waiting', activity: 'Waiting for your approval' }])
    const card = h.services.bus.of('conv:entry').find((e) => e.entry.kind === 'approval')!.entry
    h.services.approvals.resolve(card.approval!.approvalId, 'allow_once')
    await done
    expect(h.services.store.bots.list().map((b) => b.name)).toContain('Helper')
    const phases = h.services.bus.of('bot:state').map((s) => s.state.phase)
    expect(phases.indexOf('waiting')).toBeGreaterThan(-1)
    expect(phases[phases.indexOf('waiting') + 1]).toBe('tool')
  })
})

/** A MockLanguageModelV4 that answers every call with `text`. */
function routerModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined }
      },
      warnings: []
    })
  })
}
