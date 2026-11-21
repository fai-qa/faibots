import { z } from 'zod'
import type { EventBus, Runtime } from '../contracts'
import { workBriefs } from '../store/work-briefs'
import type { PlatformStore } from '../store'
import { defineTool, textResult } from '../tools/define'

/** Only the original fai chat can create or change its work; specialists can still give direct answers. */
export function workBriefTools(store: PlatformStore, bus: EventBus) {
  const work = workBriefs(store.db)
  const available = ({ bot, conversation }: { bot: { isPrimary: boolean }; conversation: { kind: string } }) =>
    bot.isPrimary && conversation.kind === 'dm'
  const changed = (conversationId: string) => bus.emit('work:changed', { conversationId })
  return [
    defineTool({
      name: 'plan_work', description: 'Record a checkable brief for a substantial user request in this chat. Use once per original request; answer simple questions directly.',
      schema: z.object({ objective: z.string().trim().min(1).max(2000), deliverable: z.string().trim().min(1).max(2000), checks: z.string().trim().min(1).max(2000) }),
      source: 'faibots', defaultPermission: 'always', activityLabel: 'Recording the work brief', isAvailable: available,
      async execute(input, ctx) {
        if (!ctx.userEntryId) throw new Error('Start a brief only from a user request in this chat.')
        const brief = work.start(ctx.conversation.id, ctx.userEntryId, input.objective, input.deliverable, input.checks)
        changed(ctx.conversation.id)
        return textResult(JSON.stringify(brief))
      }
    }),
    defineTool({
      name: 'review_work', description: 'Look up work in this chat, ask a consequential question or submit a result for the user to review. Never mark your own work accepted.',
      schema: z.discriminatedUnion('action', [
        z.object({ action: z.literal('list') }),
        z.object({ action: z.literal('question'), id: z.string().min(1), revision: z.number().int().positive(), text: z.string().trim().min(1).max(4000) }),
        z.object({ action: z.literal('result'), id: z.string().min(1), revision: z.number().int().positive(), text: z.string().trim().min(1).max(16000),
          evidenceEntryIds: z.array(z.string().min(1)).max(32).optional() })
      ]),
      source: 'faibots', defaultPermission: 'always', activityLabel: 'Reviewing work', isAvailable: available,
      async execute(input, ctx) {
        if (input.action === 'list') return textResult(JSON.stringify(work.list(ctx.conversation.id)))
        const brief = work.submit(ctx.conversation.id, input.id, input.revision, input.action, input.text,
          input.action === 'result' ? input.evidenceEntryIds ?? [] : [])
        changed(ctx.conversation.id)
        return textResult(JSON.stringify(brief))
      }
    })
  ]
}

// If the app closes between recording an owner's answer and dispatching it, retry with the same chat nonce.
export async function deliverWorkReplies(store: PlatformStore, runtime: Pick<Runtime, 'send'>): Promise<void> {
  const work = workBriefs(store.db)
  for (const reply of work.pending()) {
    await runtime.send({ conversationId: reply.conversationId, clientNonce: `work-${reply.id}-${reply.revision}`,
      text: `${reply.decision === 'answer' ? 'Answer' : 'Requested change'} for work ${reply.id} (${reply.objective}): ${reply.note}`,
      mentions: [], mentionsEveryone: false, attachmentPaths: [] })
    work.acknowledge(reply.id, reply.revision)
  }
}
