import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkBrief } from '@shared/work-brief'
import type { ToolResult } from '../contracts'
import { createProviderService } from '../providers/provider-service'
import { openStore } from '../store'
import { backgroundAnchor, createDelegationRepo } from '../store/delegations'
import { workBriefs } from '../store/work-briefs'
import { createApprovalService, createToolRegistry } from '../tools'
import { createRuntime } from './index'
import { MAX_ASKS_PER_CHAIN } from './orchestrator'
import { createHarness, createTestServices, FakeEngine, stubMcp } from './testing/fakes'
import { deliverWorkReplies, workBriefTools } from './work-brief-tools'

const task = { objective: 'Check the venue', deliverable: 'A location note', checks: 'Confirm the address' }
const text = (r: ToolResult) => r.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
function asBrief(r: ToolResult): WorkBrief {
  expect(r.isError, text(r)).not.toBe(true)
  return JSON.parse(text(r))
}

it.each(['returned', 'interrupted', 'cancelled'] as const)(
  'reopens a waiting chief and consumes its %s child once without reviving cancelled work',
  async (boundary) => {
    const dir = mkdtempSync(join(tmpdir(), 'faibots-wait-case-'))
    const file = join(dir, 'store.db')
    const template = createTestServices()
    let store = openStore(file, { homeDir: dir })
    try {
      const provider = createProviderService({ store, secrets: template.secrets, bus: template.bus }).save({
        kind: 'openai-compatible',
        label: 'Local fixture',
        baseUrl: 'http://127.0.0.1:1',
        enabled: true,
        defaultModelId: 'test'
      })
      const chief = store.bots.list().find((b) => b.isPrimary) ?? store.bots.create({ name: 'fai', isPrimary: true })
      store.bots.update(chief.id, { model: { providerId: provider.id, modelId: 'test' } })
      const child = store.bots.create({ name: 'Scout' })
      const parent = store.conversations.create({ kind: 'dm', title: '', botIds: [chief.id] })
      const exchange = store.conversations.create({ kind: 'exchange', title: '', botIds: [chief.id, child.id] })
      const base = { mentions: [], mentionsEveryone: false, attachments: [], isStreaming: false }
      const user = store.entries.append({
        ...base,
        conversationId: parent.id,
        author: { kind: 'user' },
        kind: 'message',
        text: 'Check where we meet.'
      })
      const work = workBriefs(store.db)
      const original = work.start(parent.id, user.id, 'root-turn', task.objective, task.deliverable, task.checks)
      const repo = createDelegationRepo(store.db, store.entries)
      repo.reserve('child', { turnId: 'root-turn', conversationId: parent.id }, MAX_ASKS_PER_CHAIN)
      const start = repo.assign(
        { id: 'child', callerId: chief.id, childId: child.id, parentId: parent.id, inputHash: 'original' },
        () => ({
          parent: store.entries.append({
            ...base,
            conversationId: parent.id,
            kind: 'event',
            author: { kind: 'system' },
            text: 'Checking',
            clientNonce: backgroundAnchor('child')
          }),
          question: store.entries.append({
            ...base,
            conversationId: exchange.id,
            kind: 'message',
            author: { kind: 'bot', botId: chief.id },
            text: 'Where do we meet?'
          })
        })
      )
      const waiting = work.wait(parent.id, original.id, original.revision, 'root-turn')
      expect(waiting.state).toBe('waiting')
      expect(work.ready(store.entries)).toEqual([])
      if (boundary === 'returned') repo.finish(start.lease!, 'answered', { text: 'Gate 4.' })
      if (boundary === 'cancelled') {
        work.decide(parent.id, { id: original.id, revision: waiting.revision, decision: 'cancel', note: '' })
        repo.finish(start.lease!, 'reconciliation_required', { text: 'Cancelled by owner.' })
      }
      store.close()
      for (let reboot = 0; reboot < 2; reboot++) {
        store = openStore(file, { homeDir: dir })
        const active = workBriefs(store.db)
        const deps = { ...template, store, mcp: stubMcp() }
        const approvals = createApprovalService(deps)
        const tools = createToolRegistry({ ...deps, approvals })
        const providers = createProviderService(deps)
        const engine = new FakeEngine(() => store)
        let calls = 0
        engine.script('fai', async (api) => {
          calls++
          const pending = active.list(parent.id)[0]!
          expect(pending.id).toBe(original.id)
          expect(pending.state).toBe('active')
          const receipt = text(await api.tool('assignment_status', { id: 'child' }))
          if (boundary === 'returned') expect(receipt).toContain('Gate 4.')
          else expect(receipt).toMatch(/reconciliation_required/)
          const result = { action: 'result', id: pending.id, revision: pending.revision, text: 'Gate 4.' }
          if (boundary === 'interrupted') {
            expect(text(await api.tool('review_work', result))).toMatch(/failed|uncertain/)
            asBrief(
              await api.tool('review_work', { ...result, text: 'The interrupted check remains unconfirmed.', partial: true })
            )
          } else asBrief(await api.tool('review_work', result))
          api.say('The check is ready to review.')
        })
        const runtime = createRuntime(
          { ...deps, approvals, providers, tools },
          { engines: { native: engine, 'claude-code': engine, codex: engine } }
        )
        try {
          for (const tool of [...runtime.assignments.tools(), ...workBriefTools(store, template.bus)]) tools.register(tool)
          await Promise.resolve()
          await runtime.idle()
          const saved = active.get(original.id, parent.id)
          if (boundary === 'cancelled') {
            expect(saved.state).toBe('cancelled')
            expect(calls).toBe(0)
          } else {
            expect(saved).toMatchObject({ state: 'review', partial: boundary === 'interrupted' })
            expect(calls).toBe(reboot === 0 ? 1 : 0)
            expect(store.db.prepare('select state from chief_wakes').all()).toEqual([{ state: 'finished' }])
            expect(
              store.db.prepare("select count(*) as n from entries where client_nonce like 'work-wake-%'").get()?.n
            ).toBe(1)
          }
          expect(active.ready(store.entries)).toEqual([])
          expect(
            store.entries.since(parent.id, 0).filter((e) => e.clientNonce?.startsWith('faibots:assignment-result:'))
          ).toHaveLength(1)
        } finally {
          await runtime.shutdown()
        }
        if (reboot === 0) store.close()
      }
    } finally {
      store.close()
      template.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('charges descendants and repeated attempts to the original chief budget after a steering decision', async () => {
  const h = createHarness()
  try {
    for (const tool of [...h.runtime.assignments.tools(), ...workBriefTools(h.services.store, h.services.bus)])
      h.services.tools.register(tool)
    const chief = h.bot('fai', { isPrimary: true })
    h.bot('Scout')
    h.bot('Reader')
    const room = h.runtime.openDm(chief.id),
      work = workBriefs(h.services.store.db)
    const refusals: string[] = [],
      cycles: string[] = []
    let firstId = '',
      firstTurn = ''
    h.engine
      .script('reader', async (api) => {
        const loop = await api.tool('send_to_agent', { to: 'fai', message: 'Ask the waiting parent again.' })
        cycles.push(text(loop))
        api.say('Read it.')
      })
      .script('scout', async (api) => {
        await api.tool('send_to_agent', { to: 'reader', message: 'Check this source.' })
        api.say('Checked the source.')
      })
      .script('fai', async (api) => {
        const current = asBrief(await api.tool('plan_work', task))
        const ask = async () => api.tool('send_to_agent', { to: 'scout', message: 'Check the venue.' })
        if (!firstId) {
          firstId = current.id
          firstTurn = api.turn.turnId
          for (let i = 0; i < 5; i++) expect((await ask()).isError).not.toBe(true)
        } else if (current.id === firstId) {
          expect(current.lastInstruction).toBe('Use the revised location.')
          expect((await ask()).isError).not.toBe(true)
          for (let i = 0; i < 2; i++) refusals.push(text(await ask()))
        } else expect((await ask()).isError).not.toBe(true)
        api.say('Recorded.')
      })
    await h.send(room.id, 'Check our venue.')
    const db = h.services.store.db
    const count = () => db.prepare('select count(*) as n from assignment_admissions where root_turn_id=?').get(firstTurn)?.n
    expect(count()).toBe(10)
    work.decide(room.id, { id: firstId, revision: 1, decision: 'steer', note: 'Use the revised location.' })
    await deliverWorkReplies(h.services.store, h.runtime)
    await h.runtime.idle()
    expect(refusals).toHaveLength(2)
    expect(refusals.every((s) => s.includes(String(MAX_ASKS_PER_CHAIN)))).toBe(true)
    expect(count()).toBe(MAX_ASKS_PER_CHAIN)
    expect(cycles.every((r) => /loop|already waiting/.test(r))).toBe(true)
    expect(cycles.length).toBe(6)
    await h.send(room.id, 'Start a separate job.')
    expect(work.list(room.id)).toHaveLength(2)
    expect(db.prepare('select count(distinct root_turn_id) as n from assignment_admissions').get()?.n).toBe(2)
    expect(count()).toBe(MAX_ASKS_PER_CHAIN)
  } finally {
    await h.runtime.shutdown()
    h.cleanup()
  }
})

it('keeps an expired worker and all later observations unconfirmed', async () => {
  const h = createHarness({ runtime: { exchangeTimeoutMs: 30 } })
  try {
    for (const tool of h.runtime.assignments.tools()) h.services.tools.register(tool)
    const chief = h.bot('fai', { isPrimary: true })
    h.bot('Slow')
    const room = h.runtime.openDm(chief.id)
    h.engine.script('slow', async (api) => {
      await api.untilAborted()
      api.say('Late answer after the deadline.')
    })
    h.engine.script('fai', async (api) => {
      await api.tool('assign_to_agent', { to: 'slow', message: 'Check the venue.' })
      api.say('Waiting for the check.')
    })
    await h.send(room.id, 'Check it.')
    const [attempt] = createDelegationRepo(h.services.store.db, h.services.store.entries).list(chief.id, room.id)
    expect(attempt).toMatchObject({
      state: 'reconciliation_required',
      lateReturn: { text: 'Late answer after the deadline.' }
    })
    expect(attempt!.receipt?.text).toMatch(/within|time/)
    await vi.waitFor(() => expect(h.services.store.actions.get(attempt!.id)?.state).toBe('unknown'))
  } finally {
    await h.runtime.shutdown()
    h.cleanup()
  }
})
