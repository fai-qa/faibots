import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolResult } from '../contracts'
import { createDelegationRepo } from '../store/delegations'
import { createHarness, type Harness } from './testing/fakes'

describe('durable send_to_agent', () => {
  let h: Harness
  beforeEach(() => {
    h = createHarness()
    for (const tool of h.runtime.assignments.tools()) h.services.tools.register(tool)
  })
  afterEach(async () => { await h.runtime.shutdown(); h.cleanup() })

  const output = (result: ToolResult) => result.content.map((part) => part.type === 'text' ? part.text : '').join('')

  it('keeps the chief chat responsive, reports nested room work, and delivers only one final result', async () => {
    const chief = h.bot('fai', { isPrimary: true })
    const colleague = h.bot('Colleague')
    h.bot('Editor')
    h.bot('Reviewer')
    const group = h.group([chief, colleague], { turnPolicy: 'mentions', maxRounds: 1 })
    const dm = h.runtime.openDm(chief.id)
    const requests: string[] = []
    let release!: () => void
    const gate = new Promise<void>((ready) => { release = ready })
    h.engine.script('fai', async (api) => {
      const incoming = h.engine.turns.at(-1)!.newTexts.join(' ')
      if (incoming.includes('start here')) {
        const result = output(await api.tool('assign_to_agent', { to: 'editor', message: 'Ask the reviewer' }))
        requests.push(result)
        api.say('I assigned the work.')
      } else {
        const result = await api.tool('group_work_snapshot', {})
        api.say(output(result))
      }
    }).script('editor', async (api) => {
      await api.tool('send_to_agent', { to: 'reviewer', message: 'Check the date.' })
      api.say('The date is correct.')
    }).script('reviewer', async (api) => { await gate; api.say('Checked.') })
    const send = (conversationId: string, text: string) => h.runtime.send({
      conversationId, text, mentions: [chief.id], mentionsEveryone: false, attachmentPaths: [], clientNonce: text
    })
    try {
      await send(group.id, '@fai start here')
      await vi.waitFor(() => expect(requests[0]).toMatch(/Assignment [a-f\d]{64} is running/))
      await vi.waitFor(() => expect(h.engine.turns.filter((turn) => turn.handle === 'reviewer')).toHaveLength(1))
      await send(group.id, '@fai progress please')
      await vi.waitFor(() => expect(h.transcript(group.id).some((line) => line.includes('Pending: 2'))).toBe(true))
      const id = /Assignment ([a-f\d]{64})/.exec(requests[0]!)![1]!
      const denied = await h.services.tools.execute('assignment_status', { id }, { bot: chief, conversation: dm,
        chain: [], signal: new AbortController().signal, callId: 'lookup', turnId: 'other-chat', inGroup: false, workspaceDir: '' })
      expect(output(denied)).toMatch(/No background assignment/)
      const records = h.services.store.db.prepare('select * from assignment_admissions order by parent_assignment_id').all()
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ assignment_id: id, root_conversation_id: group.id, parent_assignment_id: null })
      expect(records[1]).toMatchObject({ root_turn_id: records[0]!.root_turn_id, parent_assignment_id: id })
    } finally { release() }
    await h.runtime.idle()
    const results = () => h.services.store.entries.since(group.id, 0).filter((entry) => entry.clientNonce?.startsWith('faibots:assignment-result:'))
    expect(results()).toHaveLength(1)
    expect(results()[0]!.text).toContain('The date is correct.')
    createDelegationRepo(h.services.store.db, h.services.store.entries).recover()
    expect(results()).toHaveLength(1)
  })

  it('checks the current send permission and the requested specialist skills before async admission', async () => {
    const chief = h.bot('fai', { isPrimary: true })
    h.bot('Editor')
    const dm = h.runtime.openDm(chief.id)
    const replies: string[] = []
    h.engine.script('fai', async (api) => {
      replies.push(output(await api.tool('assign_to_agent', { to: 'editor', message: 'Do a check', requiredSkills: ['missing-skill'] })))
    })
    await h.send(dm.id, 'Ask')
    expect(replies[0]).toMatch(/skill missing-skill unavailable/)
    h.services.tools.setPermission('send_to_agent', 'never', chief.id)
    await h.send(dm.id, 'Ask again')
    expect(replies[1]).toMatch(/turned off/)
    expect(h.services.store.db.prepare('select count(*) n from delegations').get()?.n).toBe(0)
    expect(h.engine.turns.some((turn) => turn.handle === 'editor')).toBe(false)
  })

  it('cancels only the named child, preserving the sibling result and returning the original ID', async () => {
    const chief = h.bot('fai', { isPrimary: true })
    h.bot('Slow')
    h.bot('Fast')
    const dm = h.runtime.openDm(chief.id)
    let slowId = ''
    let fastId = ''
    let cancel = ''
    let wait = ''
    h.engine.script('slow', async (api) => { await api.untilAborted() })
      .script('fast', (api) => api.say('Finished already.'))
      .script('fai', async (api) => {
        const assign = async (to: string) => /Assignment ([a-f\d]{64})/.exec(output(await api.tool('assign_to_agent', { to, message: 'Check this' })))![1]!
        slowId = await assign('slow')
        fastId = await assign('fast')
        wait = output(await api.tool('wait_for_assignment', { id: fastId, seconds: 2 }))
        cancel = output(await api.tool('cancel_assignment', { id: slowId }))
      })
    await h.send(dm.id, 'Assign both')
    expect(wait).toContain(fastId + ' · answered')
    expect(cancel).toContain(slowId + ': reconciliation_required')
    const repo = createDelegationRepo(h.services.store.db, h.services.store.entries)
    expect(repo.get(slowId)).toMatchObject({ state: 'reconciliation_required' })
    expect(repo.get(fastId)).toMatchObject({ state: 'answered', receipt: { text: 'Finished already.' } })
    expect(h.services.store.entries.since(dm.id, 0).filter((entry) => entry.clientNonce?.startsWith('faibots:assignment-result:'))).toHaveLength(2)
  })

  it('refuses a spent root budget even through a fresh repository instance', () => {
    const { db, entries } = h.services.store
    const first = createDelegationRepo(db, entries)
    const root = { turnId: 'root', conversationId: 'group' }
    expect(first.reserve('parent', root, 2)).toBe(true)
    expect(first.reserve('child', { ...root, parentAssignmentId: 'parent' }, 2)).toBe(true)
    const reopened = createDelegationRepo(db, entries)
    expect(reopened.reserve('another-child', { ...root, parentAssignmentId: 'child' }, 2)).toBe(false)
    expect(reopened.reserve('unrelated', { ...root, turnId: 'other-root' }, 2)).toBe(true)
  })

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
