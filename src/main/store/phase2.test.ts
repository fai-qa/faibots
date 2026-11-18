// Phase 2 storage: the v1 -> v2 migration, the turn log, routines and the new fields.

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBotRepo } from './bots'
import { migrate, openDatabase, schemaVersion } from './db'
import { openStore, type PlatformStore } from './index'
import { RUNS_KEPT_PER_ROUTINE } from './routines'
import { MIGRATIONS } from './schema'
import { createSettingsRepo, defaultSettings } from './settings'
import { startOfLocalDay } from './turns'

describe('migration to v2', () => {
  it('upgrades a v1 database and keeps its bots', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('pragma foreign_keys = on')
    migrate(db, MIGRATIONS.slice(0, 1))
    const settings = createSettingsRepo(db, defaultSettings('/home/me'))
    // A v1 bot row has no daily_run_limit column yet: write it the way v1 did.
    db.prepare(
      `insert into bots (id, name, handle, avatar, model, created_at, updated_at) values ('b1', 'Old', 'old', '{"shape":"blob","color":"red"}', '{"providerId":"","modelId":""}', 1, 1)`
    ).run()
    expect(schemaVersion(db)).toBe(1)

    migrate(db)
    expect(schemaVersion(db)).toBe(MIGRATIONS.length)
    const bots = createBotRepo(db, settings, () => {})
    expect(bots.get('b1')).toMatchObject({ name: 'Old', dailyRunLimit: 0 })
    db.close()
  })

  it('fills new settings in for an old settings row', () => {
    const db = openDatabase(':memory:')
    db.prepare(`insert into settings (id, data) values (1, '{"theme":"dark","userName":"Me"}')`).run()
    const settings = createSettingsRepo(db, defaultSettings('/home/me'))
    expect(settings.get()).toMatchObject({
      theme: 'dark',
      background: { keepRunning: false, openAtLogin: false, routinesPaused: false },
      webhooks: { enabled: false, port: 47821 }
    })
    expect(() => settings.update({ webhooks: { enabled: true, port: 80 } })).toThrow('1024')
    db.close()
  })
})

describe('phase 2 repos', () => {
  let store: PlatformStore
  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/home/me' })
  })
  afterEach(() => store.close())

  it('stores the daily run limit and checks it', () => {
    const bot = store.bots.create({ name: 'Stark', dailyRunLimit: 50 })
    expect(store.bots.get(bot.id)!.dailyRunLimit).toBe(50)
    expect(store.bots.update(bot.id, { dailyRunLimit: 0 }).dailyRunLimit).toBe(0)
    expect(() => store.bots.update(bot.id, { dailyRunLimit: -1 })).toThrow('whole number')
    expect(() => store.bots.create({ name: 'X', dailyRunLimit: 1.5 })).toThrow('whole number')
  })

  it('keeps the trigger of a routine message', () => {
    const bot = store.bots.create({ name: 'Stark' })
    const dm = store.conversations.create({ kind: 'dm', title: 'Stark', botIds: [bot.id] })
    const trigger = { kind: 'routine' as const, routineId: 'r1', routineName: 'Brief', via: 'webhook' as const }
    const entry = store.entries.append({
      conversationId: dm.id, kind: 'message', author: { kind: 'system' }, text: 'Go', mentions: [], mentionsEveryone: false,
      attachments: [], isStreaming: false, trigger
    })
    expect(store.entries.get(entry.id)!.trigger).toEqual(trigger)
  })

  it('sums the turn log per bot, day and model, and counts automatic runs', () => {
    const a = store.bots.create({ name: 'A' })
    const b = store.bots.create({ name: 'B' })
    const today = startOfLocalDay(Date.now()) + 10 * 3_600_000
    const yesterday = today - 24 * 3_600_000
    const base = { conversationId: 'c', conversationKind: 'dm' as const, providerId: 'p', modelId: 'm', startedAt: today, endedAt: today + 1 }
    store.turns.record({ ...base, botId: a.id, trigger: 'user', status: 'sent', inputTokens: 100, outputTokens: 10 })
    store.turns.record({ ...base, botId: a.id, trigger: 'routine', status: 'sent', inputTokens: 50, outputTokens: 5 })
    store.turns.record({ ...base, botId: a.id, trigger: 'agent', status: 'error', inputTokens: 0, outputTokens: 0, error: 'down' })
    store.turns.record({ ...base, botId: a.id, trigger: 'routine', status: 'sent', inputTokens: 7, outputTokens: 1, startedAt: yesterday })
    store.turns.record({ ...base, botId: b.id, trigger: 'user', status: 'sent', inputTokens: 1, outputTokens: 1, modelId: 'other' })

    expect(store.turns.automaticRunsSince(a.id, startOfLocalDay(today))).toBe(2)
    const rows = store.turns.summary(startOfLocalDay(today), today + 3_600_000).rows
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.botId === a.id)).toMatchObject({ turns: 3, automaticTurns: 2, errors: 1, inputTokens: 150, outputTokens: 15 })
    expect(rows.find((r) => r.botId === b.id)).toMatchObject({ turns: 1, modelId: 'other' })
    expect(store.turns.summary(0, today + 3_600_000).rows).toHaveLength(3)

    // The log goes with the bot.
    store.bots.delete(a.id)
    expect(store.turns.summary(0, today + 3_600_000).rows.map((r) => r.botId)).toEqual([b.id])
  })

  it('keeps the newest runs of a routine', () => {
    const bot = store.bots.create({ name: 'Stark' })
    const r = store.routines.insert({ botId: bot.id, name: 'R', prompt: 'P', schedule: { kind: 'manual' }, enabled: true, webhookEnabled: false, createdBy: 'user' })
    for (let i = 0; i < RUNS_KEPT_PER_ROUTINE + 5; i++) {
      store.routines.startRun({ routineId: r.id, botId: bot.id, trigger: 'manual', status: 'done', startedAt: i, endedAt: i })
    }
    const runs = store.routines.runs({ routineId: r.id, limit: 1000 })
    expect(runs).toHaveLength(RUNS_KEPT_PER_ROUTINE)
    expect(runs[0]!.startedAt).toBe(RUNS_KEPT_PER_ROUTINE + 4)
    store.routines.delete(r.id)
    expect(store.routines.runs({ botId: bot.id })).toEqual([])
  })
})
