import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexOptions, Input, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot, Entry } from '@shared/domain'
import { createCodexEngine, type CodexLike } from './codex-engine'
import { createHarness, type Harness } from './testing/fakes'

interface CodexRun {
  options: CodexOptions
  resumed?: string
  threadOptions?: ThreadOptions
  input?: Input
}

/** A stand-in for the Codex SDK: each turn plays the next list of events. */
type Turn = ThreadEvent[] | (() => AsyncGenerator<ThreadEvent>)
function fakeCodex(turns: Turn[]) {
  const runs: CodexRun[] = []
  const make = (options: CodexOptions): CodexLike => {
    const run: CodexRun = { options }
    runs.push(run)
    const thread = {
      async runStreamed(input: Input) {
        run.input = input
        const events = turns.shift() ?? []
        return {
          events: typeof events === 'function'
            ? events()
            : (async function* () {
                yield* events
              })()
        }
      }
    }
    return {
      startThread(threadOptions) {
        run.threadOptions = threadOptions
        return thread
      },
      resumeThread(id, threadOptions) {
        run.resumed = id
        run.threadOptions = threadOptions
        return thread
      }
    }
  }
  return { make, runs }
}

const agentMessage = (id: string, text: string, stage: 'item.updated' | 'item.completed' = 'item.completed'): ThreadEvent => ({
  type: stage,
  item: { id, type: 'agent_message', text }
})

describe('Codex engine', () => {
  let h: Harness
  let fake: ReturnType<typeof fakeCodex>
  let bot: Bot
  let savedKey: string | undefined
  let diskProfile: string | undefined

  const setup = (turns: Turn[], botExtra: Partial<Bot> = {}, apiKey?: string) => {
    fake = fakeCodex(turns)
    h = createHarness({
      diskProfile,
      engines: (services, providers) => ({
        codex: createCodexEngine({ store: services.store, bridge: services.bridge, providers, codex: fake.make })
      })
    })
    const provider = h.providers.save({ kind: 'codex', label: 'Codex', defaultModelId: '', enabled: true, ...(apiKey && { apiKey }) })
    bot = h.services.store.bots.create({ name: 'Builder', soul: 'You ship small, tested changes.', model: { providerId: provider.id, modelId: 'default' }, ...botExtra })
    return h.runtime.openDm(bot.id)
  }

  beforeEach(() => {
    savedKey = process.env['OPENAI_API_KEY']
    process.env['OPENAI_API_KEY'] = 'sk-should-not-leak'
  })
  afterEach(async () => {
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY']
    else process.env['OPENAI_API_KEY'] = savedKey
    await h.runtime.shutdown()
    h.cleanup()
    if (diskProfile) rmSync(diskProfile, { recursive: true, force: true })
    diskProfile = undefined
  })

  const entries = (conversationId: string): Entry[] => h.services.store.entries.page(conversationId, { limit: 100 }).entries

  it('starts a thread in the bot’s workspace, sandboxed, with FaiBots tools through the bridge', async () => {
    const dm = setup([
      [
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started' },
        { type: 'item.started', item: { id: 'cmd1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } },
        { type: 'item.completed', item: { id: 'cmd1', type: 'command_execution', command: 'ls', aggregated_output: 'README.md', exit_code: 0, status: 'completed' } },
        agentMessage('m1', 'Your folder has a README', 'item.updated'),
        agentMessage('m1', 'Your folder has a README.'),
        { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 9, reasoning_output_tokens: 0 } }
      ],
      [agentMessage('m2', 'Second.'), { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }]
    ])
    await h.send(dm.id, 'what is in my folder?')

    const run = fake.runs[0]!
    expect(run.resumed).toBeUndefined()
    expect(run.threadOptions).toEqual({
      workingDirectory: join(h.services.store.settings.get().workspaceRoot, 'builder'),
      skipGitRepoCheck: true,
      // shell defaults to ask, and Codex cannot ask: read-only until the user says Always.
      sandboxMode: 'read-only',
      approvalPolicy: 'never'
    })
    // Our prompt goes before the first message of the thread.
    expect(typeof run.input === 'string' && run.input).toMatch(/You ship small, tested changes\.[\s\S]*---\n\n\[Alex\] what is in my folder\?$/)
    expect(run.options.configOverrides).toEqual([
      'mcp_servers={ faibots = { url = "http://127.0.0.1:1/mcp", bearer_token_env_var = "FAIBOTS_BRIDGE_TOKEN", tool_timeout_sec = 1800, tools = { read_file = { approval_mode = "approve" }, write_file = { approval_mode = "approve" }, send_to_agent = { approval_mode = "approve" }, list_bots = { approval_mode = "approve" }, create_bot = { approval_mode = "approve" }, pass_turn = { approval_mode = "approve" }, assign_to_agent = { approval_mode = "approve" }, assignment_status = { approval_mode = "approve" }, wait_for_assignment = { approval_mode = "approve" }, cancel_assignment = { approval_mode = "approve" }, group_work_snapshot = { approval_mode = "approve" }, plan_work = { approval_mode = "approve" }, review_work = { approval_mode = "approve" }, read_handoff = { approval_mode = "approve" } } } }',
      'features.apps=false',
      'features.plugins=false',
      'features.skill_mcp_dependency_install=false',
      'web_search="disabled"'
    ])
    expect(run.options.env).toMatchObject({ FAIBOTS_BRIDGE_TOKEN: 'test-token' })
    expect(run.options.env).not.toHaveProperty('OPENAI_API_KEY')
    expect(run.options).not.toHaveProperty('apiKey')
    expect(h.services.bridge.closed).toBe(1)

    expect(entries(dm.id).map((e) => [e.kind, e.text])).toEqual([
      ['message', 'what is in my folder?'],
      ['tool-call', 'Running `ls`'],
      ['message', 'Your folder has a README.']
    ])
    expect(entries(dm.id)[1]!.toolCall).toMatchObject({ toolName: 'shell', status: 'done', resultText: 'README.md\n\nexit code 0' })
    expect(h.services.store.botContext.get(dm.id, bot.id).engineSessionId).toBe('thread-1')

    await h.send(dm.id, 'thanks')
    expect(fake.runs[1]!.resumed).toBe('thread-1')
    expect(fake.runs[1]!.input).toBe('[Alex] thanks')
  })

  const done = (id: string): ThreadEvent[] => [{ type: 'thread.started', thread_id: id }, { type: 'turn.started' }, agentMessage('m', 'ok')]
  const resumedOk: ThreadEvent[] = [{ type: 'turn.started' }, agentMessage('m', 'ok')]
  const UPDATED = /^Updated instructions \(these replace any earlier instructions\)/
  const ctx = (id: string) => h.services.store.botContext.get(id, bot.id)

  // Only the two anonymous thread checkpoints from the real CLI receipt are replayed.
  const counted = (id: string, input: number, output: number): ThreadEvent[] => [
    ...done(id),
    { type: 'turn.completed', usage: { input_tokens: input, output_tokens: output,
      cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } }
  ]
  const usageRows = () => h.services.store.db.prepare(
    'select input_tokens,output_tokens,codex_usage_state from turns order by rowid'
  ).all()

  it('charges the difference between Codex receipts after reopening the database and runtime', async () => {
    diskProfile = mkdtempSync(join(tmpdir(), 'faibots-usage-'))
    const dm = setup([counted('case', 74_811, 471)])
    await h.send(dm.id, 'Draft')
    await h.runtime.shutdown()
    h.cleanup()
    fake = fakeCodex([counted('case', 139_090, 1_086)])
    h = createHarness({ diskProfile, engines: (s, providers) => ({
      codex: createCodexEngine({ store: s.store, bridge: s.bridge, providers, codex: fake.make })
    }) })
    await h.send(dm.id, 'Review')
    expect(fake.runs[0]?.resumed).toBe('case')
    expect(usageRows()).toEqual([
      { input_tokens: 74_811, output_tokens: 471, codex_usage_state: 'measured' },
      { input_tokens: 64_279, output_tokens: 615, codex_usage_state: 'measured' }
    ])
    expect(h.services.store.turns.summary(0, Date.now()+1).rows).toMatchObject([{ inputTokens: 139_090, outputTokens: 1_086 }])
  })

  it('rebaselines after a legacy resume, a counter reset or an unfinished turn, then counts a fresh thread normally', async () => {
    const first = counted('old', 74_811, 471), second = counted('old', 139_090, 1_086)
    const dm = setup([first, second, first, done('old'), second, counted('fresh', 74_811, 471)])
    h.services.store.botContext.set({ ...ctx(dm.id), engineSessionId: 'old' })
    for (const prompt of ['Import', 'Continue', 'Reset counters', 'Interrupted receipt', 'Resume']) await h.send(dm.id, prompt)
    h.services.store.botContext.clearConversation(dm.id)
    await h.send(dm.id, 'Start fresh')
    expect(usageRows().map(r=>[r.codex_usage_state,r.input_tokens,r.output_tokens])).toEqual([
      ['unknown',0,0], ['measured',64_279,615], ['unknown',0,0], ['unknown',0,0], ['unknown',0,0], ['measured',74_811,471]
    ])
    expect(h.services.store.turns.summary(0,Date.now()+1).rows[0]?.unreportedTurns).toBe(4)
  })

  it('resends the system block on a resumed thread only after it changed', async () => {
    const dm = setup([done('t1'), resumedOk, resumedOk, resumedOk])
    await h.send(dm.id, 'one')
    await h.send(dm.id, 'two')
    expect(fake.runs[1]!.input).toBe('[Alex] two')
    h.services.store.bots.update(bot.id, { soul: 'You are now terse.' })
    await h.send(dm.id, 'three')
    const input = fake.runs[2]!.input as string
    expect(fake.runs[2]!.resumed).toBe('t1')
    expect(input).toMatch(UPDATED)
    expect(input).toContain('You are now terse.')
    expect(input).toMatch(/---\n\n\[Alex\] three$/)
    await h.send(dm.id, 'four')
    expect(fake.runs[3]!.input).toBe('[Alex] four')
  })

  it('keeps the old hash when a resumed turn fails before turn.started, so the next turn sends the block', async () => {
    const dm = setup([
      done('t1'),
      [{ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' } }, { type: 'turn.failed', error: { message: 'boom' } }],
      resumedOk,
      resumedOk
    ])
    await h.send(dm.id, 'one')
    const before = ctx(dm.id).systemHash
    expect(before).toBeTruthy()
    h.services.store.bots.update(bot.id, { soul: 'Edited soul.' })
    await h.send(dm.id, 'two')
    expect(fake.runs[1]!.input).toMatch(UPDATED)
    expect(ctx(dm.id).systemHash).toBe(before)
    await h.send(dm.id, 'three')
    expect(fake.runs[2]!.resumed).toBe('t1')
    expect(fake.runs[2]!.input).toMatch(UPDATED)
    await h.send(dm.id, 'four')
    expect(fake.runs[3]!.input).toBe('[Alex] four')
  })

  it('keeps the old hash when a resumed turn is stopped before turn.started', async () => {
    const dm = setup([
      done('t1'),
      async function* () {
        h.runtime.stop(dm.id)
        yield { type: 'turn.started' } as ThreadEvent
      },
      resumedOk,
      resumedOk
    ])
    await h.send(dm.id, 'one')
    const before = ctx(dm.id).systemHash
    h.services.store.bots.update(bot.id, { soul: 'Edited soul.' })
    await h.send(dm.id, 'two')
    expect(fake.runs[1]!.input).toMatch(UPDATED)
    expect(ctx(dm.id).systemHash).toBe(before)
    await h.send(dm.id, 'three')
    expect(fake.runs[2]!.input).toMatch(UPDATED)
    await h.send(dm.id, 'four')
    expect(fake.runs[3]!.input).toBe('[Alex] four')
  })

  it('does not resume a thread made by another engine, and keeps other work state', async () => {
    const dm = setup([done('t2')])
    h.services.store.botContext.set({ ...ctx(dm.id), summary: 'kept', engineSessionId: 'claude-sess', engineBinding: 'claude-code' })
    await h.send(dm.id, 'hi')
    expect(fake.runs[0]!.resumed).toBeUndefined()
    expect(fake.runs[0]!.input as string).toContain('You ship small')
    expect(ctx(dm.id)).toMatchObject({ engineSessionId: 't2', engineBinding: expect.stringMatching(/^codex:/), summary: 'kept' })
  })

  it('does not resume a thread made under another provider', async () => {
    const dm = setup([done('t1'), done('t2')])
    await h.send(dm.id, 'one')
    const other = h.providers.save({ kind: 'codex', label: 'Codex 2', defaultModelId: '', enabled: true })
    h.services.store.bots.update(bot.id, { model: { providerId: other.id, modelId: 'default' } })
    await h.send(dm.id, 'two')
    expect(fake.runs[1]!.resumed).toBeUndefined()
    expect(fake.runs[1]!.input as string).toContain('You ship small')
    expect(ctx(dm.id).engineSessionId).toBe('t2')
  })

  it('resumes a thread with no binding and records the binding', async () => {
    const dm = setup([resumedOk])
    h.services.store.botContext.set({ ...ctx(dm.id), engineSessionId: 'old' })
    await h.send(dm.id, 'hi')
    expect(fake.runs[0]!.resumed).toBe('old')
    expect(ctx(dm.id).engineBinding).toMatch(/^codex:/)
  })

  it('keeps the thread when the model changes within Codex', async () => {
    const dm = setup([done('t1'), resumedOk])
    await h.send(dm.id, 'one')
    h.services.store.bots.update(bot.id, { model: { providerId: bot.model.providerId, modelId: 'other-model' } })
    await h.send(dm.id, 'two')
    expect(fake.runs[1]!.resumed).toBe('t1')
  })

  it('uses a read-only sandbox when the bot may never run commands, and a stored key when there is one', async () => {
    const dm = setup([[agentMessage('m', 'ok')]], { toolPermissions: { shell: 'never' } }, 'sk-codex-key')
    await h.send(dm.id, 'look around')
    expect(fake.runs[0]!.threadOptions?.sandboxMode).toBe('read-only')
    expect(fake.runs[0]!.options.apiKey).toBe('sk-codex-key')
  })

  it('lets Codex write in its workspace only when shell is set to Always', async () => {
    const dm = setup([[agentMessage('m', 'ok')]], { toolPermissions: { shell: 'always' } })
    await h.send(dm.id, 'fix the build')
    expect(fake.runs[0]!.threadOptions?.sandboxMode).toBe('workspace-write')
  })

  it('shows FaiBots tool calls by their own names and reports failures', async () => {
    const dm = setup([
      [
        { type: 'item.started', item: { id: 't1', type: 'mcp_tool_call', server: 'faibots', tool: 'list_bots', arguments: {}, status: 'in_progress' } },
        {
          type: 'item.completed',
          item: { id: 't1', type: 'mcp_tool_call', server: 'faibots', tool: 'list_bots', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: '- @helper' }], structured_content: null } }
        },
        { type: 'turn.failed', error: { message: 'usage limit reached' } }
      ]
    ])
    await h.send(dm.id, 'who is there?')
    const all = entries(dm.id)
    expect(all[1]!.toolCall).toMatchObject({ toolName: 'list_bots', title: 'Looking up the other bots', status: 'done', resultText: '- @helper' })
    expect(all.at(-1)).toMatchObject({ kind: 'event', text: 'Builder could not answer: Codex: usage limit reached' })
  })
})
