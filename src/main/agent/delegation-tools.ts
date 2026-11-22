import { z } from 'zod'
import type { Bot, Conversation, Entry } from '@shared/domain'
import type { Store, ToolContext, ToolRegistry, ToolResult } from '../contracts'
import { type createDelegationRepo, type DelegationLease } from '../store/delegations'
import { nativeActionId } from '../tools/action-executor'
import { defineTool, errorResult, textResult } from '../tools/define'

type Repo = ReturnType<typeof createDelegationRepo>
type Work = NonNullable<ReturnType<Repo['get']>>
const scope = ({ bot, conversation }: { bot: Bot; conversation: Conversation }) =>
  bot.isPrimary && conversation.kind !== 'exchange' && conversation.botIds.includes(bot.id)
const job = z.object({
  to: z.string().trim().min(1), message: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(500).optional(), deliverable: z.string().trim().min(1).max(1000).optional(),
  requiredSkills: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
  requiredTools: z.array(z.string().trim().min(1).max(128)).max(16).optional()
})
const workId = z.string().min(1)
const refuse = (message: string) => ({ ...errorResult(message), refusedBeforeRun: true })
const summary = (work: Work) => [
  `${work.id} · ${work.state}`, work.receipt?.text,
  work.lateReturn && `Late observation (unconfirmed): ${work.lateReturn.text}`
].filter(Boolean).join('\n')

interface Active {
  stop: AbortController
  admitted: ReturnType<typeof deferred<ToolResult>>
  done: ReturnType<typeof deferred<void>>
  lease?: DelegationLease
  parentId: string
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

export class BackgroundAssignments {
  private active = new Map<string, Active>()
  constructor(private repo: Repo, private registry: ToolRegistry, private store: Store, private emit: (entry: Entry) => void) {}

  abort(id: string): void {
    const active = this.active.get(id)
    if (!active) return
    if (active.lease && this.repo.get(id)?.state === 'assigned') {
      const entry = this.repo.finish(active.lease, 'reconciliation_required', {
        text: 'Cancellation requested. Completed actions remain recorded. Check the exchange for effects that were still in progress.'
      })
      if (entry) this.emit(entry)
    }
    active.stop.abort()
  }
  isDetached(id: string): boolean { return this.active.has(id) }
  stopChat(id: string): void {
    for (const [assignmentId, active] of this.active) if (active.parentId === id) this.abort(assignmentId)
  }
  admitted(lease: DelegationLease, exchangeId: string): void {
    const active = this.active.get(lease.id)
    if (!active) return
    active.lease = lease
    active.admitted.resolve(textResult(`Assignment ${lease.id} is running. You can answer now. Its result will return to this chat.`,
      { exchangeConversationId: exchangeId }))
  }
  // Returns only after the ordinary send_to_agent tool has admitted the work, including its approvals.
  async assign(input: z.infer<typeof job>, ctx: ToolContext): Promise<ToolResult> {
    const liveBot = this.store.bots.get(ctx.bot.id)
    const liveChat = this.store.conversations.get(ctx.conversation.id)
    if (!liveBot || !liveChat || !scope({ bot: liveBot, conversation: liveChat })) return refuse('Only the main bot may start background work in its own chat or group.')
    const inner = { ...ctx, bot: liveBot, conversation: liveChat, callId: ctx.callId + '/background' }
    const id = nativeActionId(inner)
    const existing = this.repo.scoped(id, ctx.bot.id, ctx.conversation.id)
    if (existing) return textResult(summary(existing))
    const inProgress = this.active.get(id)
    if (inProgress) return inProgress.admitted.promise
    const active: Active = {
      stop: new AbortController(), admitted: deferred<ToolResult>(), done: deferred<void>(), parentId: ctx.conversation.id
    }
    this.active.set(id, active)
    // Cancellation while approval is pending must stop dispatch. After admission only an explicit
    // cancellation, conversation stop, child timeout, or shutdown stops the background task.
    const beforeAdmission = () => { if (!active.lease) active.stop.abort() }
    if (ctx.signal.aborted) beforeAdmission()
    ctx.signal.addEventListener('abort', beforeAdmission, { once: true })
    void this.registry.execute('send_to_agent', input, { ...inner, actionId: id, signal: active.stop.signal })
      .then((result) => { active.admitted.resolve(!active.lease && result.isError && !result.recovery ? { ...result, refusedBeforeRun: true } : result) },
        () => { active.admitted.resolve(errorResult('The local delegation could not be confirmed. Check its status before retrying.')) })
      .finally(() => {
        ctx.signal.removeEventListener('abort', beforeAdmission)
        this.active.delete(id)
        active.done.resolve()
      })
    return active.admitted.promise
  }
  tools() {
    const common = { source: 'faibots' as const, defaultPermission: 'always' as const, isAvailable: scope }
    const scoped = (id: string, ctx: ToolContext) => this.repo.scoped(id, ctx.bot.id, ctx.conversation.id)
    const unavailable = () => refuse('No background assignment with that ID belongs to this bot and conversation.')
    return [
      defineTool({ ...common, name: 'assign_to_agent', description: 'Start a background assignment through normal specialist checks. Return its ID now and continue chatting. The result is delivered here.',
        activityLabel: 'Assigning background work', schema: job, execute: (input, ctx) => this.assign(input, ctx) }),
      defineTool({ ...common, name: 'assignment_status', description: 'Read one background assignment by its original ID, or list recent assignments in this chat.',
        activityLabel: 'Checking assignments', schema: z.object({ id: workId.optional() }), execute: async (input, ctx) => {
          if (input.id) { const work = scoped(input.id, ctx); return work ? textResult(summary(work)) : unavailable() }
          return textResult(this.repo.list(ctx.bot.id, ctx.conversation.id).map(summary).join('\n\n') || 'No background assignments in this chat.')
        } }),
      defineTool({ ...common, name: 'wait_for_assignment', description: 'Wait up to 20 seconds for an existing assignment or return its current state. A timeout leaves the child running.',
        activityLabel: 'Waiting for an assignment', schema: z.object({ id: workId, seconds: z.number().int().min(1).max(20).default(5) }),
        execute: async (input, ctx) => {
          const work = scoped(input.id, ctx)
          if (!work) return unavailable()
          const running = this.active.get(input.id)
          if (!running || work.state !== 'assigned') return textResult(summary(work))
          const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(input.seconds * 1000)])
          const wake = deferred<void>()
          const stop = () => wake.resolve()
          signal.addEventListener('abort', stop, { once: true })
          try {
            if (!signal.aborted) await Promise.race([wake.promise, running.done.promise])
            const current = scoped(input.id, ctx)
            return current ? textResult(summary(current)) : unavailable()
          } finally { signal.removeEventListener('abort', stop) }
        } }),
      defineTool({ ...common, name: 'cancel_assignment', description: 'Request cancellation of exactly one background assignment from this chat. Completed work remains recorded.',
        activityLabel: 'Cancelling an assignment', schema: z.object({ id: workId }), execute: async (input, ctx) => {
          const work = scoped(input.id, ctx)
          if (!work) return unavailable()
          if (work.state !== 'assigned') return textResult(summary(work))
          const current = this.active.get(input.id)
          if (!current?.lease) return errorResult('This assignment has no live worker. Its effects need reconciliation.')
          this.abort(input.id)
          return textResult(`Assignment ${work.id}: reconciliation_required. Cancellation requested; completed effects remain recorded.`)
        } }),
      defineTool({ ...common, name: 'group_work_snapshot', description: 'Show current pending, completed, failed and uncertain assignments originating in this group, including nested work.',
        isAvailable: ({ bot, conversation }) => conversation.kind === 'group' && conversation.botIds.includes(bot.id),
        activityLabel: 'Checking group work', schema: z.object({}), execute: async (_input, ctx) => {
          const room = this.store.conversations.get(ctx.conversation.id)
          if (room?.kind !== 'group' || !room.botIds.includes(ctx.bot.id)) return refuse('Only members can inspect this group.')
          const { totals, latest } = this.repo.groupSnapshot(room.id)
          const labels: Record<string, string> = { assigned: 'Pending', answered: 'Completed', failed: 'Failed', reconciliation_required: 'Uncertain' }
          const counts = Object.entries(labels).map(([key, label]) => `${label}: ${totals.find((row) => row.state === key)?.n ?? 0}`)
          const jobs = latest.map((row) => `${row.id} · ${labels[String(row.state)]} · ${this.store.bots.get(String(row.child_id))?.name ?? 'Deleted specialist'}`)
          return textResult([...counts, ...jobs].join('\n'))
        } })
    ]
  }
}
