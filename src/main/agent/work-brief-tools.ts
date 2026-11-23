import { MAX_ASKS_PER_CHAIN, type WorkBrief } from '@shared/work-brief'
import { z } from 'zod'
import { getHandoffCheckpoint } from '../store/escalations'
import { MAIN_BOT_NAME } from '../store/bots'
import type { EventBus, Runtime, Services, ToolContext } from '../contracts'
import { pinnedChatInstruction } from '../store/project-request-instructions'
import { projectResultOrigin, readProjectResult } from '../store/project-result-requests'
import { workBriefs, WorkRefusal } from '../store/work-briefs'
import type { PlatformStore } from '../store'
import { defineTool, errorResult, textResult } from '../tools/define'

/** Only the original fai chat can create or change its work; specialists can still give direct answers. */
export function workBriefTools(store: PlatformStore, bus: EventBus, authority?: Pick<Services,'dataDir'|'attachments'>) {
  const work = workBriefs(store.db)
  const timestamp = z.iso.datetime({ offset:true })
  const waitFor = z.discriminatedUnion('kind', [
    z.object({kind:z.literal('all'), deadline:timestamp.optional()}),
    z.object({kind:z.literal('assignment'), assignmentId:z.string().min(1), deadline:timestamp.optional()}),
    z.object({kind:z.literal('first_match'), assignmentIds:z.array(z.string().min(1)).min(2).max(MAX_ASKS_PER_CHAIN),
      expectedReply:z.string().trim().min(1).max(2000), remaining:z.enum(['continue','cancel']), deadline:timestamp.optional()}),
    z.object({kind:z.literal('time'),at:timestamp}),
    z.object({kind:z.literal('webhook'),routineId:z.string().min(1),deadline:timestamp.optional()})
  ])
  const available = ({ bot, conversation }: { bot: { isPrimary: boolean; name: string }; conversation: { kind: string } }) =>
    bot.isPrimary && bot.name === MAIN_BOT_NAME && conversation.kind === 'dm'
  const changed = (conversationId: string) => bus.emit('work:changed', { conversationId })
  const handoffs = (chat: string, lookup: { userEntryId?: string; workId?: string }) =>
    getHandoffCheckpoint(store, chat, lookup, authority).map(({id,workId,availability}) => ({id,workId,availability}))
  function inScope(ctx: ToolContext, id?: string) {
    const trigger = ctx.projectResultTrigger
    const entry = trigger && store.entries.get(trigger.entryId)
    const origin = entry && projectResultOrigin(store,ctx.conversation.id,entry,trigger?.wake)
    if (trigger && (!origin || !ctx.selectedResultAvailable?.())) throw new WorkRefusal('The selected project request is unavailable.')
    const rows = work.forRequest(ctx.conversation.id,origin ?? null,id)
    if (id && !rows.length) throw new WorkRefusal('No such work in this request.')
    return rows
  }
  // Source content is returned through its live, permission-checked reader. The owner can see the full work card.
  const receipt = (ctx:ToolContext, brief:WorkBrief) => ctx.projectResultTrigger
    ? {id:brief.id,state:brief.state,revision:brief.revision,assignmentLimit:brief.assignmentLimit,partial:brief.partial}
    : brief
  function checkProjectResult(ctx: ToolContext, workId: string, result: string) {
    const entryId = work.get(workId,ctx.conversation.id).userEntryId
    if (!store.db.prepare('select 1 from project_request_instructions where entry_id=? and candidate_id is not null').get(entryId)) return
    const trigger = ctx.projectResultTrigger
    const entry = trigger && store.entries.get(trigger.entryId)
    if (!authority || !entry || projectResultOrigin(store,ctx.conversation.id,entry,trigger?.wake) !== entryId)
      throw new WorkRefusal('Return to the original project request to submit this result.')
    let instruction
    try {
      const selected = readProjectResult(store,authority,ctx.conversation.id,entryId)
      if (selected) instruction = pinnedChatInstruction(store.db,entryId,selected.projectId)
    } catch { /* Revoked requests disclose no project information. */ }
    if (!instruction) throw new WorkRefusal('The selected project request is unavailable.')
    if (!result.includes(instruction.requiredText))
      throw new WorkRefusal('The result is missing required output text from its reviewed project instruction. Read the selected request and check the result again.')
  }
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
        if (linked) inScope(ctx,linked)
        const brief = linked ? work.resume(ctx.conversation.id,linked,ctx.turnId) :
          work.start(ctx.conversation.id,ctx.userEntryId,ctx.turnId,input.objective,input.deliverable,input.checks,input)
        changed(ctx.conversation.id)
        return textResult(JSON.stringify({...receipt(ctx,brief),...(existing.length && {handoffs:existing})}))
      }
    }),
    defineTool({
      name: 'review_work', description: 'Look up work, ask a question when a missing decision blocks the job, or submit a result. For a question with distinct answers, put the question in text and the suggested answers in choices. The user can also type an answer. Never mark your own work accepted.',
      schema: z.object({
        action: z.enum(['list', 'wait', 'resume', 'question', 'result']), id: z.string().min(1).optional(),
        revision: z.number().int().positive().optional(), text: z.string().trim().min(1).max(16000).optional(),
        choices: z.array(z.string().trim().min(1).max(240)).min(2).max(6).optional(),
        waitFor: waitFor.optional().describe('For wait only. Choose all returns, a named assignment, the first exact expected answer with an explicit remaining-worker policy, a time, or the next webhook for an existing owner-configured routine. Use ISO dates with time zones.'),
        evidenceEntryIds: z.array(z.string().min(1)).max(32).optional(), partial: z.boolean().optional()
      }),
      source: 'faibots', defaultPermission: 'always', activityLabel: 'Reviewing work', isAvailable: available,
      async execute(input, ctx) {
        if (input.waitFor && input.action !== 'wait') throw new WorkRefusal('Use a wait condition only with the wait action.')
        if (input.choices && (input.action !== 'question' || new Set(input.choices.map(choice => choice.normalize('NFKC').toLowerCase())).size !== input.choices.length))
          throw new WorkRefusal('Use distinct suggested answers only when asking a question.')
        if (input.action === 'list') return textResult(JSON.stringify(inScope(ctx).map(brief=>receipt(ctx,brief))))
        if (!input.id) throw new WorkRefusal('Choose the brief by its ID.')
        inScope(ctx,input.id)
        if (input.action === 'resume') {
          const refs = handoffs(ctx.conversation.id,{workId:input.id})
          const brief = work.resume(ctx.conversation.id,input.id,ctx.turnId)
          return textResult(JSON.stringify({...receipt(ctx,brief),...(refs.length && {handoffs:refs})}))
        }
        if (input.action === 'wait') {
          if (!input.revision) throw new WorkRefusal('Include the current revision.')
          if (input.waitFor?.kind === 'first_match' && input.waitFor.remaining === 'cancel') {
            const permission = store.bots.get(ctx.bot.id)?.toolPermissions.cancel_assignment ?? store.settings.get().toolPermissions.cancel_assignment ?? 'always'
            if (permission !== 'always' || !ctx.admittedTools?.has('cancel_assignment'))
              throw new WorkRefusal('This chat requires a separate decision to cancel an assignment. Keep remaining workers running and request cancellation separately.')
          }
          const brief = work.wait(ctx.conversation.id,input.id,input.revision,ctx.turnId,input.waitFor)
          changed(ctx.conversation.id)
          return textResult(JSON.stringify(receipt(ctx,brief)))
        }
        if (!input.text || !input.revision) throw new WorkRefusal('Include the current revision and the question or result.')
        if (input.action === 'result' && !input.partial) checkProjectResult(ctx,input.id,input.text)
        const brief = work.submit(ctx.conversation.id, input.id, input.revision, input.action, input.text,
          input.action === 'result' ? input.evidenceEntryIds ?? [] : [], ctx.turnId, input.action === 'result' && input.partial === true, input.choices)
        changed(ctx.conversation.id)
        return textResult(JSON.stringify(receipt(ctx,brief)))
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
