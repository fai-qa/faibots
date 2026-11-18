import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import type { Entry } from '@shared/domain'
import type { ListedModel } from '../providers/models'
import { ProviderError } from '../providers/types'
import { createNativeEngine, MAX_STEPS } from './native-engine'
import { ScriptedAdapter, callTools, say } from './testing/scripted-adapter'
import { createHarness, type Harness } from './testing/fakes'

describe('native engine', () => {
  let h: Harness
  let adapter: ScriptedAdapter
  let modelInfo: ListedModel | undefined

  const setup = () => {
    adapter = new ScriptedAdapter()
    modelInfo = { id: 'test-model', label: 'Test', supportsTools: true, contextWindow: 200_000 }
    h = createHarness({
      engines: (services, providers) => ({
        native: createNativeEngine({
          store: services.store,
          providers: { adapterFor: () => adapter, modelInfo: async () => modelInfo, resolve: providers.resolve } as never,
          attachments: services.attachments
        })
      })
    })
    return h
  }

  afterEach(async () => {
    await h.runtime.shutdown()
    h.cleanup()
  })

  const entriesOf = (conversationId: string): Entry[] => h.services.store.entries.page(conversationId, { limit: 200 }).entries

  it('runs the tool loop: text, tool call, results back, more text', async () => {
    setup()
    const bot = h.bot('Scout')
    h.bot('Helper', { description: 'Helps' })
    const dm = h.runtime.openDm(bot.id)
    adapter.push(callTools([{ id: 'c1', name: 'list_bots', input: {} }], 'Let me check who is around.'), say('Helper can help.'))

    await h.send(dm.id, 'Who can help me?')

    const entries = entriesOf(dm.id)
    expect(entries.map((e) => [e.kind, e.text])).toEqual([
      ['message', 'Who can help me?'],
      ['message', 'Let me check who is around.'],
      ['tool-call', 'Looking up the other bots'],
      ['message', 'Helper can help.']
    ])
    expect(entries[2]!.toolCall).toMatchObject({ callId: 'c1', toolName: 'list_bots', status: 'done', resultText: '- @helper: Helper. Helps' })
    // Both results of the step went back as one batch.
    expect(adapter.toolResults).toHaveLength(1)
    expect(adapter.toolResults[0]![0]!.result.content).toEqual([{ type: 'text', text: '- @helper: Helper. Helps' }])

    // The model saw the bot's view, ending with a user turn, and a stable, sorted tool list.
    const spec = adapter.specs[0]!
    expect(spec.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '[Alex] Who can help me?' }] }])
    const names = spec.tools.map((t) => t.name)
    expect(names).toEqual([...names].sort())
    expect(names).toContain('send_to_agent')
    expect(names).not.toContain('pass_turn')
    expect(spec.modelId).toBe('test-model')
    expect(spec.system.stable).toMatch(/You are Scout \(@scout\)/)
    // Usage is summed onto the last message.
    expect(entries[3]!.meta).toMatchObject({ inputTokens: 20, outputTokens: 10 })
  })

  it('posts an event when the model declines or runs out of output', async () => {
    setup()
    const bot = h.bot('Careful')
    const dm = h.runtime.openDm(bot.id)
    adapter.push(() => ({ stop: 'refusal', text: '', toolCalls: [], detail: 'cyber' }))
    await h.send(dm.id, 'do something risky')
    expect(entriesOf(dm.id).at(-1)).toMatchObject({ kind: 'event', text: 'Careful (test-model) declined to answer (cyber).' })

    adapter.push((events) => {
      events.onTextDelta('A very long answ')
      return { stop: 'max_tokens', text: 'A very long answ', toolCalls: [] }
    })
    await h.send(dm.id, 'write a novel')
    expect(entriesOf(dm.id).slice(-2).map((e) => [e.kind, e.text])).toEqual([
      ['message', 'A very long answ'],
      ['event', "Careful's reply reached the model's output limit and was cut short."]
    ])
  })

  it(`stops after ${MAX_STEPS} steps`, async () => {
    setup()
    const bot = h.bot('Looper')
    const dm = h.runtime.openDm(bot.id)
    for (let i = 0; i < MAX_STEPS + 5; i++) adapter.push(callTools([{ id: `c${i}`, name: 'list_bots', input: {} }]))
    await h.send(dm.id, 'loop forever')
    expect(adapter.stepsRun).toBe(MAX_STEPS)
    expect(entriesOf(dm.id).at(-1)!.text).toMatch(/stopped after 25 steps/)
  })

  it('pass_turn ends the turn without another model call', async () => {
    setup()
    const ada = h.bot('Ada')
    const bob = h.bot('Bob')
    const room = h.group([ada, bob], { allowBotToBot: false, parallel: false })
    adapter.push(callTools([{ id: 'p1', name: 'pass_turn', input: {} }]), callTools([{ id: 'p2', name: 'pass_turn', input: {} }]))
    await h.send(room.id, 'fyi: the office is closed tomorrow')
    expect(adapter.stepsRun).toBe(2)
    expect(adapter.specs.every((s) => s.tools.some((t) => t.name === 'pass_turn'))).toBe(true)
    const note = adapter.specs[0]!.messages.at(-1)!
    expect(note.role === 'user' && note.content.at(-1)).toMatchObject({ type: 'text', text: expect.stringMatching(/pass_turn/) })
  })

  it('answers unusable tool calls with an error instead of running them', async () => {
    setup()
    const bot = h.bot('Sloppy')
    const dm = h.runtime.openDm(bot.id)
    adapter.push(callTools([{ id: 'bad', name: 'list_bots', input: '{oops', inputError: 'bad JSON' }]), say('Sorry.'))
    await h.send(dm.id, 'hi')
    const result = adapter.toolResults[0]![0]!.result
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Your call to list_bots could not be used: bad JSON' }] })
    expect(entriesOf(dm.id).find((e) => e.kind === 'tool-call')!.toolCall!.status).toBe('error')
  })

  it('compacts older messages into a summary when the history is too long', async () => {
    setup()
    const bot = h.bot('Keeper')
    const dm = h.runtime.openDm(bot.id)
    // 20 earlier messages of ~400 characters.
    for (let i = 0; i < 20; i++) {
      h.services.store.entries.append({
        conversationId: dm.id,
        kind: 'message',
        author: i % 2 ? { kind: 'bot', botId: bot.id } : { kind: 'user' },
        text: `message ${i} ${'x'.repeat(400)}`,
        mentions: [],
        mentionsEveryone: false,
        attachments: [],
        isStreaming: false
      })
    }
    modelInfo = { id: 'test-model', label: 'Test', supportsTools: true, contextWindow: 4_000 }
    adapter.push(say('Noted.'))
    await h.send(dm.id, 'what did we decide?')

    // Summarised with the bot's own model, keeping the newest 12 message entries verbatim.
    expect(adapter.completes).toHaveLength(1)
    expect(adapter.completes[0]).toMatchObject({ modelId: 'test-model' })
    expect(adapter.completes[0]!.prompt).toContain('message 0')
    expect(adapter.completes[0]!.prompt).not.toContain('message 9 ')
    const context = h.services.store.botContext.get(dm.id, bot.id)
    expect(context.summary).toBe(adapter.summary)
    expect(context.summarizedUpToSeq).toBe(9)
    const first = adapter.specs[0]!.messages[0]!
    expect(first.role === 'user' && first.content[0]).toMatchObject({ text: expect.stringContaining(adapter.summary) })
  })

  it('never advances past messages the summary did not include, and later compactions cover them', async () => {
    setup()
    const bot = h.bot('Keeper')
    const dm = h.runtime.openDm(bot.id)
    // 20 messages of ~1500 chars; window 4000 tokens → input cap 8400 chars (about 5 messages).
    for (let i = 0; i < 20; i++) {
      h.services.store.entries.append({
        conversationId: dm.id, kind: 'message', author: i % 2 ? { kind: 'bot', botId: bot.id } : { kind: 'user' },
        text: `${i === 0 ? 'SENTINEL-PROMISE ' : ''}message ${i} ${'x'.repeat(1500)}`, mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false
      })
    }
    modelInfo = { id: 'test-model', label: 'Test', supportsTools: true, contextWindow: 4_000 }
    adapter.push(say('One.'), say('Two.'), say('Three.'), say('Four.'), say('Five.'))
    await h.send(dm.id, 'status?')
    expect(adapter.completes[0]!.prompt).toContain('SENTINEL-PROMISE')
    const first = h.services.store.botContext.get(dm.id, bot.id).summarizedUpToSeq
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(9)
    // The entries that did not fit are still in the prompt.
    const spec = adapter.specs[0]!.messages
    const text = JSON.stringify(spec)
    expect(text).toContain(`message ${first} `)

    let last = first
    for (let n = 0; n < 4; n++) {
      await h.send(dm.id, `again ${n}`)
      const now = h.services.store.botContext.get(dm.id, bot.id).summarizedUpToSeq
      expect(now).toBeGreaterThanOrEqual(last)
      last = now
    }
    expect(last).toBeGreaterThan(first)
  })

  it('covers and marks a single oversized message so compaction makes progress', async () => {
    setup()
    const bot = h.bot('Keeper')
    const dm = h.runtime.openDm(bot.id)
    for (let i = 0; i < 20; i++) {
      h.services.store.entries.append({
        conversationId: dm.id, kind: 'message', author: i % 2 ? { kind: 'bot', botId: bot.id } : { kind: 'user' },
        text: i === 0 ? `HEAD ${'y'.repeat(20_000)} TAIL` : `message ${i} ${'x'.repeat(400)}`, mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false
      })
    }
    modelInfo = { id: 'test-model', label: 'Test', supportsTools: true, contextWindow: 4_000 }
    adapter.push(say('Ok.'))
    await h.send(dm.id, 'status?')
    const context = h.services.store.botContext.get(dm.id, bot.id)
    expect(context.summarizedUpToSeq).toBeGreaterThanOrEqual(1)
    expect(context.summary).toMatch(/too long to summarize fully/)
    expect(adapter.completes[0]!.prompt).toMatch(/HEAD[\s\S]*characters omitted[\s\S]*TAIL/)
  })

  it('does not retry a failed compaction on every turn', async () => {
    setup()
    const bot = h.bot('Keeper')
    const dm = h.runtime.openDm(bot.id)
    for (let i = 0; i < 20; i++) {
      h.services.store.entries.append({
        conversationId: dm.id, kind: 'message', author: i % 2 ? { kind: 'bot', botId: bot.id } : { kind: 'user' },
        text: `message ${i} ${'x'.repeat(400)}`, mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false
      })
    }
    modelInfo = { id: 'test-model', label: 'Test', supportsTools: true, contextWindow: 4_000 }
    adapter.completeError = new Error('summary model unavailable')
    const warn = console.warn
    console.warn = () => {}
    try {
      adapter.push(say('First.'))
      await h.send(dm.id, 'one')
      adapter.push(say('Second.'))
      await h.send(dm.id, 'two')
    } finally {
      console.warn = warn
    }
    // One failed summary attempt; the second turn went ahead without trying again.
    expect(adapter.completes).toHaveLength(1)
    expect(h.transcript(dm.id).slice(-1)).toEqual(['keeper: Second.'])
  })

  it('compacts harder and retries once when the provider says the prompt is too long', async () => {
    setup()
    const bot = h.bot('Dense')
    const dm = h.runtime.openDm(bot.id)
    for (let i = 0; i < 14; i++) {
      h.services.store.entries.append({
        conversationId: dm.id,
        kind: 'message',
        author: i % 2 ? { kind: 'bot', botId: bot.id } : { kind: 'user' },
        text: `code ${i}`,
        mentions: [],
        mentionsEveryone: false,
        attachments: [],
        isStreaming: false
      })
    }
    adapter.push(() => {
      throw new ProviderError('Anthropic rejected the request (400): prompt is too long: 210000 tokens > 200000 maximum')
    }, say('Fits now.'))
    await h.send(dm.id, 'continue')
    expect(adapter.completes).toHaveLength(1)
    // 15 messages, 6 kept verbatim after the retry.
    expect(h.services.store.botContext.get(dm.id, bot.id).summarizedUpToSeq).toBe(9)
    expect(adapter.specs).toHaveLength(2)
    expect(h.transcript(dm.id).at(-1)).toBe('dense: Fits now.')
  })

  it('does not compact a short history', async () => {
    setup()
    const bot = h.bot('Brief')
    const dm = h.runtime.openDm(bot.id)
    adapter.push(say('Hi.'))
    await h.send(dm.id, 'hello')
    expect(adapter.completes).toHaveLength(0)
    expect(h.services.store.botContext.get(dm.id, bot.id).summarizedUpToSeq).toBe(0)
  })
})

describe('native engine end to end (AI SDK adapter, mock model, no network)', () => {
  it('streams a reply, runs a tool through the registry and answers with its result', async () => {
    const usage = {
      inputTokens: { total: 30, noCache: 30, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 8, text: 8, reasoning: undefined }
    }
    const streams = [
      [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Checking the team.' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'list_bots', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
      ],
      [
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'Ask @helper, it helps.' },
        { type: 'text-end', id: 't2' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
      ]
    ]
    const prompts: unknown[] = []
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        prompts.push(options.prompt)
        return { stream: simulateReadableStream({ chunks: streams.shift()! }) } as never
      }
    })
    const h = createHarness({
      providers: { languageModel: () => () => model },
      engines: (services, providers) => ({ native: createNativeEngine({ store: services.store, providers, attachments: services.attachments }) })
    })
    try {
      const bot = h.bot('Guide')
      h.bot('Helper', { description: 'Helps' })
      const dm = h.runtime.openDm(bot.id)
      await h.send(dm.id, 'who can help?')
      const entries = h.services.store.entries.page(dm.id, { limit: 20 }).entries
      expect(entries.map((e) => [e.kind, e.text])).toEqual([
        ['message', 'who can help?'],
        ['message', 'Checking the team.'],
        ['tool-call', 'Looking up the other bots'],
        ['message', 'Ask @helper, it helps.']
      ])
      // Mentions resolve to conversation members only; Helper is not in this dm.
      expect(entries[3]!.mentions).toEqual([])
      expect(JSON.stringify(prompts[1])).toContain('- @helper: Helper. Helps')
    } finally {
      await h.runtime.shutdown()
      h.cleanup()
    }
  })
})
