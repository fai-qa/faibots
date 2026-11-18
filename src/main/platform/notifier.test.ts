import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Entry } from '@shared/domain'
import { openStore, type PlatformStore } from '../store'
import { createNotifier } from './notifier'

describe('notifier', () => {
  let store: PlatformStore
  let focused: boolean
  let shown: { title: string; body: string; urgent: boolean; conversationId: string }[]
  let notifier: ReturnType<typeof createNotifier>

  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/tmp' })
    focused = false
    shown = []
    notifier = createNotifier({ store, isWindowFocused: () => focused, show: (n) => shown.push(n) })
  })
  afterEach(() => store.close())

  const reply = (conversationId: string, botId: string, text: string, isStreaming = false): Entry => ({
    id: Math.random().toString(), conversationId, seq: 1, kind: 'message', author: { kind: 'bot', botId }, text,
    mentions: [], mentionsEveryone: false, attachments: [], isStreaming, createdAt: 0, updatedAt: 0
  })
  const phase = (conversationId: string, botId: string, p: 'thinking' | 'typing' | 'idle') =>
    notifier.onEvent('bot:state', { state: { botId, conversationId, phase: p, updatedAt: 0 } })

  it('notifies once when a bot finishes a reply while the window is unfocused', () => {
    const bot = store.bots.create({ name: 'Researcher' })
    const dm = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
    phase(dm.id, bot.id, 'thinking')
    notifier.onEvent('conv:entry', { entry: reply(dm.id, bot.id, 'partial', true) })
    notifier.onEvent('conv:entry', { entry: reply(dm.id, bot.id, '**Found** three sources') })
    phase(dm.id, bot.id, 'idle')
    phase(dm.id, bot.id, 'idle')
    expect(shown).toEqual([{ title: 'Researcher replied', body: 'Found three sources', urgent: false, conversationId: dm.id }])
  })

  it('names the routine when its run finishes', () => {
    const bot = store.bots.create({ name: 'Stark' })
    const dm = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
    const task: Entry = {
      ...reply(dm.id, bot.id, 'Brief me'),
      author: { kind: 'system' },
      trigger: { kind: 'routine', routineId: 'r1', routineName: 'Morning brief', via: 'schedule' }
    }
    notifier.onEvent('conv:entry', { entry: task })
    phase(dm.id, bot.id, 'typing')
    notifier.onEvent('conv:entry', { entry: reply(dm.id, bot.id, 'Three things today') })
    phase(dm.id, bot.id, 'idle')
    // The next ordinary reply is a plain "replied" again.
    phase(dm.id, bot.id, 'typing')
    notifier.onEvent('conv:entry', { entry: reply(dm.id, bot.id, 'Sure') })
    phase(dm.id, bot.id, 'idle')
    expect(shown.map((n) => n.title)).toEqual(['Morning brief: Stark finished', 'Stark replied'])
  })

  it('stays quiet when focused, disabled, passing, or in an exchange', () => {
    const a = store.bots.create({ name: 'A' })
    const quiet = store.bots.create({ name: 'Quiet', notify: false })
    const dm = store.conversations.create({ kind: 'dm', title: '', botIds: [a.id] })
    const ex = store.conversations.create({ kind: 'exchange', title: '', botIds: [a.id, quiet.id], origin: { conversationId: dm.id, entryId: 'e', fromBotId: a.id } })

    focused = true
    phase(dm.id, a.id, 'typing'); notifier.onEvent('conv:entry', { entry: reply(dm.id, a.id, 'hi') }); phase(dm.id, a.id, 'idle')
    focused = false
    phase(dm.id, a.id, 'thinking'); phase(dm.id, a.id, 'idle') // passed: no message
    phase(ex.id, a.id, 'typing'); notifier.onEvent('conv:entry', { entry: reply(ex.id, a.id, 'side chat') }); phase(ex.id, a.id, 'idle')
    const qdm = store.conversations.create({ kind: 'dm', title: '', botIds: [quiet.id] })
    phase(qdm.id, quiet.id, 'typing'); notifier.onEvent('conv:entry', { entry: reply(qdm.id, quiet.id, 'x') }); phase(qdm.id, quiet.id, 'idle')
    store.settings.update({ notifications: { enabled: false, sound: true } })
    phase(dm.id, a.id, 'typing'); notifier.onEvent('conv:entry', { entry: reply(dm.id, a.id, 'y') }); phase(dm.id, a.id, 'idle')
    expect(shown).toEqual([])
  })

  it('raises an urgent notification for approvals, pointing at the root conversation', () => {
    const a = store.bots.create({ name: 'Ops' })
    const b = store.bots.create({ name: 'Helper' })
    const group = store.conversations.create({ kind: 'group', title: 'Launch', botIds: [a.id, b.id] })
    const ex = store.conversations.create({ kind: 'exchange', title: '', botIds: [a.id, b.id], origin: { conversationId: group.id, entryId: 'e', fromBotId: a.id } })
    const ctx = { bot: b, conversation: ex, turnId: 't', callId: 'c', signal: new AbortController().signal, chain: [a.id], inGroup: false, workspaceDir: '/w' }
    notifier.onApproval({ approvalId: '1', state: 'pending', ctx, toolName: 'shell', summary: 'Run `npm test` in C:\\work' })
    notifier.onApproval({ approvalId: '1', state: 'resolved', ctx, toolName: 'shell', summary: 'x' })
    expect(shown).toEqual([{ title: 'Helper needs your OK', body: 'Run npm test in C:\\work', urgent: true, conversationId: group.id }])
  })
})
