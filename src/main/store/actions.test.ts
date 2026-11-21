import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStore } from './index'
import { migrate, schemaVersion } from './db'
import { MIGRATIONS } from './schema'
import { workBriefs } from './work-briefs'

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
describe('action persistence compatibility', () => {
  it('upgrades an existing v2 database without replacing its data and repeats safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'faibots-migration-')); directories.push(dir)
    const path = join(dir, 'test.db'); const old = new DatabaseSync(path)
    migrate(old, MIGRATIONS.slice(0, 2))
    old.prepare('insert into settings(id,data) values (1,?)').run(JSON.stringify({ userName: 'Keep me' }))
    old.close()
    const store = openStore(path, { homeDir: dir })
    expect(store.settings.get().userName).toBe('Keep me')
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.length)
    migrate(store.db)
    expect(store.settings.get().userName).toBe('Keep me')
    store.close()
  })
  it('keeps an earlier reviewed brief and the original assignment budget when upgrading from preview 5', () => {
    const db = new DatabaseSync(':memory:')
    try {
      migrate(db, MIGRATIONS.slice(0, 18))
      db.exec('pragma foreign_keys = off')
      db.prepare(`insert into chief_work(id,conversation_id,user_entry_id,objective,deliverable,checks,state,revision,result,updated_at)
        values ('w','c','u','Meeting','Venue note','Venue','review',3,'Meet at Gate 4.',123)`).run()
      migrate(db)
      migrate(db)
      expect(workBriefs(db).get('w', 'c')).toMatchObject({ objective: 'Meeting', revision: 3, state: 'review',
        result: 'Meet at Gate 4.', assignmentLimit: 12, exclusions: '', stopWhen: '' })
    } finally { db.close() }
  })
  it('migrating from the previous version keeps a bot_context row and its session id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'faibots-migration-')); directories.push(dir)
    const path = join(dir, 'test.db'); const old = new DatabaseSync(path)
    migrate(old, MIGRATIONS.slice(0, -1))
    old.exec('pragma foreign_keys = off')
    old.prepare("insert into bot_context(conversation_id,bot_id,last_seen_seq,summary,summarized_up_to_seq,engine_session_id) values ('c','b',7,'sum',3,'sess-old')").run()
    old.close()
    const store = openStore(path, { homeDir: dir })
    try {
      expect(schemaVersion(store.db)).toBe(MIGRATIONS.length)
      expect(store.botContext.get('c', 'b')).toEqual({
        conversationId: 'c', botId: 'b', lastSeenSeq: 7, summary: 'sum', summarizedUpToSeq: 3, engineSessionId: 'sess-old'
      })
    } finally { store.close() }
  })
  it('rejects stale attempt writes and preserves unresolved actions after transcript deletion', () => {
    const store = openStore(':memory:', { homeDir: '/test' })
    try {
      const bot = store.bots.create({ name: 'Test' })
      const conversation = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
      const intent = { id: 'a', botId: bot.id, conversationId: conversation.id, toolName: 'effect', inputDigest: 'd', capability: '' }
      const first = store.actions.claim(intent, false)
      if (first.kind !== 'claimed') throw new Error('claim failed')
      store.actions.dispatch('a', first.record.attempt!)
      store.actions.recoverInterrupted()
      expect(() => store.actions.finish('a', first.record.attempt!, 'completed', { content: [] })).toThrow()
      store.entries.clear(conversation.id)
      store.conversations.delete(conversation.id)
      expect(store.actions.get('a')?.state).toBe('unknown')
    } finally { store.close() }
  })
})
