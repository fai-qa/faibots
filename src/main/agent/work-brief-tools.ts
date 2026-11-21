import { MAX_ASKS_PER_CHAIN } from '@shared/work-brief'
import { z } from 'zod'
import { getHandoffCheckpoint } from '../store/escalations'
import { MAIN_BOT_NAME } from '../store/bots'
import type { EventBus, Runtime, Services } from '../contracts'
import { workBriefs, WorkRefusal } from '../store/work-briefs'
import type { PlatformStore } from '../store'
import { defineTool, errorResult, textResult } from '../tools/define'

/** Only the original fai chat can create or change its work; specialists can still give direct answers. */
export function workBriefTools(store: PlatformStore, bus: EventBus, authority?: Pick<Services,'dataDir'|'attachments'>) {
  const work = workBriefs(store.db)
  const available = ({ bot, conversation }: { bot: { isPrimary: boolean; name: string }; conversation: { kind: string } }) =>
    bot.isPrimary && bot.name === MAIN_BOT_NAME && conversation.kind === 'dm'
  const changed = (conversationId: string) => bus.emit('work:changed', { conversationId })
  const handoffs = (chat: string, lookup: { userEntryId?: string; workId?: string }) =>
    getHandoffCheckpoint(store, chat, lookup, authority).map(({id,workId,availability}) => ({id,workId,availability}))
  const tools = [
    defineTool({
      name: 'plan_work', description: 'Record a checkable brief for a substantial user request in this chat. Use once before assigning specialists. Record exclusions, stop conditions and a smaller specialist budget when the job calls for them. Answer simple questions directly.',
      schema: z.object({ objective: z.string().trim().min(1).max(2000), deliverable: z.string().trim().min(1).max(2000), checks: z.string().trim().min(1).max(2000),
        exclusions: z.string().trim().max(2000).optional(), stopWhen: z.string().trim().max(2000).optional(),
        assignmentLimit: z.number().int().min(0).max(MAX_ASKS_PER_CHAIN).optional() }),
      source: 'faibots', defaultPermission: 'always', activityLabel: 'Recording the work brief', isAvailable: available,
      async execute(input, ctx) {
        if (!ctx.userEntryId) throw new WorkRefusal('Start a brief only from a user request in this chat.')
        const existing = handoffs(ctx.conversation.id,{userEntryId:ctx.userEntryId})
        if (existing.some(ref=>ref.availability==='withheld')) throw new WorkRefusal('The selected handoff is no longer available. Ask the owner to select its current scope.')
        const linked = existing.find(ref => ref.workId)?.workId
        const brief = linked ? work.resume(ctx.conversation.id,linked,ctx.turnId) :
          work.start(ctx.conversation.id,ctx.userEntryId,ctx.turnId,input.objective,input.deliverable,input.checks,input)
        changed(ctx.conversation.id)
        return textResult(JSON.stringify({...brief,...(existing.length && {handoffs:existing})}))
      }
    }),
    defineTool({
      name: 'review_work', description: 'Look up work in this chat, ask a consequential question or submit a result for the user to review. Never mark your own work accepted.',
      schema: z.object({
        action: z.enum(['list', 'wait', 'resume', 'question', 'result']), id: z.string().min(1).optional(),
        revision: z.number().int().positive().optional(), text: z.string().trim().min(1).max(16000).optional(),
        evidenceEntryIds: z.array(z.string().min(1)).max(32).optional(), partial: z.boolean().optional()
      }),
      source: 'faibots', defaultPermission: 'always', activityLabel: 'Reviewing work', isAvailable: available,
      async execute(input, ctx) {
        if (input.action === 'list') return textResult(JSON.stringify(work.list(ctx.conversation.id)))
        if (!input.id) throw new WorkRefusal('Choose the brief by its ID.')
        if (input.action === 'resume') {
          const refs = handoffs(ctx.conversation.id,{workId:input.id})
          const brief = work.resume(ctx.conversation.id,input.id,ctx.turnId)
          return textResult(JSON.stringify({...brief,...(refs.length && {handoffs:refs})}))
        }
        if (input.action === 'wait') {
          if (!input.revision) throw new WorkRefusal('Include the current revision.')
          const brief = work.wait(ctx.conversation.id,input.id,input.revision,ctx.turnId)
          changed(ctx.conversation.id)
          return textResult(JSON.stringify(brief))
        }
        if (!input.text || !input.revision) throw new WorkRefusal('Include the current revision and the question or result.')
        const brief = work.submit(ctx.conversation.id, input.id, input.revision, input.action, input.text,
          input.action === 'result' ? input.evidenceEntryIds ?? [] : [], ctx.turnId, input.action === 'result' && input.partial === true)
        changed(ctx.conversation.id)
        return textResult(JSON.stringify(brief))
      }
    })
  ]
  return tools.map(tool => ({
    ...tool,
    async execute(input: unknown, ctx: Parameters<typeof tool.execute>[1]) {
      try { return await tool.execute(input,ctx) }
      catch (error) {
        if (error instanceof WorkRefusal) return { ...errorResult(error.message), refusedBeforeRun: true }
        throw error
      }
    }
  }))
}

// If the app closes between recording an owner's answer and dispatching it, retry with the same chat nonce.
export async function deliverWorkReplies(store: PlatformStore, runtime: Pick<Runtime, 'send'>): Promise<void> {
  const work = workBriefs(store.db)
  for (const reply of work.pending()) {
    await runtime.send({ conversationId: reply.conversationId, clientNonce: `work-${reply.id}-${reply.revision}`,
      text: `${reply.decision === 'answer' ? 'Answer' : reply.decision === 'steer' ? 'Updated instruction' : 'Requested change'} for work ${reply.id} (${reply.objective}): ${reply.note}`,
      mentions: [], mentionsEveryone: false, attachmentPaths: [] })
    work.acknowledge(reply.id, reply.revision)
  }
}
