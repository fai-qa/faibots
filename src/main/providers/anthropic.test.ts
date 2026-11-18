import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { createAnthropicAdapter, describeAnthropicError, modelSettings, type AnthropicClientLike, type AnthropicStreamLike } from './anthropic'
import type { StepEvents, TurnSpec } from './types'

type Scripted = { events: Anthropic.MessageStreamEvent[]; message: Anthropic.Message }

/** A fake SDK client: records every request and replays scripted responses. */
function fakeClient(responses: Scripted[]) {
  const requests: Anthropic.MessageStreamParams[] = []
  const creates: Anthropic.MessageCreateParamsNonStreaming[] = []
  const signals: (AbortSignal | undefined)[] = []
  const client: AnthropicClientLike = {
    messages: {
      stream(params, options) {
        // Deep copy: the adapter keeps appending to its own message list.
        requests.push(structuredClone(params))
        signals.push(options?.signal)
        const next = responses.shift()
        if (!next) throw new Error('no scripted response left')
        const stream: AnthropicStreamLike = {
          async *[Symbol.asyncIterator]() {
            for (const event of next.events) yield event
          },
          finalMessage: async () => next.message
        }
        return stream
      },
      async create(params) {
        creates.push(structuredClone(params))
        return message([{ type: 'text', text: ' a summary ', citations: null }], 'end_turn')
      }
    }
  }
  return { client, requests, creates, signals }
}

const usage = (): Anthropic.Usage =>
  ({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_creation: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null
  }) as unknown as Anthropic.Usage

function message(content: Anthropic.ContentBlock[], stop: Anthropic.StopReason, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: usage(),
    ...extra
  } as Anthropic.Message
}

/** Stream events for a text block followed by the given extra blocks. */
function textEvents(text: string, toolName?: string): Anthropic.MessageStreamEvent[] {
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, 3) } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(3) } },
    { type: 'content_block_stop', index: 1 }
  ]
  if (toolName) events.push({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: toolName, input: {} } } as never)
  return events as unknown as Anthropic.MessageStreamEvent[]
}

const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' } as Anthropic.ThinkingBlock
const recording = () => {
  const log: string[] = []
  const events: StepEvents = {
    onTextDelta: (d) => log.push(`text:${d}`),
    onTextEnd: () => log.push('end'),
    onThinking: () => log.push('thinking'),
    onToolInputStart: (n) => log.push(`tool:${n}`)
  }
  return { log, events }
}

const spec = (over: Partial<TurnSpec> = {}): TurnSpec => ({
  modelId: 'claude-opus-5-5',
  system: { stable: 'You are Scout.', volatile: '## Your memory\n- likes tea' },
  messages: [
    { role: 'user', content: [{ type: 'text', text: '[Alex] hi' }] },
    { role: 'assistant', text: 'Hello!' },
    { role: 'user', content: [{ type: 'text', text: '[Alex] list files' }, { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }] }
  ],
  tools: [
    { name: 'list_dir', description: 'List a folder', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
  ],
  ...over
})

describe('Anthropic adapter: request shaping', () => {
  it('builds the first request: model, adaptive thinking, effort, caching, tools, no prefill, no tool_choice', async () => {
    const fake = fakeClient([{ events: textEvents('Done.'), message: message([thinking, { type: 'text', text: 'Done.', citations: null }], 'end_turn') }])
    const adapter = createAnthropicAdapter({ client: fake.client })
    const turn = adapter.startTurn(spec())
    const signal = new AbortController().signal
    const { log, events } = recording()
    const result = await turn.step(events, signal)

    const req = fake.requests[0]!
    expect(req.model).toBe('claude-opus-5-5')
    expect(req.max_tokens).toBe(64_000)
    expect(req.thinking).toEqual({ type: 'adaptive' })
    expect(req).not.toHaveProperty('thinking.budget_tokens')
    expect(req.output_config).toEqual({ effort: 'high' })
    expect(req).not.toHaveProperty('tool_choice')
    expect(req).not.toHaveProperty('temperature')
    expect(req.cache_control).toEqual({ type: 'ephemeral' })
    expect(req.system).toEqual([
      { type: 'text', text: 'You are Scout.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '## Your memory\n- likes tea' }
    ])
    expect(req.tools).toEqual([
      { name: 'list_dir', description: 'List a folder', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }
    ])
    expect(req.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '[Alex] hi' }] },
      { role: 'assistant', content: 'Hello!' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Alex] list files' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
        ]
      }
    ])
    expect(req.messages.at(-1)!.role).toBe('user')
    expect(fake.signals[0]).toBe(signal)

    expect(log).toEqual(['thinking', 'thinking', 'text:Don', 'text:e.', 'end'])
    expect(result).toEqual({ stop: 'end', text: 'Done.', toolCalls: [], usage: { inputTokens: 160, outputTokens: 20 } })
  })

  it('echoes the whole assistant response and sends all tool results in one user message', async () => {
    const toolUse = (id: string, path: string) => ({ type: 'tool_use', id, name: 'read_file', input: { path }, caller: { type: 'direct' } }) as unknown as Anthropic.ToolUseBlock
    const first = message([thinking, { type: 'text', text: 'Reading both.', citations: null }, toolUse('toolu_a', 'a.txt'), toolUse('toolu_b', 'b.txt')], 'tool_use')
    const fake = fakeClient([
      { events: textEvents('Reading both.', 'read_file'), message: first },
      { events: textEvents('Both read.'), message: message([{ type: 'text', text: 'Both read.', citations: null }], 'end_turn') }
    ])
    const turn = createAnthropicAdapter({ client: fake.client }).startTurn(spec())
    const { events } = recording()
    const step1 = await turn.step(events, new AbortController().signal)
    expect(step1.stop).toBe('tool_use')
    expect(step1.toolCalls).toEqual([
      { id: 'toolu_a', name: 'read_file', input: { path: 'a.txt' } },
      { id: 'toolu_b', name: 'read_file', input: { path: 'b.txt' } }
    ])

    turn.addToolResults([
      { call: step1.toolCalls[0]!, result: { content: [{ type: 'text', text: 'alpha' }] } },
      { call: step1.toolCalls[1]!, result: { content: [{ type: 'text', text: 'not found' }], isError: true } }
    ])
    await turn.step(events, new AbortController().signal)

    const second = fake.requests[1]!
    // Same system prompt and tools within the turn (keeps the cache and thinking valid).
    expect(second.system).toEqual(fake.requests[0]!.system)
    expect(second.tools).toEqual(fake.requests[0]!.tools)
    expect(second.messages).toHaveLength(5)
    // The assistant turn goes back unchanged, thinking block (with its signature) first.
    expect(second.messages[3]).toEqual({ role: 'assistant', content: first.content })
    expect((second.messages[3]!.content as Anthropic.ContentBlockParam[])[0]).toMatchObject({ type: 'thinking', signature: 'sig-abc' })
    // Both results in ONE user message.
    expect(second.messages[4]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: 'alpha' }] },
        { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'text', text: 'not found' }], is_error: true }
      ]
    })
  })

  it('never runs tools from a refused or truncated reply', async () => {
    const toolUse = { type: 'tool_use', id: 'toolu_x', name: 'read_file', input: { path: 'x' } } as unknown as Anthropic.ToolUseBlock
    const fake = fakeClient([
      {
        events: [],
        message: message([toolUse], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: 'Not allowed' } } as never)
      },
      { events: [], message: message([toolUse], 'max_tokens') }
    ])
    const adapter = createAnthropicAdapter({ client: fake.client })
    const { events } = recording()
    expect(await adapter.startTurn(spec()).step(events, new AbortController().signal)).toMatchObject({
      stop: 'refusal',
      toolCalls: [],
      detail: 'cyber: Not allowed'
    })
    expect(await adapter.startTurn(spec()).step(events, new AbortController().signal)).toMatchObject({ stop: 'max_tokens', toolCalls: [] })
  })

  it('resumes a paused server-side turn by sending it back unchanged', async () => {
    const paused = message([{ type: 'text', text: 'Part one. ', citations: null }], 'pause_turn')
    const fake = fakeClient([
      { events: [], message: paused },
      { events: [], message: message([{ type: 'text', text: 'Part two.', citations: null }], 'end_turn') }
    ])
    const turn = createAnthropicAdapter({ client: fake.client }).startTurn(spec())
    const result = await turn.step(recording().events, new AbortController().signal)
    expect(result.stop).toBe('end')
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[1]!.messages.at(-1)).toEqual({ role: 'assistant', content: paused.content })
  })

  it('never ends on an assistant turn', async () => {
    const fake = fakeClient([{ events: [], message: message([{ type: 'text', text: 'ok', citations: null }], 'end_turn') }])
    const turn = createAnthropicAdapter({ client: fake.client }).startTurn(spec({ messages: [{ role: 'assistant', text: 'I said this last' }] }))
    await turn.step(recording().events, new AbortController().signal)
    expect(fake.requests[0]!.messages).toEqual([
      { role: 'assistant', content: 'I said this last' },
      { role: 'user', content: '(No new messages.)' }
    ])
  })

  it('uses the bot’s effort, clamped to what the model supports', async () => {
    const fake = fakeClient([
      { events: [], message: message([], 'end_turn') },
      { events: [], message: message([], 'end_turn') }
    ])
    const adapter = createAnthropicAdapter({
      client: fake.client,
      capabilities: (id) => (id === 'claude-opus-4-6' ? { adaptiveThinking: true, effortLevels: ['low', 'medium', 'high', 'max'], maxOutputTokens: 32_000 } : undefined)
    })
    await adapter.startTurn(spec({ effort: 'low' })).step(recording().events, new AbortController().signal)
    await adapter.startTurn(spec({ modelId: 'claude-opus-4-6', effort: 'xhigh' })).step(recording().events, new AbortController().signal)
    expect(fake.requests[0]!.output_config).toEqual({ effort: 'low' })
    expect(fake.requests[1]).toMatchObject({ output_config: { effort: 'high' }, max_tokens: 32_000, thinking: { type: 'adaptive' } })
  })

  it('complete(): one plain request at low effort, text joined', async () => {
    const fake = fakeClient([])
    const text = await createAnthropicAdapter({ client: fake.client }).complete({
      modelId: 'claude-opus-5-5',
      system: 'Summarise.',
      prompt: 'Lots of messages',
      maxTokens: 8000,
      signal: new AbortController().signal
    })
    expect(text).toBe('a summary')
    expect(fake.creates[0]).toEqual({
      model: 'claude-opus-5-5',
      system: 'Summarise.',
      messages: [{ role: 'user', content: 'Lots of messages' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      max_tokens: 8000
    })
  })
})

describe('modelSettings', () => {
  it('leaves thinking and effort out for models that do not take them', () => {
    expect(modelSettings('claude-3-5-haiku-latest', undefined, undefined)).toEqual({ max_tokens: 8192 })
    expect(modelSettings('claude-sonnet-4-5', undefined, undefined)).toEqual({ max_tokens: 64_000 })
  })
  it('follows the Models API when it knows the model', () => {
    expect(modelSettings('claude-future-1', undefined, { adaptiveThinking: true, effortLevels: ['low', 'high'], maxOutputTokens: 128_000 })).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      max_tokens: 64_000
    })
    expect(modelSettings('claude-opus-5-5', 'max', { adaptiveThinking: true, effortLevels: [] })).toEqual({ thinking: { type: 'adaptive' }, max_tokens: 64_000 })
  })
})

describe('describeAnthropicError', () => {
  it('gives short, safe messages', () => {
    const auth = new Anthropic.AuthenticationError(401, undefined, 'invalid x-api-key', new Headers())
    expect(describeAnthropicError(auth).message).toBe('The Anthropic API key was rejected (401). Check it in Settings → Models.')
    const limited = new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers())
    expect(describeAnthropicError(limited).message).toMatch(/rate limit/)
    const abort = new Anthropic.APIUserAbortError()
    expect(describeAnthropicError(abort)).toBe(abort)
  })
})
