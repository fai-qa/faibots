import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { openStore } from '../src/main/store'

const root = mkdtempSync(join(tmpdir(), 'faibots-action-tests-'))
const bundle = join(root, 'worker.mjs')
beforeAll(async () => {
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@shared': resolve('src/shared') } },
    ssr: { noExternal: true }, build: { ssr: resolve('tests/fixtures/action-worker.ts'), target: 'node24',
      outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'worker.mjs' } } } })
}, 30_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function child(dir: string, mode: string, supported: boolean, terminate: boolean): Promise<Record<string, any>> {
  const p = fork(bundle, [dir, mode, supported ? 'yes' : 'no'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''
  p.stderr?.on('data', (data) => { stderr += String(data).slice(0, 2000) })
  try {
    const message = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker timeout: ${stderr}`)), 15_000)
      p.once('message', (m) => { clearTimeout(timer); resolve(m as Record<string, any>) })
      p.once('error', (err) => { clearTimeout(timer); reject(err) })
      p.once('exit', (code) => { clearTimeout(timer); reject(new Error(`worker exited ${code}: ${stderr}`)) })
    })
    const exited = once(p, 'exit')
    if (terminate) p.kill('SIGKILL')
    await exited
    return message
  } finally { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL') }
}
const effects = (dir: string) => existsSync(join(dir, 'effects.jsonl')) ?
  readFileSync(join(dir, 'effects.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : []
const record = (dir: string) => { const store = openStore(join(dir, 'test.db'), { homeDir: dir });
  try { return store.actions.get('stable-action')! } finally { store.close() } }

describe('process crash and restart', () => {
  it('before dispatch: retains intent, has zero effects, and safely dispatches once on retry', async () => {
    const dir = mkdtempSync(join(root, 'before-'))
    await child(dir, 'before', false, true)
    expect(effects(dir)).toHaveLength(0)
    expect(record(dir)).toMatchObject({ id: 'stable-action', state: 'claimed', approvedDigest: undefined })
    expect(await child(dir, 'retry', false, false)).toMatchObject({ state: 'completed' })
    expect(effects(dir)).toHaveLength(1)
  })
  it('after external commit: unsupported retry is blocked across two fresh processes', async () => {
    const dir = mkdtempSync(join(root, 'unknown-'))
    await child(dir, 'after', false, true)
    expect(record(dir).state).toBe('dispatched')
    expect(effects(dir)).toHaveLength(1)
    expect(await child(dir, 'retry', false, false)).toMatchObject({ state: 'unknown', result: { isError: true } })
    expect(await child(dir, 'retry', false, false)).toMatchObject({ state: 'unknown', result: { isError: true } })
    expect(effects(dir)).toHaveLength(1)
  })
  it('recovers an original receipt by a supported provider idempotency key after termination', async () => {
    const dir = mkdtempSync(join(root, 'supported-'))
    await child(dir, 'after', true, true)
    expect(await child(dir, 'retry', true, false)).toMatchObject({ state: 'completed', result: { content: [{ text: 'original receipt' }] } })
    expect(effects(dir)).toHaveLength(1)
  })
  it('after local receipt: a fresh process replays the receipt without dispatch', async () => {
    const dir = mkdtempSync(join(root, 'receipt-'))
    await child(dir, 'receipt', false, true)
    expect(record(dir).state).toBe('completed')
    expect(await child(dir, 'retry', false, false)).toMatchObject({ state: 'completed', result: { content: [{ text: 'original receipt' }] } })
    expect(effects(dir)).toHaveLength(1)
  })
  it('two real worker processes cannot dispatch the same identity twice', async () => {
    const dir = mkdtempSync(join(root, 'concurrent-'))
    await child(dir, 'before', false, true)
    // Startup recovery has one owner; competing workers must not reset active claims.
    const store = openStore(join(dir, 'test.db'), { homeDir: dir })
    store.actions.recoverInterrupted(); store.close()
    await Promise.all([child(dir, 'concurrent', false, false), child(dir, 'concurrent', false, false)])
    expect(effects(dir)).toHaveLength(1)
  })
})
