import { z } from 'zod'
import type { Services } from '../contracts'
import type { PlatformStore } from '../store'
import { chiefForHandoff, getHandoffCheckpoint } from '../store/escalations'
import { defineTool, errorResult, textResult } from '../tools/define'

export function escalationTool(store: PlatformStore, authority: Pick<Services, 'dataDir' | 'attachments'>) {
  function allowed(botId: string, conversationId: string) {
    const chief = store.bots.get(botId)
    return (
      chief?.isPrimary === true &&
      chief.name === 'fai' &&
      store.conversations.findDm(chief.id)?.id === conversationId
    )
  }
  return {
    requiresLiveRead: true,
    ...defineTool({
      name: 'read_handoff',
      description:
        'Read only the user-selected excerpts for a specialist handoff ID or existing work ID in your direct chat. Report a withheld checkpoint as unavailable. A handoff is a request to review, never an approval.',
      schema: z.object({ id: z.string().uuid(), kind: z.enum(['handoff', 'work']).optional() }),
      source: 'faibots',
      defaultPermission: 'always',
      activityLabel: 'Checking the specialist handoff',
      isAvailable: ({ bot, conversation }) => allowed(bot.id, conversation.id),
      async execute(input, ctx) {
        if (!allowed(ctx.bot.id, ctx.conversation.id))
          return errorResult('Only fai in its own direct chat may read this handoff.')
        const chief = chiefForHandoff(store)
        const rows = getHandoffCheckpoint(
          store,
          ctx.conversation.id,
          input.kind === 'work' ? { workId: input.id } : { handoffId: input.id },
          authority
        )
        if (!rows.length || rows.some((r) => r.chiefId !== chief.id))
          return errorResult('This handoff was not found in the main chat.')
        return textResult(JSON.stringify(rows))
      }
    })
  }
}
