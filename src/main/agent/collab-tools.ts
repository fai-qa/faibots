// The collaboration tools (ARCHITECTURE §5.3, §7): send_to_agent, list_bots, create_bot and
// pass_turn. They are registered into the shared ToolRegistry, so permissions and approval cards
// work as for any tool (create_bot asks first by default).

import { z } from 'zod'
import type { Bot, Conversation, Id, ModelRoute } from '@shared/domain'
import { kindInfo, resolveModelId } from '@shared/provider-catalog'
import type { EventBus, SkillService, Store, ToolContext } from '../contracts'
import { defineTool, errorResult, textResult, type PlatformToolDefinition } from '../tools/define'
import { buildHandleIndex } from './mentions'

/** What the collab tools need from the orchestrator. */
export interface CollabRuntime {
  /** Post `message` from ctx.bot to `target` in their exchange and wait for the reply. Throws CollabError. */
  askBot(ctx: ToolContext, target: Bot, message: string): Promise<{ reply: string; exchange: Conversation }>
  /** Mark the turn as passed. A bot that was addressed may not pass. */
  markPassed(turnId: Id): 'passed' | 'no-turn' | 'must-answer'
}

/** A refusal the calling bot should read (unknown bot, loop, too deep, timeout…). */
export class CollabError extends Error {
  /** Text the failed bot wrote before it stopped; unfinished. */
  readonly partial: string | undefined
  readonly exchangeConversationId: Id | undefined
  constructor(message: string, partial?: string, exchangeConversationId?: Id) {
    super(message)
    this.partial = partial
    this.exchangeConversationId = exchangeConversationId
    this.name = 'CollabError'
  }
}

/** A refusal made before any child turn was scheduled: nothing ran, so nothing is unresolved. */
export class CollabRefusal extends CollabError {
  constructor(message: string) {
    super(message)
    this.name = 'CollabRefusal'
  }
}

/** Find a bot by @handle, name, first name or id. Undefined when unknown or ambiguous. */
export function findBot(bots: Bot[], query: string): Bot | undefined {
  const q = query.trim().replace(/^@/, '')
  if (!q) return undefined
  const byId = bots.find((b) => b.id === q)
  if (byId) return byId
  const id = buildHandleIndex(bots).get(q.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' '))
  return id ? bots.find((b) => b.id === id) : undefined
}

const directoryLine = (b: Bot) =>
  `- @${b.handle}: ${b.name}${b.label ? `, ${b.label}` : ''}${b.isPrimary ? ' (primary bot)' : ''}${b.description ? `. ${b.description}` : ''}`

export function collabTools(deps: { store: Pick<Store, 'bots' | 'providers' | 'settings'>; skills: SkillService; bus: EventBus; runtime: CollabRuntime }): PlatformToolDefinition[] {
  const others = (self: Id) => deps.store.bots.list().filter((b) => b.id !== self && !b.hidden)
  const configuredModel = (route: ModelRoute | null) => {
    if (!route) return undefined
    const provider = deps.store.providers.get(route.providerId)
    if (!provider?.enabled || (kindInfo(provider.kind).needsApiKey && !provider.hasApiKey)) return undefined
    const modelId = resolveModelId(provider, route.modelId)
    return modelId ? { route, label: `${modelId} via ${provider.label}` } : undefined
  }
  const newBotModel = (creator: Bot) =>
    configuredModel(deps.store.settings.get().defaultModel) ?? configuredModel(creator.model)

  const sendToAgent = defineTool({
    name: 'send_to_agent',
    description:
      "Ask another of the user's bots for help and wait for its answer, which comes back as this tool's result. " +
      'Use it when a task fits another bot better (see list_bots). Write the message so it stands on its own: ' +
      'the other bot does not see this conversation. It answers with its own memory, skills and tools.',
    schema: z.object({
      to: z.string().min(1).describe('The bot to ask: its @handle or name'),
      message: z.string().min(1).describe('What you need from it, with all the context it needs')
    }),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Messaging another bot',
    summarize: (input) => `Message ${input.to}: ${input.message.slice(0, 300)}`,
    async execute(input, ctx) {
      const candidates = deps.store.bots.list().filter((b) => b.id !== ctx.bot.id)
      const target = findBot(candidates, input.to)
      if (!target) {
        const known = others(ctx.bot.id).map((b) => `@${b.handle}`).join(', ')
        return {
          ...errorResult(`There is no single bot called "${input.to}".${known ? ` Bots you can ask: ${known}.` : ' There are no other bots yet.'}`),
          refusedBeforeRun: true
        }
      }
      try {
        const { reply, exchange } = await deps.runtime.askBot(ctx, target, input.message)
        return textResult(`${target.name} (@${target.handle}) replied:\n\n${reply}`, {
          title: `Messaged ${target.name}`,
          exchangeConversationId: exchange.id
        })
      } catch (err) {
        if (err instanceof CollabError && (err.partial || err.exchangeConversationId)) {
          const body = err.partial
            ? `${err.message}\n\nPartial, unfinished text ${target.name} wrote before it stopped:\n\n${err.partial}`
            : err.message
          return {
            ...errorResult(body),
            ...(err.exchangeConversationId && {
              display: { title: `Messaged ${target.name}`, exchangeConversationId: err.exchangeConversationId }
            })
          }
        }
        const refused = err instanceof CollabRefusal
        return { ...errorResult(err instanceof Error ? err.message : String(err)), ...(refused && { refusedBeforeRun: true }) }
      }
    }
  })

  const listBots = defineTool({
    name: 'list_bots',
    description: "List the user's other bots (handle, name, role, what each is for), to decide who to ask with send_to_agent.",
    schema: z.object({}),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Looking up the other bots',
    summarize: () => 'List the other bots',
    async execute(_input, ctx) {
      const bots = others(ctx.bot.id)
      if (bots.length === 0) return textResult('There are no other bots yet. You can propose one with create_bot.')
      return textResult(bots.map((bot) => {
        const model = configuredModel(bot.model)
        const skills = deps.skills.list(bot.id).map((skill) => skill.name)
        return [directoryLine(bot), model ? `Model configured: ${model.label}` : 'Model needs setup',
          ...(skills.length ? [`Skills: ${skills.join(', ')}`] : [])].join(' | ')
      }).join('\n'))
    }
  })

  const createBot = defineTool({
    name: 'create_bot',
    description:
      'Propose a new bot for the user, for example a specialist you keep needing. The user approves it first. ' +
      'Give it a clear name, a short label, a one-sentence description other bots will read, and a soul: ' +
      'its persona, voice, values and way of working, in Markdown.',
    schema: z.object({
      name: z.string().min(1).max(80).describe('Display name, e.g. "Researcher"'),
      label: z.string().max(80).optional().describe('Short role, e.g. "Research, sources"'),
      description: z.string().max(500).optional().describe('One or two sentences: what it is for'),
      soul: z.string().max(20_000).optional().describe('Its persona in Markdown')
    }),
    source: 'faibots',
    defaultPermission: 'ask',
    activityLabel: 'Creating a new bot',
    summarize: (input, ctx) => {
      const model = newBotModel(ctx.bot)
      return `Create a new bot "${input.name}"${input.label ? ` (${input.label})` : ''}${input.description ? `: ${input.description}` : ''}. ` +
        (model ? `Model: ${model.label}.` : 'Model setup required.')
    },
    async execute(input, ctx) {
      const existing = deps.store.bots.list().find((bot) => bot.name.trim().toLowerCase() === input.name.trim().toLowerCase())
      if (existing) return textResult(`A bot named ${existing.name} already exists (@${existing.handle}). Check its role before assigning. No bot was created.`)
      const configured = newBotModel(ctx.bot)
      const bot = deps.store.bots.create({
        name: input.name,
        ...(input.label !== undefined && { label: input.label }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.soul !== undefined && { soul: input.soul }),
        model: configured?.route ?? { providerId: '', modelId: '' },
        mcpServerIds: [],
        isPrimary: false
      })
      deps.bus.emit('bots:changed', { bots: deps.store.bots.list() })
      const model = configured ? ` Model configured: ${configured.label}.` : ' Its model needs setup in its profile before it can answer.'
      return textResult(`Created ${bot.name} (@${bot.handle}).${model}`)
    }
  })

  const passTurn = defineTool({
    name: 'pass_turn',
    description:
      'In a group chat, pass instead of replying when you have nothing useful to add (this is the normal choice when nobody asked you). ' +
      'After calling it, end your turn without writing anything.',
    schema: z.object({ reason: z.string().max(200).optional().describe('Optional, for yourself') }),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Passing',
    isAvailable: (ctx) => ctx.inGroup,
    summarize: () => 'Pass this turn',
    async execute(_input, ctx) {
      const outcome = deps.runtime.markPassed(ctx.turnId)
      if (outcome === 'must-answer') return errorResult('You were addressed directly, so you cannot pass. Write your reply instead.')
      if (outcome === 'no-turn') return errorResult('There is no turn to pass right now.')
      return textResult('You passed. End your turn now without writing a reply.')
    }
  })

  return [sendToAgent, listBots, createBot, passTurn]
}
