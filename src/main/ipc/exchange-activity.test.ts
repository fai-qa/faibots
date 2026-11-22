import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from '../agent/testing/fakes'
import { openStore } from '../store'
import { exchangeActivityHandlers } from './exchange-activity'

let root: string, h: Harness
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'faibots-exchange-'))
  h = createHarness({ diskProfile: root })
  for (const t of h.runtime.assignments.tools()) h.services.tools.register(t)
})
afterEach(async () => {
  await h.runtime.shutdown()
  h.cleanup()
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 35 })
})

function fixture() {
  const chief = h.bot('fai', { isPrimary: true }),
    editor = h.bot('Alfred'),
    reviewer = h.bot('Brand')
  const chat = h.runtime.openDm(chief.id)
  const { store } = h.services
  const api = exchangeActivityHandlers(store.db, (room, id) => h.runtime.streamingText(room, id))
  const anchors = () =>
    store.db
      .prepare(
        `select p.id,d.state,q.conversation_id as exchange from delegations d
    join entries p on p.id=d.parent_entry_id join entries q on q.id=d.question_id where p.conversation_id=? order by q.rowid`
      )
      .all(chat.id)
      .map((r) => String(r.id))
  const send = (text: string) =>
    h.runtime.send({
      conversationId: chat.id,
      text,
      clientNonce: crypto.randomUUID(),
      mentions: [],
      mentionsEveryone: false,
      attachmentPaths: []
    })
  return { chief, editor, reviewer, chat, store, api, anchors, send }
}

it('reads a live detached exchange and its nested native call, excludes overlapping work, and pages actual messages after reopening', async () => {
  const { chief, editor, reviewer, chat, store, api, anchors, send } = fixture()
  let unlock!: () => void, started!: () => void
  const gate = new Promise<void>((r) => {
      unlock = r
    }),
    live = new Promise<void>((r) => {
      started = r
    })
  let calls = 0
  h.engine
    .script(chief.handle, async (a) => {
      const message = ++calls === 1 ? 'Review the gate.' : 'Unrelated job.'
      await a.tool('assign_to_agent', { to: editor.handle, message })
      a.say('Assigned.')
    })
    .script(editor.handle, async (a) => {
      if (h.engine.turns.at(-1)!.newTexts.includes('Unrelated job.')) {
        a.say('Other answer.')
        return
      }
      await a.tool('send_to_agent', { to: reviewer.handle, message: 'Check the colour.' })
      a.say('Review complete.')
    })
    .script(reviewer.handle, async (a) => {
      a.turn.recorder.textDelta('Verified')
      started()
      await gate
      a.turn.recorder.textDelta(' blue.')
      a.turn.recorder.endText()
    })
  try {
    await send('First job')
    await live
    await send('Second job')
    await vi.waitFor(() => expect(anchors()).toHaveLength(2))
    const [one, two] = anchors(),
      scope = { conversationId: chat.id, entryIds: [one!] }
    // Closing the card never needs access to the actual message bodies.
    store.db.setAuthorizer((action, table, column) =>
      action === constants.SQLITE_READ && table === 'entries' && column === 'text'
        ? constants.SQLITE_DENY : constants.SQLITE_OK)
    const summary = (() => {
      try { return api['conv:exchange-summaries'](scope) }
      finally { store.db.setAuthorizer(null) }
    })()
    expect(summary).toEqual([
      {
        anchorId: one,
        callerId: chief.id,
        botIds: [chief.id, editor.id, reviewer.id],
        messageCount: 3,
        active: true
      }
    ])
    const stream = api['conv:exchange-messages'](scope).messages
    expect(stream.map((m) => m.text)).toEqual(['Review the gate.', 'Check the colour.', 'Verified'])
    expect(stream[2]).toMatchObject({ authorId: reviewer.id, recipientId: editor.id, isStreaming: true })
    expect(stream[0]!.conversationId).not.toBe(stream[1]!.conversationId)
    expect(api['conv:exchange-messages']({ ...scope, entryIds: [two!] }).messages.map((m) => m.text)).toEqual(
      ['Unrelated job.']
    )
  } finally {
    unlock()
  }
  await h.runtime.idle()
  const [one, two] = anchors(),
    scope = { conversationId: chat.id, entryIds: [one!, one!] }
  const all = api['conv:exchange-messages'](scope)
  expect(all.messages.map((m) => m.text)).toEqual([
    'Review the gate.',
    'Check the colour.',
    'Verified blue.',
    'Review complete.'
  ])
  expect(api['conv:exchange-summaries'](scope)).toMatchObject([{ active: false, messageCount: 4 }])
  expect(all.messages.every((m) => !m.isStreaming)).toBe(true)
  const newest = api['conv:exchange-messages']({ ...scope, limit: 2 }),
    older = api['conv:exchange-messages']({ ...scope, before: newest.before, limit: 2 })
  expect([...older.messages, ...newest.messages]).toEqual(all.messages)
  expect(older.before).toBeUndefined()
  const sibling = api['conv:exchange-messages']({ ...scope, entryIds: [two!] })
  expect(api['conv:exchange-messages']({ ...scope, before: sibling.messages[0]!.id }).messages).toEqual([])
  expect(
    api['conv:exchange-messages']({ ...scope, conversationId: h.runtime.openDm(editor.id).id }).messages
  ).toEqual([])
  expect(
    api['conv:exchange-summaries']({ conversationId: chat.id, entryIds: [all.messages[0]!.id] })
  ).toEqual([])
  const returns = store.entries
    .since(chat.id, 0)
    .filter((e) => e.clientNonce?.startsWith('faibots:assignment-result:'))
  expect(returns).toHaveLength(2)
  expect(returns[0]!.text + returns[1]!.text).toContain('Review complete.')
  const reopened = openStore(join(root, 'faibots.db'), { homeDir: root })
  try {
    expect(exchangeActivityHandlers(reopened.db)['conv:exchange-messages'](scope)).toEqual(all)
  } finally {
    reopened.close()
  }
  store.db.prepare("update delegations set state='reconciliation_required' where caller_id=?").run(editor.id)
  store.db.prepare("update delegations set state='failed' where parent_entry_id=?").run(one!)
  expect(api['conv:exchange-summaries'](scope)).toMatchObject([
    { attention: 'reconciliation_required', messageCount: 4 }
  ])
})

it('uses the bridge fallback event and refuses unproven replies for two legacy assignments in one reused exchange', async () => {
  const { chief, editor, chat, store, api, anchors } = fixture()
  let job = 0
  h.engine
    .script(chief.handle, async (a) => {
      if (++job === 1) {
        await h.services.tools.execute(
          'send_to_agent',
          { to: editor.handle, message: 'Bridge question.' },
          { ...a.turn.toolContext, callId: 'independent-bridge-id' }
        )
      } else {
        await a.tool('send_to_agent', { to: editor.handle, message: 'First same-root question.' })
        await a.tool('send_to_agent', { to: editor.handle, message: 'Second same-root question.' })
      }
      a.say('Done.')
    })
    .script(editor.handle, (a) => {
      a.say('Repeated answer.')
      a.say('Second segment.')
    })
  await h.send(chat.id, 'Bridge')
  await h.send(chat.id, 'Repeat')
  const [bridge, one, two] = anchors()
  expect(store.entries.get(bridge!)?.kind).toBe('event')
  expect(store.entries.get(one!)?.kind).toBe('tool-call')
  const scope = { conversationId: chat.id, entryIds: [bridge!, one!, two!] }
  expect(api['conv:exchange-summaries'](scope).map((s) => s.messageCount)).toEqual([3, 3, 3])
  expect(api['conv:exchange-messages'](scope).messages).toHaveLength(9)
  const room = store.conversations.findExchange(chief.id, editor.id)!
  store.db.prepare('update entries set reply_to_id=null where conversation_id=?').run(room.id)
  const summaries = api['conv:exchange-summaries'](scope)
  expect(summaries[0]).toMatchObject({ anchorId: bridge, messageCount: 3 })
  expect(summaries[0]!.incompleteHistory).toBeUndefined()
  expect(summaries.slice(1)).toMatchObject([
    { messageCount: 1, incompleteHistory: true },
    { messageCount: 1, incompleteHistory: true }
  ])
  expect(api['conv:exchange-messages']({ ...scope, entryIds: [one!] }).messages.map((e) => e.text)).toEqual([
    'First same-root question.'
  ])
  expect(store.entries.get(one!)?.toolCall?.resultText).toContain('Repeated answer.')
  const other = store.entries.get(two!)!
  expect(api['conv:exchange-summaries']({ ...scope, conversationId: room.id, entryIds: [other.id] })).toEqual(
    []
  )
  store.db.prepare("update delegations set state='failed' where parent_entry_id=?").run(two!)
  expect(api['conv:exchange-summaries']({ ...scope, entryIds: [two!] })).toMatchObject([
    { attention: 'failed' }
  ])
  expect(() => api['conv:exchange-summaries']({ ...scope, entryIds: Array(101).fill('x') })).toThrow(/100/)
  expect(() => api['conv:exchange-messages']({ ...scope, limit: 101 })).toThrow(/page/)
  // Clearing a sibling's anchor cascades its delegation but preserves its root budget record.
  // The other same-root answer must not become retrospectively attributable to the survivor.
  store.db.prepare('delete from entries where id=?').run(two!)
  expect(api['conv:exchange-summaries']({ ...scope, entryIds: [one!] })).toMatchObject([
    { messageCount: 1, incompleteHistory: true }
  ])
})
