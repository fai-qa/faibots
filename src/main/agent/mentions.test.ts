import { describe, expect, it } from 'vitest'
import { buildHandleIndex, handlesOf, parseMentions } from './mentions'

const bot = (id: string, name: string, handle: string) => ({ id, name, handle })

const researcher = bot('r', 'Dr Zoë Researcher', 'zoe')
const writer = bot('w', 'Writer', 'writer')
const researchLead = bot('l', 'Research Lead', 'lead')
const researchBot = bot('b', 'Research Bot', 'rbot')

describe('parseMentions', () => {
  it('matches the @handle', () => {
    expect(parseMentions('hey @zoe, look', [researcher, writer])).toEqual({ ids: ['r'], everyone: false })
  })

  it('matches the full name, case-insensitive, accents optional', () => {
    expect(parseMentions('@dr zoë researcher please', [researcher, writer]).ids).toEqual(['r'])
    expect(parseMentions('@DR ZOE RESEARCHER please', [researcher, writer]).ids).toEqual(['r'])
  })

  it('matches the name without spaces', () => {
    expect(parseMentions('@drzoeresearcher?', [researcher, writer]).ids).toEqual(['r'])
  })

  it('matches the first word', () => {
    expect(parseMentions('@Dr can you', [researcher, writer]).ids).toEqual(['r'])
    expect(parseMentions('@writer and @dr', [researcher, writer]).ids).toEqual(['w', 'r'])
  })

  it('an ambiguous handle matches nobody, but a more specific one still works', () => {
    const members = [researchLead, researchBot]
    expect(parseMentions('@research help', members).ids).toEqual([])
    expect(parseMentions('@research lead help', members).ids).toEqual(['l'])
    expect(parseMentions('@researchbot help', members).ids).toEqual(['b'])
  })

  it('a better-ranked handle wins over a first word', () => {
    const alex = bot('a', 'Alex', 'alex')
    const alexSmith = bot('s', 'Alex Smith', 'asmith')
    // "alex" is Alex's handle (rank 0) and Alex Smith's first word (rank 3).
    expect(parseMentions('@alex', [alex, alexSmith]).ids).toEqual(['a'])
    expect(parseMentions('@alex smith', [alex, alexSmith]).ids).toEqual(['s'])
  })

  it('@everyone and @all address everyone, even with a bot named All', () => {
    expect(parseMentions('@everyone status?', [writer])).toEqual({ ids: [], everyone: true })
    expect(parseMentions('morning @all', [writer])).toEqual({ ids: [], everyone: true })
    expect(parseMentions('@all', [bot('x', 'All Hands', 'allhands')])).toEqual({ ids: [], everyone: true })
    expect(parseMentions('@allhands', [bot('x', 'All Hands', 'allhands')]).ids).toEqual(['x'])
  })

  it('needs word boundaries: e-mails and longer words are not mentions', () => {
    expect(parseMentions('mail me at reader@writer.example', [writer]).ids).toEqual([])
    expect(parseMentions('@writers unite', [writer]).ids).toEqual([])
    expect(parseMentions('(@writer)', [writer]).ids).toEqual(['w'])
    expect(parseMentions('@allison', [writer])).toEqual({ ids: [], everyone: false })
  })

  it('lists each bot once, in order of first mention', () => {
    expect(parseMentions('@writer @zoe @writer', [researcher, writer]).ids).toEqual(['w', 'r'])
  })
})

describe('handles', () => {
  it('derives the four handle kinds', () => {
    expect(handlesOf(researcher)).toEqual([
      { handle: 'zoe', rank: 0 },
      { handle: 'dr zoe researcher', rank: 1 },
      { handle: 'drzoeresearcher', rank: 2 },
      { handle: 'dr', rank: 3 }
    ])
  })

  it('marks ambiguous handles', () => {
    const index = buildHandleIndex([researchLead, researchBot])
    expect(index.get('research')).toBeNull()
    expect(index.get('lead')).toBe('l')
  })
})
