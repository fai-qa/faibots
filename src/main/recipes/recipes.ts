// Bot recipes: export a bot (profile, soul, memory, skills, which connectors it uses) as JSON, and
// import one as a new bot. Import writes memory and skills directly; nothing in a recipe runs.

import { z } from 'zod'
import { AVATAR_SHAPES, BOT_COLORS, type Bot, type BotRecipe, type Id } from '@shared/domain'
import type { McpHost, RecipeService, Store } from '../contracts'
import type { PlatformMemoryService } from '../memory/memory'
import { slugifySkillName, uniqueName } from '../skills/naming'
import type { PlatformSkillService } from '../skills/skills'

const MAX_MEMORIES = 5000
const MAX_FACT_CHARS = 4000
const MAX_PROFILE_CHARS = 20_000

const recipeSchema = z.object({
  format: z.literal('faibots.bot-recipe'),
  version: z.literal(1),
  profile: z.object({
    name: z.string().trim().min(1).max(80),
    label: z.string().default(''),
    description: z.string().default(''),
    // Unknown colours or shapes fall back to a random avatar rather than failing the import.
    avatarColor: z.enum(BOT_COLORS).optional().catch(undefined),
    avatarShape: z.enum(AVATAR_SHAPES).optional().catch(undefined)
  }),
  soul: z.string().default(''),
  memory: z.array(z.object({
    tier: z.enum(['profile', 'log']).default('log'),
    content: z.string(),
    createdAt: z.string().optional()
  })).max(MAX_MEMORIES).default([]),
  skills: z.array(z.object({ name: z.string(), description: z.string().default(''), content: z.string() })).max(250).default([]),
  mcpServers: z.array(z.object({ name: z.string(), description: z.string().optional() })).default([])
})

export function createRecipeService(deps: {
  store: Pick<Store, 'bots'>
  memory: PlatformMemoryService
  skills: PlatformSkillService
  mcp: Pick<McpHost, 'list'>
}): RecipeService {
  const { store, memory, skills, mcp } = deps

  return {
    exportRecipe(botId) {
      const bot = store.bots.get(botId)
      if (!bot) throw new Error('Bot not found')
      const profile = memory.getProfile(botId).content.trim()
      const facts = memory.list(botId).sort((a, b) => a.createdAt - b.createdAt)
      const servers = mcp.list().map((s) => s.server)
      return {
        format: 'faibots.bot-recipe',
        version: 1,
        profile: {
          name: bot.name,
          label: bot.label,
          description: bot.description,
          avatarColor: bot.avatar.color,
          avatarShape: bot.avatar.shape
        },
        soul: bot.soul,
        memory: [
          ...(profile ? [{ tier: 'profile' as const, content: profile }] : []),
          ...facts.map((f) => ({ tier: 'log' as const, content: f.text, createdAt: new Date(f.createdAt).toISOString() }))
        ],
        skills: skills.list(botId).map((s) => {
          const full = skills.get(s.id)
          return { name: full.name, description: full.description, content: full.body }
        }),
        // 'all' exports as no specific servers; importing that gives the default ('all').
        mcpServers: bot.mcpServerIds === 'all'
          ? []
          : servers.filter((s) => (bot.mcpServerIds as Id[]).includes(s.id)).map((s) => ({ name: s.name }))
      } satisfies BotRecipe
    },

    importRecipe(input) {
      const parsed = recipeSchema.safeParse(input)
      if (!parsed.success) throw new Error(`This is not a faibots bot recipe: ${z.prettifyError(parsed.error)}`)
      const recipe = parsed.data

      // Connectors are matched by name; ones the user does not have are left out.
      let mcpServerIds: Bot['mcpServerIds'] = 'all'
      if (recipe.mcpServers.length > 0) {
        const byName = new Map(mcp.list().map((s) => [s.server.name.toLowerCase(), s.server.id]))
        mcpServerIds = recipe.mcpServers.map((s) => byName.get(s.name.toLowerCase())).filter((id): id is Id => !!id)
      }

      const bot = store.bots.create({
        name: recipe.profile.name,
        label: recipe.profile.label,
        description: recipe.profile.description,
        soul: recipe.soul,
        ...(recipe.profile.avatarColor && recipe.profile.avatarShape && {
          avatar: { color: recipe.profile.avatarColor, shape: recipe.profile.avatarShape }
        }),
        isPrimary: false,
        mcpServerIds
      })

      const profile = recipe.memory.filter((m) => m.tier === 'profile').map((m) => m.content.trim()).filter(Boolean).join('\n\n')
      if (profile) memory.setProfile(bot.id, profile.slice(0, MAX_PROFILE_CHARS))
      for (const entry of recipe.memory.filter((m) => m.tier === 'log')) {
        const text = entry.content.trim().slice(0, MAX_FACT_CHARS)
        if (!text) continue
        const createdAt = entry.createdAt ? Date.parse(entry.createdAt) : NaN
        memory.add({ botId: bot.id, text, createdBy: 'user', ...(Number.isFinite(createdAt) && { createdAt }) })
      }

      const names = new Set<string>()
      for (const skill of recipe.skills) {
        const name = uniqueName(slugifySkillName(skill.name) || 'skill', (n) => names.has(n))
        try {
          skills.save({
            name,
            description: skill.description.trim() || `Imported with ${recipe.profile.name}`,
            body: skill.content,
            ownerBotId: bot.id
          })
          names.add(name)
        } catch (err) {
          console.warn(`[recipes] skipped skill ${skill.name}:`, err instanceof Error ? err.message : err)
        }
      }
      return store.bots.get(bot.id)!
    }
  }
}
