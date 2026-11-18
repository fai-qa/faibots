import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { build } from 'vite'
import { openStore } from '../src/main/store'

const root = mkdtempSync(join(tmpdir(), 'faibots-budget-workers-'))
beforeAll(async () => {
  await build({ configFile: false, logLevel: 'silent', resolve: { alias: { '@shared': resolve('src/shared') } },
    ssr: { noExternal: true }, build: { ssr: resolve('tests/fixtures/budget-worker.ts'), target: 'node24',
      outDir: root, emptyOutDir: false, rollupOptions: { output: { entryFileNames: 'worker.mjs' } } } })
}, 30_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

function message(child: ChildProcess): Promise<Record<string, boolean>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('budget worker timeout')) }, 10_000)
    const receive = (m: unknown) => { cleanup(); resolve(m as Record<string, boolean>) }
    const exited = () => { cleanup(); reject(new Error('budget worker exited before response')) }
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exited) }
    child.once('message', receive); child.once('exit', exited)
  })
}
it('two processes race for one slot and termination cannot refund the winner', async () => {
  const path = join(root, 'test.db'); const store = openStore(path, { homeDir: root })
  const bot = store.bots.create({ name: 'Budget', dailyRunLimit: 1 }); const at = Date.now()
  store.close()
  const children = [0, 1].map((i) => fork(join(root, 'worker.mjs'), [path, bot.id, `child-${i}`, String(at)],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
  try {
    expect(await Promise.all(children.map(message))).toEqual([{ ready: true }, { ready: true }])
    const results = children.map((child) => { const answer = message(child); child.send('go'); return answer })
    expect((await Promise.all(results)).map((r) => r.admitted).sort()).toEqual([false, true])
  } finally {
    await Promise.all(children.map(async (child) => { if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended
    } }))
  }
  const reopened = openStore(path, { homeDir: root })
  try {
    expect(reopened.turns.automaticRunsSince(bot.id, 0)).toBe(1)
    expect(reopened.turns.reserveAutomatic({ id: 'after-crash', botId: bot.id, startedAt: at })).toBe(false)
  } finally { reopened.close() }
})
