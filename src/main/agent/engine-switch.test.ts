// One conversation whose bot moves between the two external engines: the real engines run over fake
// SDK boundaries and the real orchestrator keeps the saved state between turns.

import type { Input, ThreadEvent } from '@openai/codex-sdk'
import type { Options, SDKMessage, query as claudeQuery } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { createClaudeCodeEngine } from './claude-code-engine'
import { createCodexEngine, type CodexLike } from './codex-engine'
import { createHarness, type Harness } from './testing/fakes'

describe('switching a bot between external engines', () => {
  let h: Harness
  afterEach(async () => {
    await h.runtime.shutdown()
    h.cleanup()
  })

  it('never offers the old engine’s id and includes the history on the new engine', async () => {
    const codexRuns: { resumed?: string; input?: Input }[] = []
    const codex = (): CodexLike => {
      const run: { resumed?: string; input?: Input } = {}
      codexRuns.push(run)
      const thread = {
        async runStreamed(input: Input) {
          run.input = input
          const events: ThreadEvent[] = [
            { type: 'thread.started', thread_id: `cx-${codexRuns.length}` },
            { type: 'turn.started' },
            { type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'from codex' } }
          ]
          return { events: (async function* () { yield* events })() }
        }
      }
      return {
        startThread: () => thread,
        resumeThread(id) {
          run.resumed = id
          return thread
        }
      }
    }
    const claudeCalls: { prompt: string; options: Options }[] = []
    const query = ((params: { prompt: string; options: Options }) => {
      claudeCalls.push(params)
      const gen = (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'cc-1', apiKeySource: 'none' } as unknown as SDKMessage
        yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'a1', content: [{ type: 'text', text: 'from claude' }] } } as unknown as SDKMessage
        yield {
          type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'cc-1',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
        } as unknown as SDKMessage
      })()
      return Object.assign(gen, { close: () => {} })
    }) as unknown as typeof claudeQuery

    h = createHarness({
      engines: (services, providers) => ({
        codex: createCodexEngine({ store: services.store, bridge: services.bridge, providers, codex }),
        'claude-code': createClaudeCodeEngine({
          store: services.store, bridge: services.bridge, approvals: services.approvals, tools: services.tools, secrets: services.secrets, query
        })
      })
    })
    const cx = h.providers.save({ kind: 'codex', label: 'Codex', defaultModelId: '', enabled: true })
    const cc = h.providers.save({ kind: 'claude-code', label: 'Claude Code', defaultModelId: '', enabled: true })
    const bot = h.services.store.bots.create({ name: 'Mover', model: { providerId: cx.id, modelId: 'default' } })
    const dm = h.runtime.openDm(bot.id)
    const saved = () => h.services.store.botContext.get(dm.id, bot.id)

    await h.send(dm.id, 'one')
    expect(saved().engineSessionId).toBe('cx-1')

    h.services.store.bots.update(bot.id, { model: { providerId: cc.id, modelId: 'default' } })
    await h.send(dm.id, 'two')
    expect(claudeCalls[0]!.options).not.toHaveProperty('resume')
    expect(claudeCalls[0]!.prompt).toContain('Earlier in this conversation')
    expect(claudeCalls[0]!.prompt).toContain('from codex')
    expect(saved().engineSessionId).toBe('cc-1')

    h.services.store.bots.update(bot.id, { model: { providerId: cx.id, modelId: 'default' } })
    await h.send(dm.id, 'three')
    expect(codexRuns[1]!.resumed).toBeUndefined()
    expect(typeof codexRuns[1]!.input === 'string' && codexRuns[1]!.input).toContain('from claude')
    expect(saved().engineSessionId).toBe('cx-2')
  })
})
