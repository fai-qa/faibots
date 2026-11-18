import { describe, expect, it } from 'vitest'
import type { Bot, Conversation, Entry } from '@shared/domain'
import { LiveStates } from './live-state'
import { TurnRecorder } from './turn-recorder'

function setup(budget: { left: number } | undefined) {
  const entries: Entry[] = []
  const bus = { emit: () => undefined } as never
  const store = {
    entries: {
      append: (e: Omit<Entry, 'id' | 'seq' | 'createdAt' | 'updatedAt'>) => {
        const stored = { ...e, id: `e${entries.length + 1}`, seq: entries.length + 1, createdAt: 0, updatedAt: 0 } as unknown as Entry
        entries.push(stored)
        return stored
      },
      update: (id: string, patch: Partial<Entry>) => {
        const i = entries.findIndex((e) => e.id === id)
        entries[i] = { ...entries[i], ...patch } as Entry
        return entries[i]
      }
    },
    conversations: { get: () => undefined }
  } as never
  const bot = { id: 'b1', name: 'Ann' } as Bot
  const conversation = { id: 'c1' } as Conversation
  let refusedCalls = 0
  const rec = new TurnRecorder(
    { store, bus, live: new LiveStates(bus), redact: (s) => s },
    {
      bot,
      conversation,
      members: [bot],
      ...(budget && {
        reservePost: () => budget.left-- > 0,
        onRefused: () => void refusedCalls++
      })
    }
  )
  return { rec, entries, refused: () => refusedCalls }
}

const messages = (entries: Entry[]) => entries.filter((e) => e.kind === 'message')

describe('TurnRecorder post budget', () => {
  it('reserves one post per message entry: text, tool, text, tool, text with budget 2', () => {
    const budget = { left: 2 }
    const { rec, entries, refused } = setup(budget)
    rec.textDelta('one')
    rec.toolStart('t1', 'search', 'Search', {})
    rec.toolEnd('t1', { content: [{ type: 'text', text: 'ok' }] }, false)
    rec.textDelta('two')
    rec.toolStart('t2', 'search', 'Search', {})
    rec.textDelta('three')
    rec.finish(false)
    expect(messages(entries).map((m) => m.text)).toEqual(['one', 'two'])
    expect(rec.posts).toHaveLength(2)
    expect(rec.budgetRefused).toBe(true)
    expect(refused()).toBe(1)
  })

  it('a single message takes a single reservation, however many deltas', () => {
    const budget = { left: 1 }
    const { rec, entries } = setup(budget)
    rec.textDelta('hel')
    rec.textDelta('lo')
    rec.finish(false)
    expect(messages(entries)).toHaveLength(1)
    expect(rec.budgetRefused).toBe(false)
    expect(budget.left).toBe(0)
  })

  it('a tools-only turn or blank text reserves nothing', () => {
    const budget = { left: 1 }
    const { rec, entries } = setup(budget)
    rec.textDelta('  \n')
    rec.toolStart('t1', 'search', 'Search', {})
    rec.textDelta(' ')
    rec.finish(false)
    expect(messages(entries)).toHaveLength(0)
    expect(budget.left).toBe(1)
  })

  it('members sharing one budget never exceed it', () => {
    const budget = { left: 2 }
    const turns = [setup(budget), setup(budget), setup(budget)]
    for (const t of turns) {
      t.rec.textDelta('a')
      t.rec.toolStart('x', 'search', 'Search', {})
      t.rec.textDelta('b')
      t.rec.finish(false)
    }
    expect(turns.reduce((n, t) => n + messages(t.entries).length, 0)).toBe(2)
  })

  it('without reservePost nothing is limited', () => {
    const { rec, entries } = setup(undefined)
    rec.textDelta('a')
    rec.toolStart('x', 'search', 'Search', {})
    rec.textDelta('b')
    rec.finish(false)
    expect(messages(entries)).toHaveLength(2)
  })
})
