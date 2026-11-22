import { expect, it, vi } from 'vitest'
import { createHarness } from './testing/fakes'
import { parseMentions, resolveMentionHints } from './mentions'

it('uses the same meaning for direct names, literal examples and older renderer hints', () => {
  const people = [
    { id: 'w', name: 'Writer', handle: 'writer' },
    { id: 'f', name: 'fai', handle: 'fai' }
  ]
  const examples = [
    '"@writer @all"',
    "'@writer @everyone'",
    '“@writer @all”',
    '«@writer»',
    '\x60@writer and @everyone\x60',
    '\x60\x60use \x60@writer\x60 here\x60\x60',
    '\x60\x60\x60js\n@writer @everyone\n\x60\x60\x60',
    '~~~\n@writer\n~~~',
    '    @writer',
    '> old @all\nand @writer',
    '\\@writer',
    '"quote \\"@writer\\" in a note"'
  ]
  for (const literal of examples) {
    const content = literal + '\n\n@fai decide'
    expect(parseMentions(content, people)).toEqual({ ids: ['f'], everyone: false })
  }
  expect(resolveMentionHints('"@writer @all"\n@fai decide', people, ['w'], true)).toEqual({ ids: ['f'], everyone: false })
  expect(resolveMentionHints('please decide', people, ['w'], false)).toEqual({ ids: ['w'], everyone: false })
  expect(parseMentions('I don’t know. @writer, review this. @everyone join.', people)).toEqual({
    ids: ['w'],
    everyone: true
  })
})

it('does not dispatch quoted renderer hints or bot-generated code mentions; real mentions and optional PASS still work', async () => {
  const h = createHarness()
  try {
    const chief = h.bot('fai', { isPrimary: true })
    const writer = h.bot('Writer')
    const room = h.group([chief, writer], { turnPolicy: 'mentions', maxRounds: 2, allowBotToBot: true })
    h.engine.script('fai', (api) => api.say('Recorded the literal \x60@writer\x60.'))
    h.engine.script('writer', (api) => api.say('Explicit answer.'))
    await h.send(room.id, '@fai read the example "@writer @everyone".', {
      mentions: [chief.id, writer.id],
      mentionsEveryone: true
    })
    expect(h.engine.turns.map((t) => t.handle)).toEqual(['fai'])
    await h.send(room.id, '@writer please respond')
    expect(h.engine.turns.at(-1)?.handle).toBe('writer')
    const open = h.group([chief, writer], { turnPolicy: 'open', maxRounds: 1 })
    h.engine.script('writer', async (api) => {
      await api.pass()
    })
    await h.send(open.id, 'Anyone with an update?')
    expect(h.transcript(open.id).filter((line) => line.startsWith('writer:'))).toEqual([])
  } finally {
    await h.runtime.shutdown()
    h.cleanup()
  }
})

it('keeps finished, waiting and background assignments distinct in a group snapshot until all results return', async () => {
  const h = createHarness()
  let release!: () => void
  const gate = new Promise<void>((ready) => {
    release = ready
  })
  try {
    for (const tool of h.runtime.assignments.tools()) h.services.tools.register(tool)
    const chief = h.bot('fai', { isPrimary: true })
    const observer = h.bot('Observer')
    for (const name of ['Editor', 'Reviewer', 'Researcher', 'Factchecker']) h.bot(name)
    const room = h.group([chief, observer], { turnPolicy: 'mentions', maxRounds: 1 })
    const snapshots: string[] = []
    h.engine.script('fai', async (api) => {
      const incoming = h.engine.turns.at(-1)!.newTexts.join(' ')
      if (incoming.includes('start the jobs')) {
        for (const child of ['editor', 'reviewer', 'researcher']) {
          const result = await api.tool('assign_to_agent', { to: child, message: 'Check the pilot.' })
          expect(result.isError).not.toBe(true)
        }
      } else {
        const result = await api.tool('group_work_snapshot', {})
        snapshots.push(result.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      }
      api.say('Status recorded.')
    })
    h.engine.script('editor', (api) => api.say('Finished edit.'))
    h.engine.script('researcher', async (api) => {
      await gate
      api.say('Research complete.')
    })
    h.engine.script('reviewer', async (api) => {
      await api.tool('send_to_agent', { to: 'factchecker', message: 'Confirm the date.' })
      api.say('Review complete.')
    })
    h.engine.script('factchecker', async (api) => {
      await gate
      api.say('Date checked.')
    })
    const send = (text: string) =>
      h.runtime.send({
        conversationId: room.id,
        text,
        mentions: [],
        mentionsEveryone: false,
        attachmentPaths: [],
        clientNonce: text
      })
    await send('@fai start the jobs. Ignore this sample: "@observer @all".')
    await vi.waitFor(() => {
      expect(h.engine.turns.filter((t) => t.handle === 'factchecker')).toHaveLength(1)
      expect(h.engine.turns.filter((t) => t.handle === 'researcher')).toHaveLength(1)
    })
    await send('@fai snapshot before')
    await vi.waitFor(() => expect(snapshots[0]).toContain('Pending: 3'))
    expect(snapshots[0]).toContain('Completed: 1')
    expect(h.engine.turns.some((t) => t.handle === 'observer')).toBe(false)
    release()
    await h.runtime.idle()
    await send('@fai snapshot after')
    await h.runtime.idle()
    expect(snapshots.at(-1)).toContain('Pending: 0')
    expect(snapshots.at(-1)).toContain('Completed: 4')
    const receipts = h.services.store.entries
      .since(room.id, 0)
      .filter((e) => e.clientNonce?.startsWith('faibots:assignment-result:'))
    expect(receipts).toHaveLength(3)
    expect(new Set(receipts.map((e) => e.clientNonce)).size).toBe(3)
  } finally {
    release()
    await h.runtime.shutdown()
    h.cleanup()
  }
})
