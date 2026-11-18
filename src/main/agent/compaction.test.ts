import { describe, expect, it } from 'vitest'
import type { Entry } from '@shared/domain'
import { DEFAULT_CONTEXT_WINDOW, KEEP_VERBATIM, estimateTokens, needsCompaction, planCompaction, summarize, summarizeCovered } from './compaction'
import { ScriptedAdapter } from './testing/scripted-adapter'

const entry = (seq: number, kind: Entry['kind'] = 'message'): Entry => ({
  id: `e${seq}`,
  conversationId: 'c',
  seq,
  kind,
  author: seq % 2 ? { kind: 'user' } : { kind: 'bot', botId: 'me' },
  text: `text ${seq}`,
  mentions: [],
  mentionsEveryone: false,
  attachments: [],
  isStreaming: false,
  createdAt: seq,
  updatedAt: seq
})

describe('compaction trigger', () => {
  it('estimates tokens as characters / 3.5', () => {
    expect(estimateTokens(350)).toBe(100)
    expect(estimateTokens(351)).toBe(101)
  })

  it('triggers past compactAt × the context window', () => {
    // 0.7 × 1000 = 700 tokens = 2450 characters.
    expect(needsCompaction({ promptChars: 2450, contextWindow: 1000, compactAt: 0.7 })).toBe(false)
    expect(needsCompaction({ promptChars: 2455, contextWindow: 1000, compactAt: 0.7 })).toBe(true)
  })

  it('uses a 200k window when the model does not say', () => {
    const limit = 0.7 * DEFAULT_CONTEXT_WINDOW * 3.5
    expect(needsCompaction({ promptChars: limit, compactAt: 0.7 })).toBe(false)
    expect(needsCompaction({ promptChars: limit + 10, compactAt: 0.7 })).toBe(true)
  })
})

describe('planCompaction', () => {
  it('keeps the last 12 message entries verbatim', () => {
    const entries = Array.from({ length: 20 }, (_, i) => entry(i + 1))
    const plan = planCompaction(entries)!
    expect(plan.older.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(plan.kept).toHaveLength(KEEP_VERBATIM)
    expect(plan.upToSeq).toBe(8)
  })

  it('counts message entries only, and keeps other entries after the cut', () => {
    const entries = [...Array.from({ length: 13 }, (_, i) => entry(i + 1)), entry(14, 'tool-call'), entry(15, 'event')]
    const plan = planCompaction(entries)!
    expect(plan.older.map((e) => e.seq)).toEqual([1])
    expect(plan.kept.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  })

  it('does nothing with 12 messages or fewer', () => {
    expect(planCompaction(Array.from({ length: 12 }, (_, i) => entry(i + 1)))).toBeUndefined()
  })
})

describe('summarize', () => {
  it('asks the bot’s own model for first-person notes, including the previous notes', async () => {
    const adapter = new ScriptedAdapter()
    const summary = await summarize({
      adapter,
      modelId: 'claude-opus-5-5',
      botName: 'Keeper',
      previousSummary: 'Earlier: budget is 10k.',
      older: [entry(1), entry(2)],
      nameOf: (a) => (a.kind === 'user' ? 'Alex' : 'Keeper'),
      selfId: 'me',
      signal: new AbortController().signal
    })
    expect(summary).toBe(adapter.summary)
    const request = adapter.completes[0]!
    expect(request.modelId).toBe('claude-opus-5-5')
    expect(request.system).toMatch(/You are Keeper/)
    expect(request.prompt).toContain('Earlier: budget is 10k.')
    expect(request.prompt).toContain('[Alex] text 1')
    expect(request.prompt).toContain('[Keeper (you)] text 2')
  })
})

describe('summarizeCovered with an oversized transcript', () => {
  // contextWindow 1000 → input cap of 2100 characters.
  const big = (seq: number, text: string): Entry => ({ ...entry(seq), text })
  const run = (adapter: ScriptedAdapter, older: Entry[]) =>
    summarizeCovered({
      adapter, modelId: 'm', botName: 'Keeper', previousSummary: '', older,
      nameOf: (a) => (a.kind === 'user' ? 'Alex' : 'Keeper'), selfId: 'me', contextWindow: 1000,
      signal: new AbortController().signal
    })

  it('summarises the oldest entries that fit and stops the cursor before the rest', async () => {
    const adapter = new ScriptedAdapter()
    const older = [big(1, `SENTINEL-PROMISE ${'a'.repeat(900)}`), big(2, 'b'.repeat(900)), big(3, 'c'.repeat(900)), big(4, 'd'.repeat(900))]
    const out = await run(adapter, older)
    expect(adapter.completes[0]!.prompt).toContain('SENTINEL-PROMISE')
    expect(adapter.completes[0]!.prompt).not.toContain('ccc')
    expect(out.coveredUpToSeq).toBe(2)
  })

  it('covers a single oversized entry, marks the omission and says so in the notes', async () => {
    const adapter = new ScriptedAdapter()
    const out = await run(adapter, [big(1, `START ${'z'.repeat(5000)} END`), big(2, 'next')])
    expect(out.coveredUpToSeq).toBe(1)
    const prompt = adapter.completes[0]!.prompt
    expect(prompt).toContain('START')
    expect(prompt).toContain('END')
    expect(prompt).toMatch(/characters omitted/)
    expect(out.summary).toMatch(/too long to summarize fully/)
  })

  it('reports everything covered when the transcript fits', async () => {
    const out = await run(new ScriptedAdapter(), [big(1, 'one'), big(2, 'two')])
    expect(out.coveredUpToSeq).toBe(2)
    expect(out.summary).not.toMatch(/too long/)
  })
})
