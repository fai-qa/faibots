import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SpecialistJobKind } from '@shared/specialist-work'
import type { ToolResult } from '../contracts'
import { comparableAssignments, comparableRoute } from '../store/comparable-assignments'
import { workBriefs } from '../store/work-briefs'
import { createHarness, type Harness } from './testing/fakes'

const text = (result: ToolResult) => result.content.map(item => item.type === 'text' ? item.text : '').join('')

describe('comparing specialist candidates', () => {
  let h: Harness
  beforeEach(() => { h = createHarness() })
  afterEach(async () => { await h.runtime.shutdown(); h.cleanup() })

  it('shows matching work, measured child tokens and team acceptance separately for each candidate', async () => {
    const chief = h.bot('fai', { isPrimary: true })
    const researcher = h.bot('Researcher')
    const editor = h.bot('Editor')
    const dm = h.runtime.openDm(chief.id)
    const briefs = workBriefs(h.services.store.db)
    h.engine.script(researcher.handle, api => {
      api.turn.recorder.addUsage({ inputTokens: 9, outputTokens: 5 })
      api.say('Checked the catalogue.')
      api.say('Confirmed the edition.')
    })
    h.engine.script(editor.handle, api => {
      api.turn.recorder.addUsage({ inputTokens: 70, outputTokens: 5 })
      api.turn.recorder.addUsage({ outputTokens: 10 }) // Second call omitted the input count.
      api.say('Checked the licence.')
    })
    h.engine.script(chief.handle, async api => {
      const brief = briefs.start(dm.id, api.turn.toolContext.userEntryId!, api.turn.turnId, 'Check supplier entries', 'two sources', 'read both')
      for (const to of [researcher.handle, researcher.handle, editor.handle]) {
        const result = await api.tool('send_to_agent', { to, message: 'Confirm this item.', jobKind: 'research' })
        if (result.isError) throw new Error(text(result))
      }
      const review = briefs.submit(dm.id, brief.id, brief.revision, 'result', 'Two sources checked.', [], api.turn.turnId, false)
      briefs.decide(dm.id, { id: brief.id, revision: review.revision, decision: 'accept', note: '' })
      api.say('Complete.')
    })
    await h.send(dm.id, 'Check the supplier catalogue.')

    let directory = ''
    h.engine.script(chief.handle, async api => {
      directory = text(await api.tool('list_bots', { jobKind: 'research' }))
      api.say('Compared the two candidates.')
    })
    await h.send(dm.id, 'Who handled this kind of work before?')
    const rows = directory.split('\n')
    expect(rows.find(row => row.startsWith('- @researcher'))).toMatch(/2 answered\. Median turnaround [\d.]+ ms\. Median 14 total tokens.*2 metered child turn.*Owner-accepted team jobs: 1\. Individual accuracy and spend unknown/)
    expect(rows.find(row => row.startsWith('- @editor'))).toMatch(/1 answered\. Median turnaround [\d.]+ ms\. Token use unknown\. Owner-accepted team jobs: 1/)
  })

  it('excludes other chats, providers, models, categories, unclassified history and ambiguous links', async () => {
    const chief = h.bot('fai', { isPrimary: true })
    const expert = h.bot('Researcher')
    const other = h.bot('Planner')
    const dm = h.runtime.openDm(chief.id)
    const foreign = h.runtime.openDm(other.id)
    const store = h.services.store
    const original = { providerId: h.providerId, modelId: '' }
    const criteria = { ...comparableRoute(store.providers.get(h.providerId)!, 'test-model')!, kind: 'research' as const }
    const sample = () => comparableAssignments(store.db, expert.id, dm.id, criteria)
    let tokens = 17
    let kind: SpecialistJobKind | undefined = 'research'
    h.engine.script(expert.handle, api => {
      api.turn.recorder.addUsage({ inputTokens: tokens, outputTokens: 0 })
      api.say('Done.')
    })
    for (const caller of [chief, other]) h.engine.script(caller.handle, async api => {
      const result = await api.tool('send_to_agent', { to: expert.handle, jobKind: kind, message: 'Research this supplier.' })
      if (result.isError) throw new Error(text(result))
      api.say('Received.')
    })
    await h.send(dm.id, 'Comparable job')
    tokens = 999
    await h.send(foreign.id, 'Other chat')
    kind = 'writing'
    await h.send(dm.id, 'Write a memo')
    kind = undefined
    await h.send(dm.id, 'Unclassified job with research in its text')
    kind = 'research'
    store.bots.update(expert.id, { model: { providerId: h.providerId, modelId: 'different-model' } })
    await h.send(dm.id, 'Different model')
    const provider = h.providers.save({ kind: 'openai-compatible', label: 'Second local provider',
      baseUrl: 'http://localhost:11500/v1', defaultModelId: 'test-model', enabled: true })
    store.bots.update(expert.id, { model: { providerId: provider.id, modelId: '' } })
    await h.send(dm.id, 'Different provider with identical model name')
    store.bots.update(expert.id, { model: original })
    expect(sample()).toMatchObject({ count: 1, metered: 1, medianTokens: 17, acceptedTeamJobs: 0 })
    expect(comparableAssignments(store.db,expert.id,foreign.id,criteria)).toMatchObject({count:1,medianTokens:999})
    const relocated = { ...store.providers.get(h.providerId)!, baseUrl:'http://localhost:11501/v1' }
    expect(comparableAssignments(store.db,expert.id,dm.id,{ ...criteria, ...comparableRoute(relocated, 'test-model')! }).count).toBe(0)

    const exchange = store.conversations.findExchange(chief.id, expert.id)!
    const firstReply = store.entries.page(exchange.id, { limit: 100 }).entries.find(e => e.replyToId)!
    const question = store.entries.get(firstReply.replyToId!)!
    // A classified project question from an older build cannot contribute to an ordinary chat comparison.
    store.entries.update(question.id, { meta: { ...question.meta, projectScoped: true } })
    expect(sample()).toMatchObject({ count: 0, metered: 0, medianTokens: null })
    store.entries.update(question.id, { meta: question.meta })
    store.entries.append({ conversationId:exchange.id, kind:'message', author:{kind:'bot',botId:expert.id},
      replyToId:firstReply.replyToId!, text:'Historical reply without a turn ID.', mentions:[], mentionsEveryone:false, attachments:[], isStreaming:false })
    expect(sample()).toMatchObject({ count: 0, metered: 0, medianTokens: null })
  })

  it('preserves the category on background work and excludes unconfirmed subscription usage', async () => {
    for (const tool of h.runtime.assignments.tools()) h.services.tools.register(tool)
    const chief = h.bot('fai', { isPrimary: true })
    const expert = h.bot('Editor')
    const dm = h.runtime.openDm(chief.id)
    const subscription = h.providers.save({ kind: 'codex', label: 'Test subscription',
      defaultModelId: 'test-codex', enabled: true })
    h.services.store.bots.update(expert.id, { model: {providerId:subscription.id, modelId:'test-codex'} })
    const criteria = { ...comparableRoute(subscription, 'test-codex')!, kind:'review' as const }
    expect(comparableRoute(subscription, 'default')).toBeUndefined()
    const sample = () => comparableAssignments(h.services.store.db,expert.id,dm.id,criteria)
    let measured = true
    h.engine.script(expert.handle, api => {
      api.turn.recorder.recordCodexUsage({ inputTokens:0, outputTokens:0 })
      if (!measured) api.turn.recorder.recordCodexUsage()
      api.say('Reviewed.')
    })
    h.engine.script(chief.handle, async api => {
      const started = await api.tool('assign_to_agent', { to:expert.handle, message:'Review this note.', jobKind:'review' })
      const id = /Assignment (\S+) is running/.exec(text(started))?.[1]
      if (!id) throw new Error(text(started))
      await api.tool('wait_for_assignment', { id, seconds:1 })
      api.say('Reviewed.')
    })
    await h.send(dm.id,'First note.')
    measured = false
    await h.send(dm.id,'Second note.')
    expect(sample()).toMatchObject({count:2,metered:1,medianTokens:0})
    h.services.store.db.prepare("update turns set codex_usage_state=null where provider_id=? and codex_usage_state='measured'").run(subscription.id)
    expect(sample()).toMatchObject({count:2,metered:0,medianTokens:null})
  })

  it('uses at most the latest 20 answered matching jobs for both medians', async () => {
    const chief = h.bot('fai')
    const expert = h.bot('Researcher')
    const dm = h.runtime.openDm(chief.id)
    const store = h.services.store
    const route = comparableRoute(store.providers.get(h.providerId)!, 'test-model')!
    let tokens = 0
    h.engine.script(expert.handle, api => {
      api.turn.recorder.addUsage({ inputTokens: tokens++, outputTokens: 0 })
      api.say('Done.')
    })
    h.engine.script(chief.handle, async api => {
      await api.tool('send_to_agent', { to: expert.handle, jobKind: 'analysis', message: 'Check this entry.' })
      api.say('Received.')
    })
    for (let i = 0; i < 21; i++) await h.send(dm.id, `Check invoice ${i}.`)
    const assignments = store.db.prepare('select id from delegations order by rowid').all()
    expect(assignments).toHaveLength(21)
    // Pin the observed clock intervals so the midpoint can be checked exactly across machines.
    const elapsed = store.db.prepare('update delegations set updated_at=created_at+? where id=?')
    assignments.forEach((item, index) => elapsed.run(100 * (index + 1), String(item.id)))
    const sample = comparableAssignments(store.db, expert.id, dm.id, { ...route, kind: 'analysis' })
    expect(sample).toEqual({ count: 20, medianMs: 1150, metered: 20, medianTokens: 10.5, acceptedTeamJobs: 0 })
  })
})
