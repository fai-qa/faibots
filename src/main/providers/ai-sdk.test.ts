import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'vitest'
import { createAiSdkAdapter } from './ai-sdk'
import type { StepEvents, TurnSpec } from './types'

type Part = Parameters<typeof simulateReadableStream>[0]['chunks'][number]

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 7, text: 7, reasoning: undefined }
}

/** A mock model that replays one scripted stream per call and records each call's options. */
function scriptedModel(streams: Part[][]) {
  const calls: unknown[] = []
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options)
      const chunks = streams.shift()
      if (!chunks) throw new Error('no scripted stream left')
      // The scripted parts follow the LanguageModelV4 stream format.
      return { stream: simulateReadableStream({ chunks }) } as never
    }
  })
  return { model, calls: calls as Array<{ prompt: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string }> }> }
}

const finish = (unified: string): Part => ({ type: 'finish', finishReason: { unified, raw: unified }, usage }) as Part

const spec = (): TurnSpec => ({
  modelId: 'gpt-test',
  system: { stable: 'You are Scout.', volatile: 'Today is Sunday.' },
  messages: [{ role: 'user', content: [{ type: 'text', text: '[Alex] what is in notes.txt?' }] }],
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
})

const recorder = () => {
  const log: string[] = []
  const events: StepEvents = {
    onTextDelta: (d) => log.push(`text:${d}`),
    onTextEnd: () => log.push('end'),
    onThinking: () => log.push('thinking'),
    onToolInputStart: (n) => log.push(`tool:${n}`)
  }
  return { log, events }
}

describe('AI SDK adapter', () => {
  it('runs one model step per call and leaves tool execution to the caller', async () => {
    const { model, calls } = scriptedModel([
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Let me ' },
        { type: 'text-delta', id: 't1', delta: 'look.' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-input-start', id: 'call_1', toolName: 'read_file' },
        { type: 'tool-input-end', id: 'call_1' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: '{"path":"notes.txt"}' },
        finish('tool-calls')
      ],
      [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'It says hello.' },
        { type: 'text-end', id: 't2' },
        finish('stop')
      ]
    ])
    const adapter = createAiSdkAdapter({ kind: 'openai', languageModel: () => model })
    const turn = adapter.startTurn(spec())
    const { log, events } = recorder()

    const step1 = await turn.step(events, new AbortController().signal)
    expect(step1).toEqual({
      stop: 'tool_use',
      text: 'Let me look.',
      toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'notes.txt' } }],
      usage: { inputTokens: 12, outputTokens: 7 }
    })
    expect(log).toEqual(['text:Let me ', 'text:look.', 'end', 'tool:read_file'])

    // The first call got the instructions, our messages and the tool (without running it).
    const first = calls[0]!
    expect(first.prompt[0]).toMatchObject({ role: 'system', content: 'You are Scout.\n\nToday is Sunday.' })
    expect(first.prompt[1]).toMatchObject({ role: 'user', content: [{ type: 'text', text: '[Alex] what is in notes.txt?' }] })
    expect(first.tools?.map((t) => t.name)).toEqual(['read_file'])

    turn.addToolResults([{ call: step1.toolCalls[0]!, result: { content: [{ type: 'text', text: 'hello' }] } }])
    const step2 = await turn.step(events, new AbortController().signal)
    expect(step2).toMatchObject({ stop: 'end', text: 'It says hello.', toolCalls: [] })

    // The second call carries the model's own assistant message and our tool result.
    const second = calls[1]!
    expect(second.prompt.slice(2)).toMatchObject([
      { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool-call', toolCallId: 'call_1', toolName: 'read_file', input: { path: 'notes.txt' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'read_file', output: { type: 'text', value: 'hello' } }] }
    ])
  })

  it('maps length and content filter stops, and sends errors as error results', async () => {
    const { model, calls } = scriptedModel([
      [
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'cut' },
        { type: 'text-end', id: 't' },
        finish('length')
      ],
      [{ type: 'tool-call', toolCallId: 'c', toolName: 'read_file', input: '{"path":"x"}' }, finish('tool-calls')],
      [finish('content-filter')]
    ])
    const adapter = createAiSdkAdapter({ kind: 'google', languageModel: () => model })
    const { events } = recorder()
    expect(await adapter.startTurn(spec()).step(events, new AbortController().signal)).toMatchObject({ stop: 'max_tokens', text: 'cut' })

    const turn = adapter.startTurn(spec())
    const step = await turn.step(events, new AbortController().signal)
    turn.addToolResults([{ call: step.toolCalls[0]!, result: { content: [{ type: 'text', text: 'denied' }], isError: true } }])
    expect(await turn.step(events, new AbortController().signal)).toMatchObject({ stop: 'refusal' })
    expect(calls[2]!.prompt.at(-1)).toMatchObject({ role: 'tool', content: [{ output: { type: 'error-text', value: 'denied' } }] })
  })

  it('flags tool calls it could not parse', async () => {
    const { model } = scriptedModel([[{ type: 'tool-call', toolCallId: 'c', toolName: 'read_file', input: '{not json' }, finish('tool-calls')]])
    const step = await createAiSdkAdapter({ kind: 'xai', languageModel: () => model }).startTurn(spec()).step(recorder().events, new AbortController().signal)
    expect(step.stop).toBe('tool_use')
    expect(step.toolCalls[0]).toMatchObject({ id: 'c', name: 'read_file', inputError: expect.any(String) })
  })

  it('turns provider errors into readable messages', async () => {
    const { model } = scriptedModel([[{ type: 'error', error: new Error('upstream exploded') }]])
    const adapter = createAiSdkAdapter({ kind: 'openai-compatible', languageModel: () => model })
    await expect(adapter.startTurn(spec()).step(recorder().events, new AbortController().signal)).rejects.toThrow(/The model server returned an error: upstream exploded/)
  })
})
