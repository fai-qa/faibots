import { join } from 'node:path'
import type { CanUseTool, Options, SDKMessage, query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot, Entry } from '@shared/domain'
import { createClaudeCodeEngine, DECLINED_MESSAGE, connectorToolNames } from './claude-code-engine'
import { createHarness, type Harness } from './testing/fakes'

type Script = (params: { prompt: string; options: Options }) => AsyncGenerator<SDKMessage>

/** A stand-in for the Agent SDK's query(): each call runs the next script. */
function fakeQuery(scripts: Script[]) {
  const calls: { prompt: string; options: Options }[] = []
  const query = ((params: { prompt: string; options: Options }) => {
    calls.push(params)
    const script = scripts.shift()
    if (!script) throw new Error('no scripted query left')
    return Object.assign(script(params), { close: () => {} })
  }) as unknown as typeof claudeQuery
  return { query, calls }
}

const sdk = (msg: object) => msg as SDKMessage
const init = (session: string) => sdk({ type: 'system', subtype: 'init', session_id: session, apiKeySource: 'none' })
const result = (session: string, extra: object = {}) =>
  sdk({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    session_id: session,
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    ...extra
  })
function* streamText(text: string, messageId = 'msg_1'): Generator<SDKMessage> {
  const ev = (event: object) => sdk({ type: 'stream_event', parent_tool_use_id: null, event })
  yield ev({ type: 'message_start', message: { id: messageId } })
  yield ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  yield ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  yield ev({ type: 'content_block_stop', index: 0 })
  yield sdk({ type: 'assistant', parent_tool_use_id: null, message: { id: messageId, content: [{ type: 'text', text }] } })
}

describe('Claude Code engine', () => {
  let h: Harness
  let fake: ReturnType<typeof fakeQuery>
  let bot: Bot
  let savedKey: string | undefined

  const setup = (scripts: Script[], botExtra: Partial<Bot> = {}) => {
    fake = fakeQuery(scripts)
    h = createHarness({
      engines: (services) => ({
        'claude-code': createClaudeCodeEngine({
          store: services.store,
          bridge: services.bridge,
          approvals: services.approvals,
          tools: services.tools,
          secrets: services.secrets,
          query: fake.query
        })
      })
    })
    const provider = h.providers.save({ kind: 'claude-code', label: 'Claude Code', defaultModelId: '', enabled: true })
    bot = h.services.store.bots.create({ name: 'Coder', soul: 'You write careful code.', model: { providerId: provider.id, modelId: 'default' }, ...botExtra })
    return h.runtime.openDm(bot.id)
  }

  beforeEach(() => {
    savedKey = process.env['ANTHROPIC_API_KEY']
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-should-not-leak'
  })
  afterEach(async () => {
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY']
    else process.env['ANTHROPIC_API_KEY'] = savedKey
    await h.runtime.shutdown()
    h.cleanup()
  })

  const entries = (conversationId: string): Entry[] => h.services.store.entries.page(conversationId, { limit: 100 }).entries

  it('runs a turn on the user’s Claude Code login, in the bot’s workspace, and keeps the session', async () => {
    const dm = setup([
      async function* () {
        yield init('sess-1')
        yield* streamText('Hello, I am Coder.')
        yield result('sess-1')
      },
      async function* () {
        yield* streamText('Second answer.', 'msg_2')
        yield result('sess-1')
      }
    ])
    await h.send(dm.id, 'hi there')

    expect(h.transcript(dm.id)).toEqual(['you: hi there', 'coder: Hello, I am Coder.'])
    const { prompt, options } = fake.calls[0]!
    expect(prompt).toBe('[Alex] hi there')
    expect(options.cwd).toBe(join(h.services.store.settings.get().workspaceRoot, 'coder'))
    expect(options.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code', append: expect.stringContaining('You write careful code.') })
    expect(options.settingSources).toEqual([])
    expect(options.permissionMode).toBe('default')
    expect(options.includePartialMessages).toBe(true)
    expect(options).not.toHaveProperty('model')
    expect(options).not.toHaveProperty('resume')
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(options.env).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    expect(options.mcpServers?.['faibots']).toMatchObject({ type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer test-token' } })
    expect(options.allowedTools).toEqual(['mcp__faibots', 'mcp__connectors'])
    expect(h.services.bridge.opened).toBe(1)
    expect(h.services.bridge.closed).toBe(1)
    expect(h.services.store.botContext.get(dm.id, bot.id).engineSessionId).toBe('sess-1')

    await h.send(dm.id, 'and again')
    expect(fake.calls[1]!.options.resume).toBe('sess-1')
    expect(fake.calls[1]!.prompt).toBe('[Alex] and again')
    expect(h.transcript(dm.id).at(-1)).toBe('coder: Second answer.')
  })

  it('shows tool calls as cards, FaiBots tools by their own names', async () => {
    const dm = setup([
      async function* () {
        yield init('s')
        yield sdk({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            id: 'm1',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'mcp__faibots__list_bots', input: {} },
              { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'npm test' } }
            ]
          }
        })
        yield sdk({
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '- @helper: Helper' }] },
              { type: 'tool_result', tool_use_id: 'tu_2', content: DECLINED_MESSAGE, is_error: true }
            ]
          }
        })
        yield* streamText('Done.', 'm2')
        yield result('s')
      }
    ])
    await h.send(dm.id, 'check')
    const cards = entries(dm.id).filter((e) => e.kind === 'tool-call')
    expect(cards.map((c) => [c.toolCall?.toolName, c.toolCall?.title, c.toolCall?.status])).toEqual([
      ['list_bots', 'Looking up the other bots', 'done'],
      ['Bash', 'Running `npm test`', 'denied']
    ])
  })

  it('routes Claude Code’s permission prompts to FaiBots approvals and permissions', async () => {
    const decisions: Record<string, unknown> = {}
    let gate!: CanUseTool
    const dm = setup([
      async function* ({ options }) {
        gate = options.canUseTool!
        const signal = new AbortController().signal
        const workspace = options.cwd!
        decisions['faibots'] = await gate('mcp__faibots__update_memory', {}, { signal, toolUseID: 'a', requestId: 'r1' })
        decisions['inside'] = await gate('Write', { file_path: join(workspace, 'notes.md'), content: 'x' }, { signal, toolUseID: 'b', requestId: 'r2' })
        decisions['bash'] = await gate('Bash', { command: 'rm -rf build' }, { signal, toolUseID: 'c', requestId: 'r3' })
        decisions['bashAgain'] = await gate('Bash', { command: 'ls' }, { signal, toolUseID: 'd', requestId: 'r4' })
        yield init('s')
        yield result('s')
      }
    ])
    // Answer the first Bash card with "Always": the second Bash call then runs without a card.
    const answered = (async () => {
      for (let i = 0; i < 200; i++) {
        const card = h.services.bus.of('conv:entry').find((e) => e.entry.kind === 'approval')
        if (card) {
          h.services.approvals.resolve(card.entry.approval!.approvalId, 'always')
          return card.entry
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error('no approval card')
    })()
    await h.send(dm.id, 'clean up')
    const card = await answered

    expect(decisions['faibots']).toMatchObject({ behavior: 'allow' })
    expect(decisions['inside']).toMatchObject({ behavior: 'allow' })
    expect(card.approval).toMatchObject({ toolName: 'shell', summary: 'Run `rm -rf build`' })
    expect(decisions['bash']).toMatchObject({ behavior: 'allow' })
    expect(decisions['bashAgain']).toMatchObject({ behavior: 'allow' })
    expect(h.services.bus.of('conv:entry').filter((e) => e.entry.kind === 'approval' && e.entry.approval?.status === 'pending')).toHaveLength(1)
    expect(h.services.store.bots.get(bot.id)!.toolPermissions).toEqual({ shell: 'always' })
  })

  it('gates Claude Code’s own read-only tools through a PreToolUse hook (outside the workspace asks)', async () => {
    const outputs: Record<string, unknown> = {}
    let options!: Options
    const dm = setup([
      async function* (params) {
        options = params.options
        const hook = options.hooks!.PreToolUse![0]!.hooks[0]!
        const signal = new AbortController().signal
        const call = (tool_name: string, tool_input: object, id: string) =>
          hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: options.cwd! } as never, id, { signal })
        outputs['readInside'] = await call('Read', { file_path: join(options.cwd!, 'notes.md') }, 'a')
        outputs['readOutside'] = await call('Read', { file_path: '/etc/passwd' }, 'b')
        outputs['webLocal'] = await call('WebFetch', { url: 'http://127.0.0.1:8080/admin', prompt: 'x' }, 'c')
        outputs['todo'] = await call('TodoWrite', { todos: [] }, 'd')
        outputs['own'] = await call('mcp__faibots__list_bots', {}, 'e')
        yield init('s')
        yield result('s')
      }
    ])
    const answered = (async () => {
      for (let i = 0; i < 200; i++) {
        const card = h.services.bus.of('conv:entry').find((e) => e.entry.kind === 'approval')
        if (card) {
          h.services.approvals.resolve(card.entry.approval!.approvalId, 'deny')
          return card.entry
        }
        await new Promise((r) => setTimeout(r, 5))
      }
      throw new Error('no approval card')
    })()
    await h.send(dm.id, 'look around')
    const card = await answered

    const decision = (o: unknown) => (o as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision
    expect(decision(outputs['readInside'])).toBe('allow')
    expect(card.approval).toMatchObject({ toolName: 'read_file', summary: 'Read /etc/passwd' })
    expect(decision(outputs['readOutside'])).toBe('deny')
    expect(decision(outputs['webLocal'])).toBe('deny')
    expect(outputs['webLocal']).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringMatching(/private network/) } })
    expect(outputs['todo']).toEqual({})
    expect(outputs['own']).toEqual({})
    // Only the outside read asked.
    expect(h.services.bus.of('conv:entry').filter((e) => e.entry.kind === 'approval' && e.entry.approval?.status === 'pending')).toHaveLength(1)
    expect(options.maxTurns).toBe(50)
  })

  it('lets the turn read its own attachment files, but not the rest of the shared attachment folder', async () => {
    const outputs: Record<string, unknown> = {}
    const store = '/data/attachments'
    const dm = setup([
      async function* ({ options }) {
        const hook = options.hooks!.PreToolUse![0]!.hooks[0]!
        const signal = new AbortController().signal
        const call = (tool_name: string, tool_input: object, id: string) =>
          hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: options.cwd! } as never, id, { signal })
        outputs['own'] = await call('Read', { file_path: `${store}/aaa-report.pdf` }, 'a')
        outputs['other'] = await call('Read', { file_path: `${store}/bbb-someone-elses.pdf` }, 'b')
        outputs['folder'] = await call('Glob', { pattern: '*', path: store }, 'c')
        yield init('s')
        yield result('s')
      }
    ])
    h.services.store.entries.append({
      conversationId: dm.id, kind: 'message', author: { kind: 'user' }, text: 'see attached', mentions: [], mentionsEveryone: false,
      attachments: [{ id: 'att', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 3, path: `${store}/aaa-report.pdf` }],
      isStreaming: false
    })
    const answered = (async () => {
      let answeredCards = 0
      for (let i = 0; i < 400 && answeredCards < 2; i++) {
        for (const e of h.services.bus.of('conv:entry')) {
          if (e.entry.kind === 'approval' && e.entry.approval?.status === 'pending') {
            h.services.approvals.resolve(e.entry.approval.approvalId, 'deny')
            answeredCards++
          }
        }
        await new Promise((r) => setTimeout(r, 5))
      }
    })()
    await h.send(dm.id, 'summarise it')
    await answered
    const decision = (o: unknown) => (o as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision
    expect(decision(outputs['own'])).toBe('allow')
    expect(decision(outputs['other'])).toBe('deny')
    expect(decision(outputs['folder'])).toBe('deny')
  })

  it('denies tools the bot may never use, without asking', async () => {
    let decision: unknown
    const dm = setup(
      [
        async function* ({ options }) {
          decision = await options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'r5' })
          yield result('s')
        }
      ],
      { toolPermissions: { shell: 'never' } }
    )
    await h.send(dm.id, 'ls')
    expect(decision).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/turned off/) })
    const question = await gateOf(fake)('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 'q', requestId: 'r6' })
    expect(question).toMatchObject({ behavior: 'deny', message: expect.stringMatching(/in your reply/) })
    expect(h.services.bus.of('conv:entry').some((e) => e.entry.kind === 'approval')).toBe(false)
  })

  it('starts a fresh session with recent history when the stored one is gone', async () => {
    const dm = setup([
      async function* () {
        yield init('old')
        yield* streamText('First.')
        yield result('old')
      },
      async function* () {
        yield result('old', { subtype: 'error_during_execution', is_error: true })
      },
      async function* () {
        yield init('new')
        yield* streamText('Recovered.', 'm3')
        yield result('new')
      }
    ])
    await h.send(dm.id, 'one')
    await h.send(dm.id, 'two')
    expect(fake.calls[1]!.options.resume).toBe('old')
    expect(fake.calls[2]!.options).not.toHaveProperty('resume')
    expect(fake.calls[2]!.prompt).toContain('Earlier in this conversation:\n\n[Alex] one\n\n[Coder (you)] First.')
    expect(fake.calls[2]!.prompt).toContain('New messages:\n\n[Alex] two')
    expect(h.services.store.botContext.get(dm.id, bot.id).engineSessionId).toBe('new')
    expect(h.transcript(dm.id).at(-1)).toBe('coder: Recovered.')
  })

  const ok = (id: string) =>
    async function* () {
      yield init(id)
      yield* streamText('Done.')
      yield result(id)
    }
  const ctx = (id: string) => h.services.store.botContext.get(id, bot.id)

  it('does not offer a session made by another engine, and keeps other work state', async () => {
    const dm = setup([ok('mine')])
    h.services.store.botContext.set({ ...ctx(dm.id), summary: 'kept', engineSessionId: 'foreign', engineBinding: 'codex' })
    await h.send(dm.id, 'hi')
    expect(fake.calls[0]!.options).not.toHaveProperty('resume')
    expect(ctx(dm.id)).toMatchObject({ engineSessionId: 'mine', engineBinding: expect.stringMatching(/^claude-code:/), summary: 'kept' })
  })

  it('resumes a session with no binding and records the binding', async () => {
    const dm = setup([ok('old')])
    h.services.store.botContext.set({ ...ctx(dm.id), engineSessionId: 'old' })
    await h.send(dm.id, 'hi')
    expect(fake.calls[0]!.options.resume).toBe('old')
    expect(ctx(dm.id).engineBinding).toMatch(/^claude-code:/)
  })

  it('does not resume a session made under another provider, and keeps other work state', async () => {
    const dm = setup([ok('s1'), ok('s2')])
    await h.send(dm.id, 'one')
    const other = h.providers.save({ kind: 'claude-code', label: 'Claude Code 2', defaultModelId: '', enabled: true })
    h.services.store.botContext.set({ ...ctx(dm.id), summary: 'kept' })
    h.services.store.bots.update(bot.id, { model: { providerId: other.id, modelId: 'default' } })
    await h.send(dm.id, 'two')
    expect(fake.calls[1]!.options).not.toHaveProperty('resume')
    expect(fake.calls[1]!.prompt).toContain('Earlier in this conversation')
    expect(ctx(dm.id)).toMatchObject({ engineSessionId: 's2', summary: 'kept' })
  })

  it('keeps the session when the model changes within the engine', async () => {
    const dm = setup([ok('s1'), ok('s1')])
    await h.send(dm.id, 'one')
    h.services.store.bots.update(bot.id, { model: { providerId: bot.model.providerId, modelId: 'other-model' } })
    await h.send(dm.id, 'two')
    expect(fake.calls[1]!.options.resume).toBe('s1')
  })

  it('explains login problems', async () => {
    const dm = setup([
      async function* () {
        yield sdk({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'm', content: [] } })
        yield result('s', { is_error: true, result: 'Invalid API key' })
      }
    ])
    await h.send(dm.id, 'hi')
    expect(entries(dm.id).at(-1)!.text).toMatch(/Claude Code could not use your login \(authentication failed\)/)
  })
})

/** The permission gate Claude Code was given in the first query. */
const gateOf = (fake: ReturnType<typeof fakeQuery>) => fake.calls[0]!.options.canUseTool!

describe('connectorToolNames', () => {
  it('keeps Claude Code tool names within 64 characters', () => {
    const tool = (name: string) => ({ name, description: '', inputSchema: {}, source: 'mcp' as const, defaultPermission: 'ask' as const, activityLabel: '', execute: async () => ({ content: [] }) })
    const long = `mcp__${'s'.repeat(20)}__${'t'.repeat(37)}`
    const names = connectorToolNames([tool('mcp__github__create_issue'), tool(long), tool('update_memory')])
    expect([...names.keys()][0]).toBe('github__create_issue')
    const exposed = [...names.keys()][1]!
    expect(`mcp__connectors__${exposed}`.length).toBeLessThanOrEqual(64)
    expect(names.get(exposed)!.name).toBe(long)
    expect(names.size).toBe(2)
  })
})
