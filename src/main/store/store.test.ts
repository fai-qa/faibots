import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_SETTINGS } from '@shared/domain'
import type { NewEntry } from '../contracts'
import { handleFromName } from './bots'
import { schemaVersion } from './db'
import { createStore, openStore, type BotDeletion, type PlatformStore } from './index'
import { MIGRATIONS } from './schema'

const message = (conversationId: string, text: string, extra: Partial<NewEntry> = {}): NewEntry => ({
  conversationId,
  kind: 'message',
  author: { kind: 'user' },
  text,
  mentions: [],
  mentionsEveryone: false,
  attachments: [],
  isStreaming: false,
  ...extra
})

describe('store', () => {
  let store: PlatformStore
  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/home/me', userName: 'Me' })
  })
  afterEach(() => store.close())

  describe('settings', () => {
    it('seeds defaults on first run', () => {
      const s = store.settings.get()
      expect(s.workspaceRoot).toBe(join('/home/me', 'FaiBots', 'workspaces'))
      expect(s.compactAt).toBe(0.7)
      expect(s.theme).toBe('system')
      expect(s.userName).toBe('Me')
      expect(s.defaultModel).toBeNull()
    })

    it('merges patches and validates', () => {
      store.settings.update({ theme: 'dark', toolPermissions: { shell: 'always' } })
      expect(store.settings.get()).toMatchObject({ theme: 'dark', toolPermissions: { shell: 'always' }, compactAt: 0.7 })
      expect(() => store.settings.update({ compactAt: 2 })).toThrow()
    })
  })

  describe('bots', () => {
    it('derives unique handles from names', () => {
      expect(handleFromName('Dr. Zoë Researcher')).toBe('drzoeresearcher')
      expect(handleFromName('🤖')).toBe('bot')
      const a = store.bots.create({ name: 'Researcher' })
      const b = store.bots.create({ name: 'researcher' })
      expect(a.handle).toBe('researcher')
      expect(b.handle).toBe('researcher2')
      expect(store.bots.getByHandle('@Researcher')?.id).toBe(a.id)
      // Windows device names cannot be folder names, so they are never handles.
      expect(store.bots.create({ name: 'Con' }).handle).toBe('con2')
      expect(store.bots.create({ name: 'Aux' }).handle).toBe('aux2')
      expect(() => store.bots.create({ name: 'Printer', handle: 'prn' })).toThrow(/reserved/)
    })

    it('fills defaults: random avatar, default model, first bot is primary', () => {
      store.settings.update({ defaultModel: { providerId: 'p1', modelId: 'claude-opus-5-5' } })
      const first = store.bots.create({ name: 'First' })
      const second = store.bots.create({ name: 'Second' })
      expect(first.model).toEqual({ providerId: 'p1', modelId: 'claude-opus-5-5' })
      expect(first.avatar.shape).toBeTruthy()
      expect(first.avatar.color).not.toBe('black')
      expect(first.isPrimary).toBe(true)
      expect(second.isPrimary).toBe(false)
      expect(second.mcpServerIds).toBe('all')
    })

    it('keeps at most one primary bot', () => {
      const a = store.bots.create({ name: 'A' })
      const b = store.bots.create({ name: 'B' })
      store.bots.update(b.id, { isPrimary: true })
      expect(store.bots.get(a.id)?.isPrimary).toBe(false)
      expect(store.bots.get(b.id)?.isPrimary).toBe(true)
    })

    it('validates handle changes and ignores undefined patch fields', () => {
      const a = store.bots.create({ name: 'A', label: 'Helper' })
      store.bots.create({ name: 'B' })
      expect(() => store.bots.update(a.id, { handle: 'b' })).toThrow(/taken/)
      expect(() => store.bots.update(a.id, { handle: 'Has Space' })).toThrow()
      const updated = store.bots.update(a.id, { label: undefined, soul: '# Me' })
      expect(updated.label).toBe('Helper')
      expect(updated.soul).toBe('# Me')
    })

    it('delete cascades: dm and exchanges go, groups drop the member, memory and secrets go', () => {
      const a = store.bots.create({ name: 'A' })
      const b = store.bots.create({ name: 'B' })
      const c = store.bots.create({ name: 'C' })
      const dm = store.conversations.create({ kind: 'dm', title: '', botIds: [a.id] })
      const otherDm = store.conversations.create({ kind: 'dm', title: '', botIds: [b.id] })
      const group = store.conversations.create({
        kind: 'group', title: 'Team', botIds: [a.id, b.id, c.id], group: DEFAULT_GROUP_SETTINGS
      })
      const exchange = store.conversations.create({ kind: 'exchange', title: '', botIds: [b.id, a.id] })
      store.entries.append(message(dm.id, 'hi'))
      store.botContext.set({ conversationId: group.id, botId: a.id, lastSeenSeq: 3, summary: 's', summarizedUpToSeq: 1 })
      const now = Date.now()
      store.db.prepare(`insert into memory_facts (id, bot_id, text, created_by, created_at, updated_at)
        values ('f1', ?, 'likes tea', 'bot', ?, ?)`).run(a.id, now, now)
      store.db.prepare(`insert into secrets (id, name, bot_id, created_at, updated_at) values ('s1', 'TOKEN', ?, ?, ?)`)
        .run(a.id, now, now)

      const deletions: BotDeletion[] = []
      store.onBotDeleted((d) => deletions.push(d))
      store.bots.delete(a.id)

      expect(store.bots.get(a.id)).toBeUndefined()
      expect(store.conversations.get(dm.id)).toBeUndefined()
      expect(store.conversations.get(exchange.id)).toBeUndefined()
      expect(store.conversations.get(otherDm.id)).toBeDefined()
      expect(store.conversations.get(group.id)?.botIds).toEqual([b.id, c.id])
      expect(store.entries.page(dm.id, { limit: 10 }).entries).toEqual([])
      expect(store.botContext.get(group.id, a.id).lastSeenSeq).toBe(0)
      expect(store.db.prepare('select count(*) as n from memory_facts').get()).toEqual({ n: 0 })
      expect(store.db.prepare(`select count(*) as n from memory_fts where memory_fts match 'tea'`).get()).toEqual({ n: 0 })
      expect(store.db.prepare('select count(*) as n from secrets').get()).toEqual({ n: 0 })
      expect(deletions).toHaveLength(1)
      expect(deletions[0]!.bot.id).toBe(a.id)
      expect(deletions[0]!.deletedConversationIds.sort()).toEqual([dm.id, exchange.id].sort())
      expect(deletions[0]!.changedConversationIds).toEqual([group.id])
    })

    it('delete removes a group whose last member was the deleted bot', () => {
      const solo = store.bots.create({ name: 'Solo' })
      const group = store.conversations.create({ kind: 'group', title: 'Just me', botIds: [solo.id], group: DEFAULT_GROUP_SETTINGS })
      const deletions: BotDeletion[] = []
      store.onBotDeleted((d) => deletions.push(d))
      store.bots.delete(solo.id)
      expect(store.conversations.get(group.id)).toBeUndefined()
      expect(deletions[0]!.deletedConversationIds).toEqual([group.id])
    })
  })

  describe('conversations', () => {
    it('finds dms and exchanges in either order', () => {
      const a = store.bots.create({ name: 'A' })
      const b = store.bots.create({ name: 'B' })
      const dm = store.conversations.create({ kind: 'dm', title: '', botIds: [a.id] })
      const ex = store.conversations.create({
        kind: 'exchange', title: '', botIds: [a.id, b.id], origin: { conversationId: dm.id, entryId: 'e1', fromBotId: a.id }
      })
      expect(store.conversations.findDm(a.id)?.id).toBe(dm.id)
      expect(store.conversations.findDm(b.id)).toBeUndefined()
      expect(store.conversations.findExchange(b.id, a.id)?.id).toBe(ex.id)
      expect(store.conversations.get(ex.id)?.origin).toEqual({ conversationId: dm.id, entryId: 'e1', fromBotId: a.id })
    })

    it('enforces member counts', () => {
      const a = store.bots.create({ name: 'A' })
      expect(() => store.conversations.create({ kind: 'dm', title: '', botIds: [] })).toThrow()
      expect(() => store.conversations.create({ kind: 'exchange', title: '', botIds: [a.id] })).toThrow()
      expect(() => store.conversations.create({ kind: 'group', title: '', botIds: [a.id, a.id] })).toThrow()
    })
  })

  describe('entries', () => {
    let convId: string
    beforeEach(() => {
      const bot = store.bots.create({ name: 'A' })
      convId = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] }).id
    })

    it('assigns monotonic seq per conversation and bumps lastEntryAt', () => {
      const before = store.conversations.get(convId)!.lastEntryAt
      const e1 = store.entries.append(message(convId, 'one'))
      const e2 = store.entries.append(message(convId, 'two'))
      expect([e1.seq, e2.seq]).toEqual([1, 2])
      expect(store.conversations.get(convId)!.lastEntryAt).toBeGreaterThanOrEqual(before)
      expect(store.entries.get(e2.id)).toEqual(e2)
    })

    it('pages newest-last and reports hasMore', () => {
      for (let i = 1; i <= 7; i++) store.entries.append(message(convId, `m${i}`))
      const last = store.entries.page(convId, { limit: 3 })
      expect(last.entries.map((e) => e.text)).toEqual(['m5', 'm6', 'm7'])
      expect(last.hasMore).toBe(true)
      const older = store.entries.page(convId, { beforeSeq: last.entries[0]!.seq, limit: 3 })
      expect(older.entries.map((e) => e.text)).toEqual(['m2', 'm3', 'm4'])
      const oldest = store.entries.page(convId, { beforeSeq: older.entries[0]!.seq, limit: 3 })
      expect(oldest.entries.map((e) => e.text)).toEqual(['m1'])
      expect(oldest.hasMore).toBe(false)
      expect(store.entries.since(convId, 5).map((e) => e.text)).toEqual(['m6', 'm7'])
      expect(store.entries.since(convId, 0, 2).map((e) => e.text)).toEqual(['m1', 'm2'])
    })

    it('treats clientNonce as an idempotency key', () => {
      const first = store.entries.append(message(convId, 'hello', { clientNonce: 'n1' }))
      const retry = store.entries.append(message(convId, 'hello', { clientNonce: 'n1' }))
      expect(retry.id).toBe(first.id)
      expect(store.entries.findByNonce(convId, 'n1')?.id).toBe(first.id)
      expect(store.entries.findByNonce(convId, 'other')).toBeUndefined()
      expect(store.entries.page(convId, { limit: 10 }).entries).toHaveLength(1)
    })

    it('updates keep identity fields and round-trip nested json', () => {
      const e = store.entries.append(message(convId, '', { author: { kind: 'bot', botId: 'x' }, isStreaming: true }))
      const done = store.entries.update(e.id, {
        text: 'done',
        isStreaming: false,
        toolCall: { callId: 'c', toolName: 'shell', title: 'Running a command', input: { command: 'ls' }, status: 'done' },
        meta: { modelId: 'm', outputTokens: 5 }
      })
      expect(done.seq).toBe(e.seq)
      expect(store.entries.get(e.id)).toMatchObject({
        text: 'done', isStreaming: false, toolCall: { input: { command: 'ls' } }, meta: { outputTokens: 5 }
      })
    })

    it('counts bot messages as unread and clear resets', () => {
      store.entries.append(message(convId, 'user'))
      store.entries.append(message(convId, 'bot', { author: { kind: 'bot', botId: 'b' } }))
      expect(store.conversations.get(convId)!.unreadCount).toBe(1)
      store.entries.clear(convId)
      expect(store.entries.page(convId, { limit: 5 }).entries).toEqual([])
      expect(store.conversations.get(convId)!.unreadCount).toBe(0)
      expect(store.entries.append(message(convId, 'again')).seq).toBe(1)
    })
  })

  it('stores providers without keys and validates them', () => {
    const p = store.providers.save({ kind: 'anthropic', label: 'Claude', defaultModelId: 'claude-opus-5-5', enabled: true, hasApiKey: true })
    expect(store.providers.get(p.id)).toEqual(p)
    expect(() => store.providers.save({ kind: 'openai-compatible', label: 'Local', defaultModelId: '', enabled: true, hasApiKey: false })).toThrow(/base URL/)
    const updated = store.providers.save({ id: p.id, kind: 'anthropic', label: 'Claude API', defaultModelId: '', enabled: false, hasApiKey: false })
    expect(updated.createdAt).toBe(p.createdAt)
    expect(store.providers.list()).toHaveLength(1)
  })
})

describe('store on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-store-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps one fai and its original conversation across desktop launches', () => {
    const store = createStore({ dataDir: dir, homeDir: dir })
    const [fai] = store.bots.list()
    expect(fai).toMatchObject({ name: 'fai', handle: 'fai', isPrimary: true })
    const dm = store.conversations.findDm(fai!.id)!
    const editor = store.bots.create({ name: 'Editor' })
    expect(() => store.bots.update(fai!.id, { name: 'Other' })).toThrow(/fai/)
    expect(() => store.bots.update(fai!.id, { hidden: true })).toThrow(/fai/)
    expect(() => store.bots.delete(fai!.id)).toThrow(/fai/)
    expect(() => store.bots.update(editor.id, { isPrimary: true })).toThrow(/fai/)
    expect(() => store.bots.create({ name: 'FAI' })).toThrow(/fai/)
    store.close()
    const reopened = createStore({ dataDir: dir, homeDir: dir })
    expect(reopened.bots.list().filter((bot) => bot.isPrimary)).toEqual([fai])
    expect(reopened.conversations.findDm(fai!.id)).toEqual(dm)
    reopened.close()
  })

  it('adopts an existing named fai, preserving its id, chosen handle, model and messages', () => {
    const old = openStore(join(dir, 'faibots.db'), { homeDir: dir })
    const atlas = old.bots.create({ name: 'Atlas', handle: 'fai', isPrimary: true })
    const model = { providerId: 'old-provider', modelId: 'old-model' }
    const named = old.bots.create({ name: 'FAI', handle: 'lead', hidden: true, model })
    const dm = old.conversations.create({ kind: 'dm', title: 'FAI', botIds: [named.id] })
    const entry = old.entries.append(message(dm.id, 'Original message'))
    old.close()
    const updated = createStore({ dataDir: dir, homeDir: dir })
    expect(updated.bots.get(atlas.id)).toMatchObject({ name: 'Atlas', handle: 'fai', isPrimary: false })
    expect(updated.bots.get(named.id)).toMatchObject({ name: 'fai', handle: 'lead', isPrimary: true, hidden: false, model })
    expect(updated.conversations.findDm(named.id)).toMatchObject({ id: dm.id, title: 'fai' })
    expect(updated.entries.get(entry.id)).toEqual(entry)
    updated.close()
  })

  it('preserves an unrelated owner of the fai handle when adding the main bot', () => {
    const old = openStore(join(dir, 'faibots.db'), { homeDir: dir })
    const atlas = old.bots.create({ name: 'Atlas', handle: 'fai' })
    old.close()
    const updated = createStore({ dataDir: dir, homeDir: dir })
    expect(updated.bots.get(atlas.id)).toMatchObject({ name: 'Atlas', handle: 'fai', isPrimary: false })
    expect(updated.bots.getByHandle('fai2')).toMatchObject({ name: 'fai', isPrimary: true })
    updated.close()
  })

  it('uses WAL, records the schema version and reopens cleanly', () => {
    const store = createStore({ dataDir: dir, homeDir: dir })
    expect(store.db.prepare('pragma journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length)
    const bot = store.bots.create({ name: 'Keeper' })
    store.close()

    const reopened = createStore({ dataDir: dir, homeDir: '/elsewhere' })
    expect(reopened.bots.get(bot.id)?.name).toBe('Keeper')
    // Settings were seeded on first run and are not re-derived from the new home folder.
    expect(reopened.settings.get().workspaceRoot).toBe(join(dir, 'FaiBots', 'workspaces'))
    reopened.close()
  })
})
