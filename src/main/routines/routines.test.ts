import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bot } from '@shared/domain'
import type { AutomatedRunResult, Runtime } from '../contracts'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { routineTools, toSchedule } from './routine-tools'
import { CATCH_UP_WINDOW_MS, createRoutineService, WEBHOOK_RUNS_PER_HOUR, WebhookError } from './routines'

const MIN = 60_000
const at = (h: number, m = 0) => new Date(2026, 9, 19, h, m).getTime() // Monday 19 Oct 2026

/** A runtime whose runs finish when the test says so. */
function fakeRuntime() {
  const calls: { botId: string; text: string; via: string; signal?: AbortSignal; finish(r?: Partial<AutomatedRunResult>): void }[] = []
  return {
    calls,
    runAutomated(input: Parameters<Runtime['runAutomated']>[0]): Promise<AutomatedRunResult> {
      return new Promise<AutomatedRunResult>((resolve) => {
        const finish = (r: Partial<AutomatedRunResult> = {}) =>
          resolve({ status: 'done', conversationId: 'dm1', entryId: 'e1', reply: 'Done it.', ...r })
        input.signal?.addEventListener('abort', () => finish({ status: 'cancelled', reply: '' }), { once: true })
        const via = input.trigger.kind === 'routine' ? input.trigger.via : 'mission'
        calls.push({ botId: input.botId, text: input.text, via, ...(input.signal && { signal: input.signal }), finish })
      })
    }
  }
}

describe('routine service', () => {
  let store: PlatformStore
  let bot: Bot
  let clock: number
  let runtime: ReturnType<typeof fakeRuntime>
  let bus: ReturnType<typeof fakeBus>
  let service: ReturnType<typeof createRoutineService>

  const make = () =>
    createRoutineService({ store, runtime, bus, now: () => clock, setTimer: () => 1, clearTimer: () => {} })

  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/tmp/faibots-test' })
    bot = store.bots.create({ name: 'Stark' })
    clock = at(7, 0)
    runtime = fakeRuntime()
    bus = fakeBus()
    service = make()
  })
  afterEach(async () => {
    await service.shutdown()
    store.close()
  })

  it('validates and plans the next run', () => {
    const r = service.save({ botId: bot.id, name: ' Morning brief ', prompt: 'Brief me', schedule: { kind: 'daily', time: '8:00', days: [1, 2, 3, 4, 5] } })
    expect(r).toMatchObject({ name: 'Morning brief', enabled: true, nextRunAt: at(8, 0), createdBy: 'user', hasWebhookToken: false })
    expect(() => service.save({ botId: bot.id, name: 'x', prompt: '', schedule: { kind: 'manual' } })).toThrow('should do')
    expect(() => service.save({ botId: bot.id, name: 'x', prompt: 'y', schedule: { kind: 'interval', everyMinutes: 2 } })).toThrow('every 5 minutes')
    const off = service.save({ ...r, enabled: false })
    expect(off.nextRunAt).toBeUndefined()
    expect(bus.of('routines:changed').length).toBeGreaterThan(0)
  })

  it('runs a routine when it is due, records the run and plans the next one', async () => {
    const r = service.save({ botId: bot.id, name: 'Hourly', prompt: 'Check things', schedule: { kind: 'interval', everyMinutes: 60 } })
    service.start()
    service.tick()
    expect(runtime.calls).toHaveLength(0)

    clock = r.nextRunAt! + 5_000
    service.tick()
    expect(runtime.calls).toMatchObject([{ botId: bot.id, text: 'Check things', via: 'schedule' }])
    expect(service.runs({ routineId: r.id })[0]).toMatchObject({ status: 'running', trigger: 'schedule' })
    // The grid holds: next run is an hour after the planned time, not after the late start.
    expect(store.routines.get(r.id)!.nextRunAt).toBe(r.nextRunAt! + 60 * MIN)

    runtime.calls[0]!.finish()
    await service.idle()
    expect(service.runs({ routineId: r.id })[0]).toMatchObject({ status: 'done', summary: expect.stringContaining('Done it.'), acceptance: { status: 'unverified' }, conversationId: 'dm1', entryId: 'e1' })
    expect(store.routines.get(r.id)!.lastRunAt).toBe(clock)
  })

  it('skips a planned run while the previous one is still going', () => {
    const r = service.save({ botId: bot.id, name: 'Often', prompt: 'Go', schedule: { kind: 'interval', everyMinutes: 5 } })
    service.start()
    clock = r.nextRunAt!
    service.tick()
    clock += 5 * MIN
    service.tick()
    expect(runtime.calls).toHaveLength(1)
    expect(service.runs({ routineId: r.id }).map((x) => x.status)).toEqual(['skipped', 'running'])
    expect(() => service.runNow(r.id)).toThrow('already running')
  })

  it('catches up a recent missed run once at start, and skips an old one', () => {
    const recent = service.save({ botId: bot.id, name: 'Recent', prompt: 'A', schedule: { kind: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } })
    const old = service.save({ botId: bot.id, name: 'Old', prompt: 'B', schedule: { kind: 'interval', everyMinutes: 60 * 24 } })
    // The app was closed past both planned runs.
    clock = recent.nextRunAt! + 2 * 60 * MIN
    store.routines.update(old.id, { nextRunAt: clock - CATCH_UP_WINDOW_MS - MIN })

    const restarted = make()
    restarted.start()
    expect(runtime.calls.map((c) => [c.text, c.via])).toEqual([['A', 'catch-up']])
    expect(restarted.runs({ routineId: old.id })[0]).toMatchObject({ status: 'skipped', trigger: 'catch-up' })
    expect(store.routines.get(recent.id)!.nextRunAt).toBe(at(8, 0) + 24 * 60 * MIN)
    void restarted.shutdown()
  })

  it('lets planned runs pass while routines are paused', () => {
    const r = service.save({ botId: bot.id, name: 'Paused', prompt: 'A', schedule: { kind: 'interval', everyMinutes: 30 } })
    store.settings.update({ background: { ...store.settings.get().background, routinesPaused: true } })
    service.start()
    clock = r.nextRunAt! + MIN
    service.tick()
    expect(runtime.calls).toHaveLength(0)
    expect(service.runs({ routineId: r.id })).toHaveLength(0)
    expect(store.routines.get(r.id)!.nextRunAt).toBeGreaterThan(clock)
    // Run now still works.
    service.runNow(r.id)
    expect(runtime.calls[0]!.via).toBe('manual')
  })

  it('maps a limited run to skipped with the reason', async () => {
    const r = service.save({ botId: bot.id, name: 'Limited', prompt: 'A', schedule: { kind: 'manual' } })
    service.runNow(r.id)
    runtime.calls[0]!.finish({ status: 'limited', reply: '', error: 'Stark reached its daily limit of 3 automatic runs.' })
    await service.idle()
    expect(service.runs({ routineId: r.id })[0]).toMatchObject({ status: 'skipped', summary: expect.stringContaining('Stark reached its daily limit of 3 automatic runs.'), acceptance: { status: 'unverified' } })
  })

  it('cancels a running run when the routine is deleted', async () => {
    const r = service.save({ botId: bot.id, name: 'Doomed', prompt: 'A', schedule: { kind: 'manual' } })
    service.runNow(r.id)
    service.delete(r.id)
    expect(runtime.calls[0]!.signal?.aborted).toBe(true)
    await service.idle()
    expect(service.list(bot.id)).toEqual([])
  })

  it('checks webhook calls: address, token, size, rate and overlap', async () => {
    const r = service.save({ botId: bot.id, name: 'Hook', prompt: 'Handle the event', schedule: { kind: 'manual' }, webhookEnabled: true })
    const status = (fn: () => unknown) => {
      try {
        fn()
        return 0
      } catch (err) {
        return err instanceof WebhookError ? err.status : -1
      }
    }
    // No token yet: the routine does not accept webhooks.
    expect(status(() => service.triggerWebhook(r.id, 'anything', ''))).toBe(404)
    const token = service.newWebhookToken(r.id)
    expect(token).toMatch(/^fbr_/)
    expect(store.routines.get(r.id)!.hasWebhookToken).toBe(true)
    expect(status(() => service.triggerWebhook('nope', token, ''))).toBe(404)
    expect(status(() => service.triggerWebhook(r.id, 'wrong', ''))).toBe(401)
    expect(status(() => service.triggerWebhook(r.id, token, 'x'.repeat(20_000)))).toBe(413)

    const run = service.triggerWebhook(r.id, token, 'order #42 shipped')
    expect(run.trigger).toBe('webhook')
    expect(runtime.calls[0]!.text).toContain('Handle the event')
    expect(runtime.calls[0]!.text).toContain('<<<WEBHOOK DATA\norder #42 shipped\nWEBHOOK DATA>>>')
    expect(status(() => service.triggerWebhook(r.id, token, ''))).toBe(409)
    runtime.calls[0]!.finish()
    await service.idle()

    for (let i = 1; i < WEBHOOK_RUNS_PER_HOUR; i++) {
      service.triggerWebhook(r.id, token, '')
      runtime.calls.at(-1)!.finish()
      await service.idle()
    }
    expect(status(() => service.triggerWebhook(r.id, token, ''))).toBe(429)
    clock += 61 * MIN
    expect(status(() => service.triggerWebhook(r.id, token, ''))).toBe(0)

    // A new token replaces the old one; turning webhooks off closes the door.
    const fresh = service.newWebhookToken(r.id)
    runtime.calls.at(-1)!.finish()
    await service.idle()
    expect(status(() => service.triggerWebhook(r.id, token, ''))).toBe(401)
    service.save({ ...r, webhookEnabled: false })
    expect(status(() => service.triggerWebhook(r.id, fresh, ''))).toBe(404)
  })

  it('closes runs a crash left running', () => {
    const r = service.save({ botId: bot.id, name: 'Crash', prompt: 'A', schedule: { kind: 'manual' } })
    store.routines.startRun({ routineId: r.id, botId: bot.id, trigger: 'manual', status: 'running', startedAt: clock })
    const restarted = make()
    restarted.start()
    expect(restarted.runs({ routineId: r.id })[0]).toMatchObject({ status: 'cancelled', error: 'faibots closed during the run' })
    void restarted.shutdown()
  })

  it('goes away with its bot', () => {
    service.save({ botId: bot.id, name: 'Mine', prompt: 'A', schedule: { kind: 'manual' } })
    store.bots.delete(bot.id)
    expect(service.list()).toEqual([])
  })

  describe('bot tools', () => {
    it('turns the tool schedule into a routine schedule', () => {
      expect(toSchedule({ at: '08:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] })).toEqual({ kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] })
      expect(toSchedule({ at: '18:30' })).toEqual({ kind: 'daily', time: '18:30', days: [0, 1, 2, 3, 4, 5, 6] })
      expect(toSchedule({ every_minutes: 60 })).toEqual({ kind: 'interval', everyMinutes: 60 })
      expect(toSchedule({})).toEqual({ kind: 'manual' })
      expect(() => toSchedule({ every_minutes: 60, at: '08:00' })).toThrow('not both')
    })

    it('lets a bot create, list and delete only its own routines', async () => {
      const other = store.bots.create({ name: 'Other' })
      service.save({ botId: other.id, name: 'Not yours', prompt: 'A', schedule: { kind: 'manual' } })
      const [create, list, remove] = routineTools(service)
      const ctx = { bot } as never
      const created = await create!.execute({ name: 'Brief', task: 'Brief me', schedule: { at: '08:00', days: ['mon'] } }, ctx)
      expect(created.isError).toBeFalsy()
      expect(created.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Mon at 08:00') })
      const mine = service.list(bot.id)
      expect(mine).toMatchObject([{ name: 'Brief', createdBy: 'bot' }])

      const listed = await list!.execute({}, ctx)
      expect(listed.content[0]).toMatchObject({ text: expect.stringContaining('Brief') })
      expect(listed.content[0]).toMatchObject({ text: expect.not.stringContaining('Not yours') })

      const theirs = service.list(other.id)[0]!
      expect((await remove!.execute({ id: theirs.id }, ctx)).isError).toBe(true)
      expect((await remove!.execute({ id: mine[0]!.id }, ctx)).isError).toBeFalsy()
      expect(service.list(bot.id)).toEqual([])
      expect(service.list(other.id)).toHaveLength(1)
    })
  })
})
