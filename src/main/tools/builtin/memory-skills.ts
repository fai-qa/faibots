// update_memory, recall_memory, skill, update_skill. They only ever touch the calling bot's own
// memory and skills: ids from the model are checked against ctx.bot before anything changes.

import { z } from 'zod'
import type { MemoryFact } from '@shared/domain'
import type { SkillService } from '../../contracts'
import type { PlatformMemoryService } from '../../memory/memory'
import { slugifySkillName } from '../../skills/naming'
import { defineTool, errorResult, textResult } from '../define'

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const factLine = (f: MemoryFact) => `- [${day(f.createdAt)}] ${f.text} (id: ${f.id})`

export function memoryTools(deps: { memory: PlatformMemoryService }) {
  const { memory } = deps

  const updateMemory = defineTool({
    name: 'update_memory',
    description:
      'Save, fix or forget something in your own long-term memory. ' +
      'tier "profile" is your always-visible document about the person you work for and your work: ' +
      'write replaces it, so send the whole new text; keep it under 4000 characters. ' +
      'tier "log" holds individual dated facts: write adds one, edit changes one (factId), delete removes one (factId). ' +
      'Save durable facts and preferences, not chit-chat.',
    schema: z.object({
      action: z.enum(['write', 'edit', 'delete']),
      tier: z.enum(['profile', 'log']),
      content: z.string().optional().describe('The text to save (write, edit)'),
      factId: z.string().optional().describe('Which fact to edit or delete (log tier)')
    }),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Updating memory',
    summarize: (input) => `${input.action} ${input.tier} memory${input.content ? `: ${input.content.slice(0, 200)}` : ''}`,
    async execute(input, ctx) {
      const botId = ctx.bot.id
      if (input.tier === 'profile') {
        if (input.action === 'delete') {
          memory.setProfile(botId, '')
          return textResult('Your memory profile is now empty.')
        }
        if (input.content === undefined) return errorResult('Send the full new profile text in content.')
        const profile = memory.setProfile(botId, input.content.trim())
        return textResult(`Saved your memory profile (${profile.content.length} characters).`)
      }

      if (input.action === 'write') {
        if (!input.content?.trim()) return errorResult('Send the fact to remember in content.')
        const fact = memory.add({
          botId,
          text: input.content,
          createdBy: 'bot',
          source: { conversationId: ctx.conversation.id }
        })
        return textResult(`Saved (id: ${fact.id}).`)
      }

      if (!input.factId) return errorResult('Say which fact with factId (ids are shown in your memory block and by recall_memory).')
      const fact = memory.getFact(input.factId)
      if (!fact || fact.botId !== botId) return errorResult(`You have no memory with id ${input.factId}.`)
      if (input.action === 'delete') {
        memory.delete(fact.id)
        return textResult('Forgotten.')
      }
      if (!input.content?.trim()) return errorResult('Send the corrected text in content.')
      memory.update(fact.id, { text: input.content })
      return textResult('Updated.')
    }
  })

  const recallMemory = defineTool({
    name: 'recall_memory',
    description: 'Search your own long-term memory for facts you saved earlier. Use a few key words.',
    schema: z.object({
      query: z.string().min(1).describe('Words to search for'),
      limit: z.number().int().min(1).max(50).optional().describe('How many facts to return (default 10)')
    }),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Remembering',
    summarize: (input) => `Search memory for "${input.query}"`,
    async execute(input, ctx) {
      const facts = memory.search(ctx.bot.id, input.query, input.limit ?? 10)
      if (facts.length === 0) return textResult(`Nothing in your memory matches "${input.query}".`)
      return textResult(facts.map(factLine).join('\n'))
    }
  })

  return [updateMemory, recallMemory]
}

export function skillTools(deps: { skills: SkillService }) {
  const { skills } = deps

  const skill = defineTool({
    name: 'skill',
    description: 'Load one of your skills by name and get its full instructions. Do this before following a skill.',
    schema: z.object({ name: z.string().min(1).describe('The skill name, as listed in your skills') }),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Reading a skill',
    summarize: (input) => `Load skill ${input.name}`,
    async execute(input, ctx) {
      const found = skills.findForBot(ctx.bot.id, input.name)
      if (!found) {
        const names = skills.list(ctx.bot.id).map((s) => s.name)
        return errorResult(`You have no skill named "${input.name}".${names.length ? ` Your skills: ${names.join(', ')}.` : ''}`)
      }
      const resources = found.resources.length
        ? `\n\n---\nFiles in this skill's folder (${found.dir}), readable with read_file:\n${found.resources.map((r) => `- ${r}`).join('\n')}`
        : ''
      return textResult(`# Skill: ${found.name}\n${found.description}\n\n${found.body.trim()}${resources}`)
    }
  })

  const updateSkill = defineTool({
    name: 'update_skill',
    description:
      'Create, change or delete one of your own private skills: a reusable, step-by-step way of doing a task. ' +
      'write creates the skill, or updates it if you already own one with that name (send description and content ' +
      'to create; either to update). delete removes a skill you own. You cannot change skills the user gave you.',
    schema: z.object({
      action: z.enum(['write', 'delete']),
      name: z.string().min(1).describe('Skill name: lowercase words joined by dashes, e.g. weekly-report'),
      description: z.string().optional().describe('When to use it, e.g. "Use when writing the weekly report"'),
      content: z.string().optional().describe('The Markdown instructions')
    }),
    source: 'faibots',
    defaultPermission: 'always',
    activityLabel: 'Updating a skill',
    summarize: (input) => `${input.action === 'delete' ? 'Delete' : 'Save'} skill ${input.name}`,
    async execute(input, ctx) {
      const botId = ctx.bot.id
      const name = slugifySkillName(input.name)
      if (!name) return errorResult('Skill names use lowercase letters, digits and dashes.')
      const own = skills.list(botId).find((s) => s.ownerBotId === botId && s.name === name)

      if (input.action === 'delete') {
        if (!own) return errorResult(`You have no private skill named "${name}". You can only delete skills you created.`)
        skills.delete(own.id)
        return textResult(`Deleted skill ${name}.`)
      }

      if (own) {
        const current = skills.get(own.id)
        const saved = skills.save({
          id: own.id,
          name,
          description: input.description ?? current.description,
          body: input.content ?? current.body
        })
        return textResult(`Updated skill ${saved.name}.`)
      }
      if (!input.description?.trim() || !input.content?.trim()) {
        return errorResult('To create a skill, send both description ("Use when…") and content.')
      }
      const saved = skills.save({ name, description: input.description, body: input.content, ownerBotId: botId })
      return textResult(`Created skill ${saved.name}. It now shows in your skills list.`)
    }
  })

  return [skill, updateSkill]
}
