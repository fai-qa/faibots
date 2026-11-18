import { createHash } from 'node:crypto'
import type { ActionRepo, ToolContext, ToolDefinition, ToolResult } from '../contracts'
import { errorResult } from './define'

/** Canonical JSON snapshot: later caller mutation cannot change an approved action. */
export function snapshotInput(input: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(input ?? {})) as unknown
  const freeze = (value: unknown): unknown => {
    if (Array.isArray(value)) return Object.freeze(value.map(freeze))
    if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, val]) => [key, freeze(val)])))
    return value
  }
  return freeze(copy)
}

export function nativeActionId(ctx: Pick<ToolContext, 'turnId' | 'callId' | 'bot' | 'conversation'>): string {
  return createHash('sha256').update(JSON.stringify([ctx.conversation.id, ctx.bot.id, ctx.turnId, ctx.callId])).digest('hex')
}

const unresolved = (id: string, message: string, state: 'unknown' | 'blocked' = 'unknown'): ToolResult => ({
  ...errorResult(message), recovery: { actionId: id, state }
})

/** A receipt is safe for disk: finalized/redacted text, never input or image payloads. */
function receipt(result: ToolResult): ToolResult {
  return { ...result, content: result.content.map((block) => block.type === 'text' ? block :
    { type: 'text', text: '[Image receipt omitted; binary payload was not retained.]' }) }
}

export async function executeAction(opts: {
  actions: ActionRepo
  ctx: ToolContext
  def: ToolDefinition
  input: unknown
  finalize(result: ToolResult): ToolResult
  /** Permission gate must call dispatch only after approval and the final abort check. */
  authorize(dispatch: () => Promise<ToolResult>): Promise<ToolResult>
}): Promise<ToolResult> {
  const { actions, ctx, def, input, finalize } = opts
  const id = ctx.actionId!
  const digest = createHash('sha256').update(JSON.stringify([ctx.workspaceDir, input])).digest('hex')
  const capability = JSON.stringify([def.source, def.serverId ?? '', def.recovery?.version ?? ''])
  let claim
  try {
    claim = actions.claim({ id, botId: ctx.bot.id, conversationId: ctx.conversation.id,
      toolName: def.name, inputDigest: digest, capability }, !!def.recovery?.version)
  } catch {
    return unresolved(id, 'Could not persist or claim the action. Nothing was dispatched.', 'blocked')
  }
  if (claim.kind === 'blocked') return unresolved(id, claim.reason, 'blocked')
  if (claim.kind === 'receipt') return claim.record.receipt ? finalize(claim.record.receipt) :
    unresolved(id, 'The action is closed but its receipt is unavailable. Do not repeat it.', 'blocked')

  const attempt = claim.record.attempt!
  let dispatched = claim.recovering
  let unknown = false
  try {
    const result = finalize(await opts.authorize(async () => {
      if (ctx.signal.aborted) return { ...errorResult('Cancelled.'), outcome: 'cancelled' }
      if (claim.recovering) {
        const recovered = await def.recovery!.recover(input, ctx)
        if (recovered) return recovered
        unknown = true
        return unresolved(id, 'The service could not establish the original outcome. Retry remains blocked.')
      }
      actions.dispatch(id, attempt)
      dispatched = true
      return def.execute(input, ctx)
    }))
    // Shell timeouts and MCP transport failures return isError without an outcome.
    // They can follow partial/complete external effects, including during recovery.
    // Denying recovery likewise cannot erase the original unknown effect.
    // A refusal made before any work started leaves nothing unknown, unless this is a recovery
    // of an earlier dispatch: then the original effect stays unknown.
    const refused = !!result.refusedBeforeRun && !claim.recovering
    const state = unknown || (dispatched && !refused && (!!result.isError || !!result.outcome)) || !!result.recovery ? 'unknown' :
      result.outcome === 'denied' ? 'denied' : result.outcome === 'cancelled' ? 'cancelled' : 'completed'
    const warning = 'The external outcome is unknown. Reconcile the original action before retrying.'
    const [first, ...rest] = result.content
    const returned = state === 'unknown' ? finalize({ ...result, isError: true, outcome: undefined,
      recovery: { actionId: id, state: 'unknown' },
      content: first?.type === 'text' ? [{ type: 'text', text: `${warning}\n\n${first.text}` }, ...rest] :
        [{ type: 'text', text: warning }, ...result.content] }) : result
    actions.finish(id, attempt, state, state === 'unknown' ? undefined : receipt(returned))
    return returned
  } catch {
    // This includes a lost service reply or a failed receipt write. Do not turn either
    // into a claim that an external effect failed. Keep the original key for recovery.
    const state = dispatched ? 'unknown' : 'cancelled'
    try { actions.finish(id, attempt, state, dispatched ? undefined : { ...errorResult('Action stopped before dispatch.'), outcome: 'cancelled' }) } catch { /* persisted dispatched/claimed state is recovered on startup */ }
    return unresolved(id, dispatched ?
      'The external outcome is unknown after interruption. Automatic retry is blocked until reconciliation.' :
      'Action stopped before dispatch; no external tool was called.', dispatched ? 'unknown' : 'blocked')
  }
}
