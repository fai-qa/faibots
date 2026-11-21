import { describe, expect, it } from 'vitest'
import type { Attachment, Entry } from '@shared/domain'
import { NO_NEW_MESSAGES, buildBotView, entriesAsText, withTurnNote } from './history'

let seq = 0
function entry(author: Entry['author'], text: string, extra: Partial<Entry> = {}): Entry {
  seq++
  return {
    id: `e${seq}`,
    conversationId: 'c',
    seq,
    kind: 'message',
    author,
    text,
    mentions: [],
    mentionsEveryone: false,
    attachments: [],
    isStreaming: false,
    createdAt: seq,
    updatedAt: seq,
    ...extra
  }
}

const you = { kind: 'user' } as const
const me = { kind: 'bot', botId: 'me' } as const
const ada = { kind: 'bot', botId: 'ada' } as const
const nameOf = (a: Entry['author']) => (a.kind === 'user' ? 'Alex' : a.kind === 'bot' ? (a.botId === 'me' ? 'Me' : 'Ada') : 'faibots')

describe('buildBotView', () => {
  it('own messages are assistant turns; others are named user turns, merged when consecutive', () => {
    const view = buildBotView({
      botId: 'me',
      summary: '',
      nameOf,
      entries: [
        entry(you, 'Plan the launch'),
        entry(ada, 'I can do the copy'),
        entry(me, 'I will do the numbers'),
        entry(you, 'Great'),
        entry({ kind: 'system' }, 'Ada passed', { kind: 'event' }),
        entry(ada, 'Draft is ready', { kind: 'message' }),
        entry(me, '', { kind: 'tool-call' })
      ]
    })
    expect(view).toEqual([
      { role: 'user', content: [{ type: 'text', text: '[Alex] Plan the launch\n\n[Ada] I can do the copy' }] },
      { role: 'assistant', text: 'I will do the numbers' },
      { role: 'user', content: [{ type: 'text', text: '[Alex] Great\n\n[Ada] Draft is ready' }] }
    ])
  })

  it('starts with the summary and always starts and ends on a user turn', () => {
    const view = buildBotView({ botId: 'me', summary: 'We agreed on May.', nameOf, entries: [entry(me, 'Anything else?')] })
    expect(view[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Summary of the earlier conversation, written by you:\n\nWe agreed on May.' }] })
    expect(view[1]).toEqual({ role: 'assistant', text: 'Anything else?' })
    expect(view[2]).toEqual({ role: 'user', content: [{ type: 'text', text: NO_NEW_MESSAGES }] })

    const noSummary = buildBotView({ botId: 'me', summary: '', nameOf, entries: [entry(me, 'Hello'), entry(you, 'Hi')] })
    expect(noSummary[0]!.role).toBe('user')
    expect(noSummary.at(-1)!.role).toBe('user')
  })

  it('sends the newest images as images and describes the rest', () => {
    const img = (id: string): Attachment => ({ id, name: `${id}.png`, mimeType: 'image/png', sizeBytes: 10, path: `/a/${id}.png` })
    const pdf: Attachment = { id: 'doc', name: 'spec.pdf', mimeType: 'application/pdf', sizeBytes: 2048, path: '/a/spec.pdf' }
    const view = buildBotView({
      botId: 'me',
      summary: '',
      nameOf,
      maxImages: 1,
      loadImage: (a) => ({ mediaType: a.mimeType, dataBase64: `data-${a.id}` }),
      entries: [entry(you, 'old', { attachments: [img('one')] }), entry(you, 'new', { attachments: [img('two'), pdf] })]
    })
    expect(view).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Alex] old\n[Attached file: one.png (image/png, 10 B) at /a/one.png]\n\n[Alex] new\n[Attached file: spec.pdf (application/pdf, 2 KB) at /a/spec.pdf]' },
          { type: 'image', mediaType: 'image/png', dataBase64: 'data-two' }
        ]
      }
    ])
  })

  it('notes replies', () => {
    const original = entry(ada, 'The budget is 10k')
    const view = buildBotView({ botId: 'me', summary: '', nameOf, entries: [original, entry(you, 'Is that enough?', { replyToId: original.id })] })
    expect(view[0]).toMatchObject({ content: [{ text: '[Ada] The budget is 10k\n\n[Alex] (replying to Ada: "The budget is 10k") Is that enough?' }] })
  })
})

describe('withTurnNote and entriesAsText', () => {
  it('appends the note to the newest user turn', () => {
    const view = withTurnNote([{ role: 'user', content: [{ type: 'text', text: '[Alex] hi' }] }], '(faibots: reply)')
    expect(view).toEqual([{ role: 'user', content: [{ type: 'text', text: '[Alex] hi' }, { type: 'text', text: '(faibots: reply)' }] }])
    expect(withTurnNote(view, '')).toBe(view)
  })

  it('formats entries for engines that take one prompt', () => {
    const text = entriesAsText([entry(you, 'hello'), entry(me, 'hi!'), entry(ada, 'hey')], nameOf, 'me')
    expect(text).toBe('[Alex] hello\n\n[Me (you)] hi!\n\n[Ada] hey')
  })
})
