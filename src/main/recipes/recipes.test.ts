import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotRecipe } from '@shared/domain'
import { createMcpHost } from '../mcp/host'
import { createMemoryService, type PlatformMemoryService } from '../memory/memory'
import { createSkillService, type PlatformSkillService } from '../skills/skills'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { createRecipeService } from './recipes'

describe('RecipeService', () => {
  let dir: string
  let store: PlatformStore
  let memory: PlatformMemoryService
  let skills: PlatformSkillService
  let mcp: ReturnType<typeof createMcpHost>
  let recipes: ReturnType<typeof createRecipeService>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-recipes-'))
    store = openStore(':memory:', { homeDir: dir })
    const bus = fakeBus()
    memory = createMemoryService(store.db)
    skills = createSkillService({ dataDir: join(dir, 'data'), homeDir: dir, store, bus })
    mcp = createMcpHost({ db: store.db, bus, homeDir: dir, store, connector: async () => { throw new Error('no network in tests') } })
    recipes = createRecipeService({ store, memory, skills, mcp })
  })
  afterEach(async () => {
    await mcp.shutdown()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips a bot: profile, soul, memory with dates, skills and connectors', () => {
    const github = mcp.save({ name: 'github', transport: 'stdio', command: 'gh-mcp', enabled: true, disabledTools: [], customInstructions: '' })
    mcp.save({ name: 'other', transport: 'stdio', command: 'x', enabled: true, disabledTools: [], customInstructions: '' })
    const bot = store.bots.create({
      name: 'Researcher', label: 'Research', description: 'Finds sources', soul: '# Soul\nCurious and careful.',
      avatar: { shape: 'gem', color: 'violet' }, mcpServerIds: [github.id]
    })
    memory.setProfile(bot.id, 'Works for Alex.')
    memory.add({ botId: bot.id, text: 'Prefers primary sources', createdBy: 'bot', createdAt: Date.parse('2026-01-02T00:00:00Z') })
    const lib = skills.save({ name: 'cite', description: 'Use when citing', body: 'Use APA.' })
    store.bots.update(bot.id, { skillIds: [lib.id] })
    skills.save({ name: 'dig', description: 'Use when digging', body: 'Go deep.', ownerBotId: bot.id })

    const recipe = recipes.exportRecipe(bot.id)
    expect(recipe).toEqual({
      format: 'faibots.bot-recipe',
      version: 1,
      profile: { name: 'Researcher', label: 'Research', description: 'Finds sources', avatarColor: 'violet', avatarShape: 'gem' },
      soul: '# Soul\nCurious and careful.',
      memory: [
        { tier: 'profile', content: 'Works for Alex.' },
        { tier: 'log', content: 'Prefers primary sources', createdAt: '2026-01-02T00:00:00.000Z' }
      ],
      skills: [
        { name: 'dig', description: 'Use when digging', content: 'Go deep.\n' },
        { name: 'cite', description: 'Use when citing', content: 'Use APA.\n' }
      ],
      mcpServers: [{ name: 'github' }]
    })

    const copy = recipes.importRecipe(JSON.parse(JSON.stringify(recipe)) as BotRecipe)
    expect(copy.id).not.toBe(bot.id)
    expect(copy).toMatchObject({ name: 'Researcher', handle: 'researcher2', soul: '# Soul\nCurious and careful.', isPrimary: false })
    expect(copy.avatar).toEqual({ shape: 'gem', color: 'violet' })
    expect(copy.mcpServerIds).toEqual([github.id])
    expect(memory.getProfile(copy.id).content).toBe('Works for Alex.')
    expect(memory.list(copy.id).map((f) => [f.text, new Date(f.createdAt).toISOString()])).toEqual([
      ['Prefers primary sources', '2026-01-02T00:00:00.000Z']
    ])
    // Recipe skills become the new bot's own private skills.
    expect(skills.list(copy.id).map((s) => [s.name, s.source, s.ownerBotId])).toEqual([
      ['cite', 'bot', copy.id], ['dig', 'bot', copy.id]
    ])
  })

  it('accepts minimal recipes and rejects other JSON', () => {
    const bot = recipes.importRecipe({
      format: 'faibots.bot-recipe', version: 1,
      profile: { name: 'Mini', avatarColor: 'not-a-colour' }
    } as unknown as BotRecipe)
    expect(bot.name).toBe('Mini')
    expect(bot.mcpServerIds).toBe('all')
    expect(() => recipes.importRecipe({ format: 'something-else' } as unknown as BotRecipe)).toThrow(/not a faibots bot recipe/)
  })

  it('leaves out connectors the user does not have', () => {
    const bot = recipes.importRecipe({
      format: 'faibots.bot-recipe', version: 1,
      profile: { name: 'X', label: '', description: '', avatarColor: 'red', avatarShape: 'star' },
      soul: '', memory: [], skills: [], mcpServers: [{ name: 'missing' }]
    })
    expect(bot.mcpServerIds).toEqual([])
  })
})
