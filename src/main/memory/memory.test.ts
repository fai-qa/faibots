import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type PlatformStore } from '../store'
import { createMemoryService, ftsQuery, PROMPT_BLOCK_CHARS, type PlatformMemoryService } from './memory'

describe('MemoryService', () => {
  let store: PlatformStore
  let memory: PlatformMemoryService
  let botId: string
  let otherId: string

  beforeEach(() => {
    store = openStore(':memory:', { homeDir: '/tmp' })
    memory = createMemoryService(store.db)
    botId = store.bots.create({ name: 'Researcher' }).id
    otherId = store.bots.create({ name: 'Writer' }).id
  })
  afterEach(() => store.close())

  it('builds safe FTS queries from free text', () => {
    expect(ftsQuery('Project "Apollo" deadline?')).toBe('"project"* OR "apollo"* OR "deadline"*')
    expect(ftsQuery('AND OR NOT ( ) * :')).toBe('"and"* OR "or"* OR "not"*')
    expect(ftsQuery('  ')).toBeUndefined()
  })

  it('searches only the bot\'s own facts with FTS, prefix and diacritics', () => {
    memory.add({ botId, text: 'The Apollo launch deadline is March 3', createdBy: 'bot' })
    memory.add({ botId, text: 'Prefers café meetings', createdBy: 'user' })
    memory.add({ botId: otherId, text: 'Apollo budget is secret', createdBy: 'bot' })
    expect(memory.search(botId, 'apollo').map((f) => f.text)).toEqual(['The Apollo launch deadline is March 3'])
    expect(memory.search(botId, 'deadl').length).toBe(1)
    expect(memory.search(botId, 'cafe').map((f) => f.text)).toEqual(['Prefers café meetings'])
    expect(memory.list(botId, { query: 'budget' })).toEqual([])
    expect(memory.search(otherId, 'apollo')).toHaveLength(1)
  })

  it('keeps the index in sync on edit and delete', () => {
    const fact = memory.add({ botId, text: 'Likes green tea', createdBy: 'bot' })
    memory.update(fact.id, { text: 'Likes black coffee' })
    expect(memory.search(botId, 'tea')).toEqual([])
    expect(memory.search(botId, 'coffee')).toHaveLength(1)
    memory.delete(fact.id)
    expect(memory.search(botId, 'coffee')).toEqual([])
  })

  it('lists pinned first, newest first', () => {
    memory.add({ botId, text: 'old', createdBy: 'bot', createdAt: 1000 })
    memory.add({ botId, text: 'pinned', createdBy: 'bot', pinned: true, createdAt: 500 })
    memory.add({ botId, text: 'new', createdBy: 'bot', createdAt: 2000 })
    expect(memory.list(botId).map((f) => f.text)).toEqual(['pinned', 'new', 'old'])
    expect(memory.list(botId, { limit: 1 })).toHaveLength(1)
  })

  it('stores a profile per bot', () => {
    expect(memory.getProfile(botId).content).toBe('')
    memory.setProfile(botId, 'Works with Alex on AI products.')
    expect(memory.getProfile(botId).content).toBe('Works with Alex on AI products.')
    expect(memory.getProfile(otherId).content).toBe('')
    expect(() => memory.setProfile(botId, 'x'.repeat(20_001))).toThrow()
  })

  it('promptBlock: profile, pinned, recent 20, and a recall hint', () => {
    memory.setProfile(botId, 'Profile text')
    memory.add({ botId, text: 'Always cite sources', createdBy: 'user', pinned: true })
    for (let i = 0; i < 30; i++) memory.add({ botId, text: `fact ${i}`, createdBy: 'bot', createdAt: 1000 + i })
    const block = memory.promptBlock(botId)
    expect(block).toContain('Profile text')
    expect(block).toContain('### Pinned facts')
    expect(block).toContain('Always cite sources')
    expect(block).toContain('fact 29')
    expect(block).toContain('fact 10')
    expect(block).not.toContain('fact 9 ')
    expect(block).toContain('recall_memory')
    expect(block).not.toContain('Writer')
  })

  it('promptBlock caps the profile at 4000 and the block at ~8000 characters', () => {
    memory.setProfile(botId, 'p'.repeat(10_000))
    for (let i = 0; i < 20; i++) memory.add({ botId, text: `${i} ${'x'.repeat(900)}`, createdBy: 'bot', pinned: i < 5 })
    const block = memory.promptBlock(botId)
    expect(block).toContain('profile cut at 4000')
    expect(block.match(/p+/)![0].length).toBe(4000)
    expect(block.length).toBeLessThanOrEqual(PROMPT_BLOCK_CHARS)
    expect(block).toContain('recall_memory')
  })

  it('emits memory:changed for every change when given a bus', () => {
    const events: string[] = []
    const withBus = createMemoryService(store.db, { bus: { emit: (channel, payload) => events.push(`${channel}:${(payload as { botId: string }).botId === botId}`) } })
    const fact = withBus.add({ botId, text: 'x', createdBy: 'user' })
    withBus.update(fact.id, { pinned: true })
    withBus.delete(fact.id)
    withBus.setProfile(botId, 'p')
    expect(events).toEqual(Array(4).fill('memory:changed:true'))
  })

  it('rejects empty facts and unknown bots', () => {
    expect(() => memory.add({ botId, text: '   ', createdBy: 'bot' })).toThrow()
    expect(() => memory.add({ botId: 'nope', text: 'x', createdBy: 'bot' })).toThrow(/Bot not found/)
  })
})
