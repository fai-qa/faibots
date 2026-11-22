import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore, type PlatformStore } from '../store'
import { backgroundAnchor, createDelegationRepo } from '../store/delegations'
import { createHarness } from './testing/fakes'
import type { Entry } from '@shared/domain'
import type { NewEntry, ToolResult } from '../contracts'

const textOf = (r: ToolResult) => r.content.map((p) => (p.type === 'text' ? p.text : '')).join('')

it('retains a bounded unconfirmed child return only for the original caller and chat, without a new parent message', async () => {
  const h = createHarness()
  try {
    for (const tool of h.runtime.assignments.tools()) h.services.tools.register(tool)
    const chief = h.bot('fai', { isPrimary: true }),
      child = h.bot('Editor')
    const room = h.runtime.openDm(chief.id),
      other = h.runtime.openDm(child.id)
    let id = '',
      status = ''
    let childStarted!: () => void
    const starting = new Promise<void>((ready) => {
      childStarted = ready
    })
    h.engine.script('editor', async (api) => {
      childStarted()
      await api.untilAborted()
      api.say('Late reviewed draft. ' + 'x'.repeat(6000))
    })
    h.engine.script('fai', async (api) => {
      if (id) {
        status = textOf(await api.tool('assignment_status', { id }))
        return
      }
      const response = await api.tool('assign_to_agent', { to: 'editor', message: 'Prepare the report.' })
      id = /Assignment ([a-f\d]{64})/.exec(textOf(response))![1]!
      await starting
      await api.tool('cancel_assignment', { id })
    })
    await h.send(room.id, 'Prepare the report.')
    await h.send(room.id, 'Inspect the cancelled task.')
    const repo = createDelegationRepo(h.services.store.db, h.services.store.entries)
    const original = repo.scoped(id, chief.id, room.id)!
    expect(original.state).toBe('reconciliation_required')
    expect(original.lateReturn?.text).toHaveLength(4000)
    expect(status).toContain('Late observation (unconfirmed): Late reviewed draft.')
    expect(repo.scoped(id, chief.id, other.id)).toBeUndefined()
    expect(repo.scoped(id, child.id, room.id)).toBeUndefined()
    expect(
      h.services.store.entries.since(room.id, 0).filter((e) => e.clientNonce?.startsWith('faibots:assignment-result:'))
    ).toHaveLength(1)
    expect(h.services.store.entries.since(original.exchangeId, 0).some((e) => e.text.includes('Late reviewed draft.'))).toBe(
      false
    )
  } finally {
    await h.runtime.shutdown()
    h.cleanup()
  }
})

describe('child return at restart boundaries', () => {
  let dir: string, store: PlatformStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-return-'))
    store = openStore(join(dir, 'case.db'), { homeDir: dir })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  it.each(['assigned', 'dispatched', 'effects', 'returned', 'consumed', 'cancelled'] as const)(
    'reconciles %s without duplicating dispatch, delivery, or external effects',
    (stage) => {
      const caller = store.bots.create({ name: 'Requester' }),
        child = store.bots.create({ name: 'Child' })
      const room = store.conversations.create({ kind: 'group', title: 'Source room', botIds: [caller.id, child.id] })
      const exchange = store.conversations.create({
        kind: 'exchange',
        title: 'Source exchange',
        botIds: [caller.id, child.id]
      })
      let repo = createDelegationRepo(store.db, store.entries)
      const id = 'fixed-child-action'
      const intent = { id, callerId: caller.id, childId: child.id, parentId: room.id, inputHash: 'approved-input' }
      const append = (conversationId: string, kind: Entry['kind'], text: string, extra: Partial<NewEntry> = {}) =>
        store.entries.append({
          conversationId,
          kind,
          text,
          author: { kind: 'system' },
          mentions: [],
          mentionsEveryone: false,
          attachments: [],
          isStreaming: false,
          ...extra
        })
      const claim = (effectId: string, botId: string, conversationId: string, toolName: string) => {
        const record = store.actions.claim(
          { id: effectId, botId, conversationId, toolName, capability: 'local', inputDigest: effectId },
          false
        )
        if (record.kind !== 'claimed') throw Error('Not a fresh claim')
        return record.record.attempt!
      }
      const mainAttempt = claim(id, caller.id, room.id, 'send_to_agent')
      const started = repo.assign(intent, () => ({
        parent: append(room.id, 'event', 'Background task', { clientNonce: backgroundAnchor(id) }),
        question: append(exchange.id, 'message', 'Check the report.')
      }))
      const lease = started.lease!
      const hasEffects = ['effects', 'returned', 'consumed', 'cancelled'].includes(stage)
      if (stage !== 'assigned') {
        store.actions.dispatch(id, mainAttempt)
        repo.pin(lease, 'native', 'version-A')
      }
      if (hasEffects) {
        const safe = claim('known', child.id, exchange.id, 'fixture_write')
        store.actions.dispatch('known', safe)
        appendFileSync(join(dir, 'observed.txt'), 'one\\n')
        store.actions.finish('known', safe, 'completed', { content: [{ type: 'text', text: 'wrote one line' }] })
        store.actions.dispatch('uncertain', claim('uncertain', child.id, exchange.id, 'fixture_send'))
      }
      if (stage === 'returned' || stage === 'consumed') repo.finish(lease, 'answered', { text: 'Checked.' })
      if (stage === 'consumed') {
        repo.recover()
        repo.acknowledge(id, started.parent!.id)
      }
      if (stage === 'cancelled') repo.finish(lease, 'reconciliation_required', { text: 'Owner cancelled.' })
      store.close()
      store = openStore(join(dir, 'case.db'), { homeDir: dir })
      repo = createDelegationRepo(store.db, store.entries)
      store.actions.recoverInterrupted()
      repo.recover()
      repo.recover()
      const answered = stage === 'returned' || stage === 'consumed'
      expect(repo.get(id)?.state).toBe(answered ? 'answered' : 'reconciliation_required')
      expect(
        repo.assign(intent, () => {
          throw Error('Duplicate dispatch')
        }).existing?.id
      ).toBe(id)
      expect(repo.retainLate({ ...lease, token: 'incorrect' }, 'unauthorized')).toBe(false)
      expect(repo.retainLate(lease, 'late observation')).toBe(!answered)
      expect(repo.retainLate(lease, 'duplicate observation')).toBe(false)
      expect(() =>
        store.db.prepare('update delegation_attempts set original_lease=? where assignment_id=?').run('replacement', id)
      ).toThrow(/immutable/)
      if (!answered)
        expect(() =>
          store.db.prepare('update delegation_attempts set late_text=? where assignment_id=?').run('replacement', id)
        ).toThrow(/already recorded/)
      expect(() => repo.finish(lease, 'answered', { text: 'override' })).toThrow(/lease/)
      expect(repo.get(id)?.state).toBe(answered ? 'answered' : 'reconciliation_required')
      expect(repo.scoped(id, caller.id, exchange.id)).toBeUndefined()
      if (stage === 'cancelled') expect(repo.get(id)?.receipt?.text).toBe('Owner cancelled.')
      if (hasEffects) {
        expect(readFileSync(join(dir, 'observed.txt'), 'utf8')).toBe('one\\n')
        expect(store.actions.get('known')?.state).toBe('completed')
        expect(store.actions.get('uncertain')?.state).toBe('unknown')
      } else expect(existsSync(join(dir, 'observed.txt'))).toBe(false)
      store.close()
      store = openStore(join(dir, 'case.db'), { homeDir: dir })
      repo = createDelegationRepo(store.db, store.entries)
      repo.recover()
      expect(repo.scoped(id, caller.id, room.id)?.lateReturn?.text).toBe(answered ? undefined : 'late observation')
      expect(
        store.entries.since(room.id, 0).filter((e) => e.clientNonce?.startsWith('faibots:assignment-result:'))
      ).toHaveLength(1)
    }
  )
})
