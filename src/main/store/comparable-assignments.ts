import { createHash } from 'node:crypto'
import type { ModelRoute, ProviderConfig } from '@shared/domain'
import { baseUrlOf, billingRoute, DEFAULT_MODEL_ALIAS } from '@shared/provider-catalog'
import type { SpecialistJobKind } from '@shared/specialist-work'
import type { Db } from './db'

export interface JobComparison {
  kind: SpecialistJobKind
  providerId: string
  modelId: string
  routeKey: string
}
export type AssignmentSample = ReturnType<typeof comparableAssignments>

/** A CLI-selected default has no stable model ID. A changed endpoint or billing route is a different sample. */
export function comparableRoute(provider: ProviderConfig, modelId: string, effort?: ModelRoute['effort']) {
  if ((provider.kind === 'codex' || provider.kind === 'claude-code') && modelId === DEFAULT_MODEL_ALIAS) return undefined
  const routeKey = createHash('sha256').update(JSON.stringify([provider.kind, baseUrlOf(provider), billingRoute(provider), effort])).digest('hex')
  return { providerId: provider.id, modelId, routeKey }
}

function median(values: number[]) {
  if (values.length === 0) return null
  values.sort((a,b) => a-b)
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle]! : (values[middle-1]! + values[middle]!) / 2
}

export function comparableAssignments(db: Db, botId: string, chatId: string, criteria: JobComparison) {
  // Multiple posts can belong to one child turn. Without one unambiguous reply-turn link
  // we cannot attribute its configured model, usage or timing to this assignment.
  const rows = db.prepare(`select d.id, d.updated_at-d.created_at elapsed,
      case when t.codex_usage_state='unknown' or (d.engine='codex' and t.codex_usage_state is not 'measured') then null
        when exists (select 1 from entries m where m.kind='message' and m.reply_to_id=q.id and m.conversation_id=q.conversation_id
          and json_extract(m.author,'$.botId')=d.child_id and json_extract(m.meta,'$.turnId')=t.id
          and json_extract(m.meta,'$.measuredChildUsage')=1) then t.input_tokens+t.output_tokens end tokens,
      (select w.id from assignment_admissions a join chief_work_turns u on u.turn_id=a.root_turn_id
        join chief_work w on w.id=u.work_id where a.assignment_id=d.id and w.conversation_id=p.conversation_id
        and w.state='accepted' and w.partial=0) accepted_team_job
    from delegations d join entries p on p.id=d.parent_entry_id join entries q on q.id=d.question_id
    join turns t on t.id=(select min(json_extract(reply.meta,'$.turnId')) from entries reply
      where reply.reply_to_id=q.id and reply.conversation_id=q.conversation_id and reply.kind='message'
      and reply.is_streaming=0 and json_extract(reply.author,'$.kind')='bot'
      and json_extract(reply.author,'$.botId')=d.child_id
      having count(distinct json_extract(reply.meta,'$.turnId'))=1 and count(*)=count(json_extract(reply.meta,'$.turnId'))
        and min(case when json_extract(reply.meta,'$.comparisonRoute')=? then 1 else 0 end)=1)
    where d.child_id=? and p.conversation_id=? and d.state='answered' and json_extract(q.meta,'$.jobKind')=?
      and t.bot_id=d.child_id and t.conversation_id=q.conversation_id and t.conversation_kind='exchange'
      and t.trigger='agent' and t.status='sent' and t.provider_id=? and t.model_id=?
      and d.updated_at>=d.created_at
    order by d.updated_at desc,d.rowid desc limit 20`).all(criteria.routeKey,botId,chatId,criteria.kind,criteria.providerId,criteria.modelId)
  const tokens = rows.flatMap(row => typeof row.tokens === 'number' ? [row.tokens] : [])
  return {
    count: rows.length,
    medianMs: median(rows.map(row => Number(row.elapsed))),
    metered: tokens.length,
    medianTokens: median(tokens),
    acceptedTeamJobs: new Set(rows.map(row => row.accepted_team_job).filter(Boolean)).size
  }
}
