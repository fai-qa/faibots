import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, renameSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RoutineInput } from '@shared/domain'
import type { AutomatedRunResult } from '../contracts'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { createRoutineService } from './routines'
import { createHarness } from '../agent/testing/fakes'
import { textResult } from '../tools/define'

describe('host-verified routine acceptance', () => {
  let dir: string, workspace: string, store: PlatformStore, input: RoutineInput
  let service: ReturnType<typeof createRoutineService>
  let finish: (result: Partial<AutomatedRunResult>) => void
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-acceptance-'))
    store = openStore(join(dir, 'test.db'), { homeDir: dir })
    const bot = store.bots.create({ name: 'Writer' })
    store.settings.update({ workspaceRoot: join(dir, 'workspaces') })
    workspace = join(dir, 'workspaces', bot.handle); mkdirSync(workspace, { recursive: true })
    input = { botId: bot.id, name: 'Report', prompt: 'Create report.txt', schedule: { kind: 'manual' },
      acceptance: { checks: [{ path: 'report.txt', contains: 'Revenue: 42' }] } }
    service = createRoutineService({ store, bus: fakeBus(), runtime: {
      runAutomated: async () => new Promise<AutomatedRunResult>((resolve) => {
        finish = (r) => resolve({ status: 'done', conversationId: 'dm', entryId: 'e', reply: 'I finished everything.', ...r })
      })
    } })
  })
  afterEach(async () => { await service.shutdown(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  const done = async (result: Partial<AutomatedRunResult> = {}) => { finish(result); await service.idle(); return service.runs({})[0]! }

  it('does not accept successful prose without an owner contract', async () => {
    const r = service.save({ ...input, acceptance: undefined }); service.runNow(r.id)
    expect(await done()).toMatchObject({ status: 'done', acceptance: { status: 'unverified' }, summary: expect.stringMatching(/unverified/i) })
  })
  it('passes a newly written matching file and preserves bounded evidence on reopen', async () => {
    const r = service.save(input); service.runNow(r.id)
    writeFileSync(join(workspace, 'report.txt'), 'Revenue: 42\n')
    const result = await done()
    expect(result.acceptance).toMatchObject({ status: 'passed', checks: [{ path: 'report.txt', status: 'passed',
      observedSha256: createHash('sha256').update('Revenue: 42\n').digest('hex'), bytes: 12 }] })
    store.close(); store = openStore(join(dir, 'test.db'), { homeDir: dir })
    expect(store.routines.runs({})[0]?.acceptance).toEqual(result.acceptance)
    expect(JSON.stringify(result.acceptance)).not.toContain('I finished everything')
  })
  it.each(['missing', 'wrong', 'unchanged', 'oversize'] as const)('fails %s artifact instead of accepting the reply', async (kind) => {
    if (kind === 'unchanged') writeFileSync(join(workspace, 'report.txt'), 'Revenue: 42')
    const r = service.save(input); service.runNow(r.id)
    if (kind === 'wrong') writeFileSync(join(workspace, 'report.txt'), 'Revenue: 0')
    if (kind === 'oversize') writeFileSync(join(workspace, 'report.txt'), 'Revenue: 42' + 'x'.repeat(1024 * 1024))
    expect((await done()).acceptance?.status).toBe('failed')
  })
  it('keeps the start contract when the owner changes it during a run', async () => {
    const r = service.save(input); service.runNow(r.id)
    service.save({ ...input, id: r.id, acceptance: { checks: [{ path: 'report.txt', contains: 'wrong' }] } })
    writeFileSync(join(workspace, 'report.txt'), 'wrong')
    const result = await done()
    expect(result.acceptance).toMatchObject({ status: 'failed', checks: [{ contains: 'Revenue: 42' }] })
  })
  it('checks an exact SHA-256 contract and does not store file bodies', async () => {
    const content = 'confidential body'
    const r = service.save({ ...input, acceptance: { checks: [{ path: 'out.bin', sha256: createHash('sha256').update(content).digest('hex') }] } })
    service.runNow(r.id); writeFileSync(join(workspace, 'out.bin'), content)
    const result = await done()
    expect(result.acceptance?.status).toBe('passed')
    expect(JSON.stringify(result.acceptance)).not.toContain(content)
  })
  it.each(['error', 'cancelled', 'limited', 'skipped'] as const)('does not verify artifacts after %s execution', async (status) => {
    const r = service.save(input); service.runNow(r.id)
    writeFileSync(join(workspace, 'report.txt'), 'Revenue: 42')
    expect((await done({ status })).acceptance?.status).toBe('unverified')
  })
  it('rejects bot-authored acceptance and invalid contracts without changing existing data', () => {
    expect(() => service.save(input, 'bot')).toThrow(/owner/i)
    for (const path of ['../outside.txt', 'C:\\outside.txt', '/outside.txt', 'a/../../x', 'file:stream']) {
      expect(() => service.save({ ...input, acceptance: { checks: [{ path, contains: 'yes' }] } })).toThrow()
    }
    expect(() => service.save({ ...input, acceptance: { checks: [] } })).toThrow()
    expect(() => service.save({ ...input, acceptance: { checks: [{ path: 'x' }] } })).toThrow()
    expect(service.list()).toEqual([])
  })
  it('refuses files reached through a directory link outside the bot workspace', async () => {
    const outside = join(dir, 'outside'); mkdirSync(outside)
    symlinkSync(outside, join(workspace, 'linked'), 'junction')
    const r = service.save({ ...input, acceptance: { checks: [{ path: 'linked/report.txt', contains: 'yes' }] } })
    service.runNow(r.id); writeFileSync(join(outside, 'report.txt'), 'yes')
    expect((await done()).acceptance?.status).toBe('failed')
  })
  it('rejects replacement of the original workspace with a junction to pre-existing outside output', async () => {
    const outside = join(dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'report.txt'), 'Revenue: 42')
    const r = service.save(input); service.runNow(r.id)
    renameSync(workspace, workspace + '-original')
    symlinkSync(outside, workspace, 'junction')
    expect((await done()).acceptance).toMatchObject({ status: 'failed', reason: expect.stringMatching(/workspace/i) })
  })
  it('allows a missing workspace to be created at its pinned location during execution', async () => {
    rmdirSync(workspace)
    const r = service.save(input); service.runNow(r.id)
    mkdirSync(workspace); writeFileSync(join(workspace, 'report.txt'), 'Revenue: 42')
    expect((await done()).acceptance?.status).toBe('passed')
  })
  it('rejects redirecting an initially missing workspace to another directory', async () => {
    rmdirSync(workspace)
    const outside = join(dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'report.txt'), 'Revenue: 42')
    const r = service.save(input); service.runNow(r.id)
    symlinkSync(outside, workspace, 'junction')
    expect((await done()).acceptance?.status).toBe('failed')
  })
  it('startup closes pending evidence as unverified without re-running its checks', () => {
    const r = service.save(input)
    store.routines.startRun({ routineId: r.id, botId: r.botId, trigger: 'manual', status: 'running', startedAt: Date.now(),
      acceptance: { status: 'pending', checks: [{ path: 'report.txt', contains: 'Revenue: 42', status: 'pending' }] } })
    writeFileSync(join(workspace, 'report.txt'), 'Revenue: 42')
    service.start()
    expect(service.runs({})[0]).toMatchObject({ status: 'cancelled', acceptance: { status: 'unverified' } })
  })
})

it.each([false, true])('runtime to acceptance integration with uncertain action = %s', async (uncertain) => {
  const h = createHarness()
  const service = createRoutineService({ store: h.services.store, bus: h.services.bus, runtime: h.runtime })
  try {
    const bot = h.bot('Writer', { dailyRunLimit: 1 })
    const workspace = join(h.services.store.settings.get().workspaceRoot, bot.handle)
    mkdirSync(workspace, { recursive: true })
    h.services.tools.register({ name: 'write_report', source: 'builtin', description: '', inputSchema: {},
      defaultPermission: 'always', activityLabel: 'Writing test report', execute: async () => {
        writeFileSync(join(workspace, 'report.txt'), 'verified output')
        if (uncertain) throw new Error('lost reply after action')
        return textResult('saved')
      } })
    h.engine.script('writer', async (api) => { await api.tool('write_report', {}); api.say('Done') })
    const routine = service.save({ botId: bot.id, name: 'Build report', prompt: 'write report', schedule: { kind: 'manual' },
      acceptance: { checks: [{ path: 'report.txt', contains: 'verified output' }] } })
    service.runNow(routine.id); await service.idle()
    const run = service.runs({ routineId: routine.id })[0]!
    expect(run).toMatchObject({ status: uncertain ? 'error' : 'done', acceptance: { status: uncertain ? 'unverified' : 'passed' } })
    expect(h.services.store.turns.automaticRunsSince(bot.id, 0)).toBe(1)
  } finally { await service.shutdown(); await h.runtime.shutdown(); h.cleanup() }
})

it('a coalesced failed turn cannot lend its partial reply and artifact to successful acceptance', async () => {
  const h = createHarness()
  const service = createRoutineService({ store: h.services.store, bus: h.services.bus, runtime: h.runtime })
  try {
    const bot = h.bot('Writer', { dailyRunLimit: 1 })
    const workspace = join(h.services.store.settings.get().workspaceRoot, bot.handle)
    mkdirSync(workspace, { recursive: true })
    h.engine.script('writer', (api) => { writeFileSync(join(workspace, 'report.txt'), 'partial output'); api.say('partial'); throw new Error('execution failed') })
    const definition: RoutineInput = { botId: bot.id, name: 'First', prompt: 'write report', schedule: { kind: 'manual' },
      acceptance: { checks: [{ path: 'report.txt', contains: 'partial output' }] } }
    const a = service.save(definition); const b = service.save({ ...definition, name: 'Second' })
    service.runNow(a.id); service.runNow(b.id); await service.idle()
    expect(h.engine.turns).toHaveLength(1)
    expect(service.runs({ routineId: a.id })[0]).toMatchObject({ status: 'error', acceptance: { status: 'unverified' } })
    expect(service.runs({ routineId: b.id })[0]).toMatchObject({ status: 'skipped', acceptance: { status: 'unverified' } })
  } finally { await service.shutdown(); await h.runtime.shutdown(); h.cleanup() }
})
