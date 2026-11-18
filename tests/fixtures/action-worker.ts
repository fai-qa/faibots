// Disposable subprocess for actual termination/restart tests. No real profile or network.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolContext, ToolResult } from '../../src/main/contracts'
import { openStore } from '../../src/main/store'
import { createToolRegistry } from '../../src/main/tools/registry'
import { createApprovalService } from '../../src/main/tools/approvals'
import { textResult } from '../../src/main/tools/define'

const [dir, mode, supported] = process.argv.slice(2) as [string, string, string]
const store = openStore(join(dir, 'test.db'), { homeDir: dir })
if (mode !== 'concurrent') store.actions.recoverInterrupted()
const idsPath = join(dir, 'ids.json')
if (!existsSync(idsPath)) {
  const bot = store.bots.create({ name: 'Disposable worker' })
  const conversation = store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
  writeFileSync(idsPath, JSON.stringify({ bot: bot.id, conversation: conversation.id }))
}
const ids = JSON.parse(readFileSync(idsPath, 'utf8')) as { bot: string; conversation: string }
const ctx: ToolContext = { bot: store.bots.get(ids.bot)!, conversation: store.conversations.get(ids.conversation)!,
  turnId: 'turn', callId: 'call', actionId: 'stable-action', signal: new AbortController().signal,
  chain: [], inGroup: false, workspaceDir: dir }
const bus = { emit() {} }
const approvals = createApprovalService({ store, bus })
const hold = async () => { process.send!({ ready: true }); await new Promise<void>(() => { setInterval(() => {}, 1000) }) }
if (mode === 'before') approvals.subscribe((e) => { if (e.state === 'pending') void hold() })
const registry = createToolRegistry({ store, bus, approvals, secrets: { redact: (s) => s },
  mcp: { allTools: async () => [], toolsForBot: async () => [] } })
// A provider with real durable idempotency in this fake: duplicate key returns original result.
const service = (key: string): ToolResult => {
  const file = join(dir, 'effects.jsonl')
  const previous = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((s) => JSON.parse(s) as { key: string; result: ToolResult }).find((r) => r.key === key) : undefined
  if (previous && supported === 'yes') return previous.result
  const result = textResult('original receipt')
  appendFileSync(file, JSON.stringify({ key, result }) + '\n')
  return result
}
registry.register({ name: 'effect', description: '', inputSchema: {}, source: 'builtin',
  defaultPermission: mode === 'before' ? 'ask' : 'always', activityLabel: 'Disposable action',
  ...(supported === 'yes' ? { recovery: { version: 'fake/v1', recover: async (_input: unknown, c: ToolContext) => service(c.actionId!) } } : {}),
  execute: async (_input, c) => {
    const result = service(c.actionId!)
    if (mode === 'after') await hold()
    return result
  }
})
const result = await registry.execute('effect', { amount: 1 }, ctx)
if (mode === 'receipt') await hold()
process.send!({ result, state: store.actions.get('stable-action')?.state })
store.close()
process.disconnect!()
