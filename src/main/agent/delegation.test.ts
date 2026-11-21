import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDelegationRepo } from '../store/delegations'
import { createHarness, type Harness } from './testing/fakes'

describe('durable send_to_agent', () => {
  let h: Harness
  beforeEach(() => { h = createHarness() })
  afterEach(async () => { await h.runtime.shutdown(); h.cleanup() })

  it('returns two concurrent assignments from their own child turns and persists the execution identity', async () => {
    const chief = h.bot('Chief')
    h.bot('Editor')
    const dm = h.runtime.openDm(chief.id)
    const questions = ['Check the title', 'Check the date']
    const answers: string[] = []
    h.engine.script('chief', async (api) => {
      const results = await Promise.all(questions.map((message) => api.tool('send_to_agent', { to: 'editor', message })))
      for (const result of results) answers.push(result.content[0]?.type === 'text' ? result.content[0].text : '')
    }).script('editor', (api) => {
      const childTurn = h.engine.turns.at(-1)!
      expect(childTurn.newTexts).toHaveLength(1)
      api.say(`Checked: ${childTurn.newTexts[0]}`)
    })
    await h.send(dm.id, 'Get both checks')
    expect(answers).toEqual(questions.map((q) => `Editor (@editor) replied:\n\nChecked: ${q}`))
    const rows = h.services.store.db.prepare('select state,engine,system_hash,lease,delivered_at from delegations').all()
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row).toMatchObject({
      state: 'answered', engine: 'native', system_hash: expect.stringMatching(/^[a-f0-9]{64}$/), lease: null, delivered_at: expect.any(Number)
    })
  })

  it('persists the failed child outcome and labels its partial text separately', async () => {
    const dm = h.runtime.openDm(h.bot('Chief').id)
    h.bot('Editor')
    h.engine.script('chief', async (api) => { await api.tool('send_to_agent', { to: 'editor', message: 'Check the title' }) })
      .script('editor', (api) => { api.say('Started'); throw new Error('Model unavailable') })
    await h.send(dm.id, 'Ask the editor')
    const row = h.services.store.db.prepare('select id,state,receipt from delegations').get()!
    expect(row.state).toBe('failed')
    expect(JSON.parse(String(row.receipt))).toEqual({ text: 'Editor could not answer: Model unavailable', partial: 'Started' })
    expect(h.services.store.actions.get(String(row.id))?.state).toBe('unknown')
  })

  it('recovers a return committed before parent receipt, closes the matching action, and fences any late writer', async () => {
    const store = h.services.store
    const caller = h.bot('Chief')
    const editor = h.bot('Editor')
    const dm = h.runtime.openDm(caller.id)
    const exchange = store.conversations.create({ kind: 'exchange', title: 'Chief and editor', botIds: [caller.id, editor.id] })
    const repo = createDelegationRepo(store.db, store.entries)
    const id = 'fixed-action'
    const claim = store.actions.claim({
      id, botId: caller.id, conversationId: dm.id, toolName: 'send_to_agent', capability: 'local', inputDigest: 'digest'
    }, false)
    if (claim.kind !== 'claimed') throw new Error('Expected action claim')
    store.actions.dispatch(id, claim.record.attempt!)
    const identity = { id, callerId: caller.id, childId: editor.id, parentId: dm.id, inputHash: 'digest' }
    const base = { author: { kind: 'bot' as const, botId: caller.id }, mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false }
    const start = repo.assign(identity, () => ({
      parent: store.entries.append({ ...base, conversationId: dm.id, kind: 'tool-call', text: 'Check', toolCall: {
        callId: 'call', actionId: id, toolName: 'send_to_agent', title: 'Check', input: {}, status: 'running'
      } }),
      question: store.entries.append({ ...base, conversationId: exchange.id, kind: 'message', text: 'Check' })
    }))
    if (!start.lease) throw new Error('Expected a new assignment')
    const neverDispatch = (): never => { throw new Error('Duplicate dispatch') }
    expect(repo.assign(identity, neverDispatch).existing?.state).toBe('assigned')
    expect(() => repo.assign({ ...identity, childId: caller.id }, neverDispatch)).toThrow(/identity/)
    expect(() => repo.finish({ id, token: 'stale' }, 'answered', { text: 'wrong' })).toThrow(/lease/)
    repo.finish(start.lease, 'answered', { text: 'Checked' })
    expect(store.actions.get(id)?.state).toBe('dispatched')
    repo.recover()
    repo.recover()
    expect(store.entries.get(start.parent.id)?.toolCall).toMatchObject({ status: 'done', resultText: expect.stringContaining('Checked'), exchangeConversationId: exchange.id })
    expect(store.actions.get(id)).toMatchObject({ state: 'completed', receipt: { content: [{ type: 'text', text: expect.stringContaining('Checked') }] } })
    expect(repo.assign(identity, neverDispatch).existing?.receipt).toEqual({ text: 'Checked' })
    expect(() => repo.finish(start.lease, 'failed', { text: 'late' })).toThrow(/lease/)
    expect(store.entries.page(dm.id, { limit: 10 }).entries).toHaveLength(1)
    store.entries.clear(dm.id)
    repo.recover()
    expect(repo.get(id)).toBeUndefined()
    expect(store.entries.page(dm.id, { limit: 10 }).entries).toHaveLength(0)
  })
})
