import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openStore } from './index'
import { startOfLocalDay } from './turns'

describe('durable automatic run admissions', () => {
  it('reserves across connections, counts legacy turns once, survives reopen and transcript removal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'faibots-budget-')); const path = join(dir, 'test.db')
    const a = openStore(path, { homeDir: dir }); let b = openStore(path, { homeDir: dir })
    try {
      const bot = a.bots.create({ name: 'Budget', dailyRunLimit: 2 })
      const at = Date.now(); const since = startOfLocalDay(at)
      const turn = { botId: bot.id, conversationId: 'c', conversationKind: 'dm' as const, trigger: 'routine' as const,
        status: 'sent' as const, providerId: '', modelId: '', inputTokens: 1, outputTokens: 1, startedAt: at, endedAt: at }
      a.turns.record({ ...turn, id: 'legacy' })
      expect(a.turns.reserveAutomatic({ id: 'new', botId: bot.id, startedAt: at })).toBe(true)
      expect(b.turns.reserveAutomatic({ id: 'third', botId: bot.id, startedAt: at })).toBe(false)
      expect(b.turns.automaticRunsSince(bot.id, since)).toBe(2)
      a.turns.record({ ...turn, id: 'new' })
      expect(b.turns.automaticRunsSince(bot.id, since)).toBe(2)
      a.db.prepare('delete from turns where id = ?').run('new')
      b.close(); b = openStore(path, { homeDir: dir })
      expect(b.turns.reserveAutomatic({ id: 'after-restart', botId: bot.id, startedAt: at })).toBe(false)
      expect(b.turns.reserveAutomatic({ id: 'next-day', botId: bot.id, startedAt: new Date(new Date(at).getFullYear(), new Date(at).getMonth(), new Date(at).getDate() + 1).getTime() })).toBe(true)
    } finally { b.close(); a.close(); rmSync(dir, { recursive: true, force: true }) }
  })
  it('reads the current ceiling, retains unlimited admissions, rejects reused IDs and invalid time', () => {
    const store = openStore(':memory:', { homeDir: '/test' })
    try {
      const bot = store.bots.create({ name: 'Budget' }); const at = Date.now()
      expect(store.turns.reserveAutomatic({ id: 'one', botId: bot.id, startedAt: at })).toBe(true)
      expect(store.turns.reserveAutomatic({ id: 'one', botId: bot.id, startedAt: at })).toBe(false)
      expect(() => store.turns.reserveAutomatic({ id: 'bad', botId: bot.id, startedAt: NaN })).toThrow()
      store.bots.update(bot.id, { dailyRunLimit: 1 })
      expect(store.turns.reserveAutomatic({ id: 'two', botId: bot.id, startedAt: at })).toBe(false)
      expect(store.turns.reserveAutomatic({ id: 'gone', botId: 'missing', startedAt: at })).toBe(false)
      expect(store.turns.automaticRunsSince(bot.id, 0)).toBe(1)
    } finally { store.close() }
  })
})
