import type { ExchangeActivityInvoke, ExchangeMessage, ExchangeSummary } from '@shared/exchange-activity'
import { bool, num, str, type Db } from '../store/db'

// The anchor and question IDs are committed in the same transaction as the assignment.
// Pair rooms are reused. Their origin and the order of surrounding messages cannot prove a reply.
const scoped = `
with recursive
tree(anchor, job) as (
  select p.id,d.id from json_each(?) wanted
    join entries p on p.id=wanted.value and p.conversation_id=?
    join delegations d on d.parent_entry_id=p.id
  union
  select tree.anchor,child.id from tree
    join delegations parent on parent.id=tree.job
    join entries question on question.id=parent.question_id
    join assignment_admissions a on a.parent_assignment_id=parent.id
    join delegations child on child.id=a.assignment_id and child.caller_id=parent.child_id
    join entries anchor on anchor.id=child.parent_entry_id and anchor.conversation_id=question.conversation_id
),
nodes as materialized (
  select d.id,d.caller_id,d.child_id,d.state,d.question_id,q.rowid as position,q.conversation_id,
    d.state='answered' or json_type(d.receipt,'$.partial')='text' as expects_reply,a.root_turn_id
    from (select distinct job from tree) selected
    join delegations d on d.id=selected.job
    join entries q on q.id=d.question_id and q.kind='message'
      and json_extract(q.author,'$.kind')='bot' and json_extract(q.author,'$.botId')=d.caller_id
    join conversations room on room.id=q.conversation_id and room.kind='exchange'
    left join assignment_admissions a on a.assignment_id=d.id
),
-- Before replies carried the question ID, a nested call records the exact turn of its caller.
-- A terminal exchange turn can also prove ownership if the complete root ledger contains just
-- one matching assignment and one matching child turn. Any missing or competing assignment
-- invalidates that inference. No inference depends on receipt text, names, timestamps or proximity.
legacy_turns(job,turn_id) as (
  select n.id,json_extract(q.meta,'$.turnId') from nodes n
    join assignment_admissions a on a.parent_assignment_id=n.id
    join delegations child on child.id=a.assignment_id and child.caller_id=n.child_id
    join entries p on p.id=child.parent_entry_id and p.conversation_id=n.conversation_id
    join entries q on q.id=child.question_id and json_valid(q.meta) and q.kind='message'
      and json_extract(q.author,'$.kind')='bot' and json_extract(q.author,'$.botId')=child.caller_id
  union
  select n.id,t.id from nodes n
    join turns t on t.root_turn_id=n.root_turn_id and t.conversation_id=n.conversation_id
      and t.bot_id=n.child_id and t.conversation_kind='exchange' and t.trigger='agent'
    where not exists (
      select 1 from assignment_admissions a left join delegations d on d.id=a.assignment_id
      left join entries q on q.id=d.question_id
      where a.root_turn_id=n.root_turn_id and a.assignment_id<>n.id
        and (d.id is null or (d.child_id=n.child_id and q.conversation_id=n.conversation_id))
    ) and not exists (
      select 1 from turns competing where competing.root_turn_id=n.root_turn_id
        and competing.conversation_id=n.conversation_id and competing.bot_id=n.child_id
        and competing.trigger='agent' and competing.id<>t.id
    )
),
replies(job,entry_id) as (
  select n.id,e.id from nodes n join entries e on e.reply_to_id=n.question_id
    and e.kind='message' and e.conversation_id=n.conversation_id
    and json_extract(e.author,'$.kind')='bot' and json_extract(e.author,'$.botId')=n.child_id
    and not exists(select 1 from delegations other where other.question_id=e.id)
  union
  select n.id,e.id from legacy_turns proof join nodes n on n.id=proof.job
    join entries e on json_valid(e.meta) and json_extract(e.meta,'$.turnId')=proof.turn_id
      and e.reply_to_id is null and e.kind='message' and e.conversation_id=n.conversation_id
      and json_extract(e.author,'$.kind')='bot' and json_extract(e.author,'$.botId')=n.child_id
      and not exists(select 1 from delegations other where other.question_id=e.id)
),
messages(job,entry_id,recipient_id) as (
  select id,question_id,child_id from nodes
  union all
  select n.id,r.entry_id,n.caller_id from replies r join nodes n on n.id=r.job
)`

const summaries =
  scoped +
  `,
counts as (select job,count(*) as n from replies group by job)
select tree.anchor,n.caller_id,n.child_id,n.state,n.expects_reply,
  coalesce(counts.n,0) as reply_count
from tree join nodes n on n.id=tree.job left join counts on counts.job=n.id order by n.position`

const page =
  scoped +
  `,
visible as (
  select e.rowid as position,e.id,m.recipient_id
  from messages m join entries e on e.id=m.entry_id group by e.id
),
cursor(value) as (values (?))
select e.id,e.conversation_id,json_extract(e.author,'$.botId') as author_id,v.recipient_id,e.text,e.created_at,e.is_streaming
from visible v join entries e on e.id=v.id
where (select value from cursor) is null or v.position < (select p.position from visible p join cursor on p.id=cursor.value)
order by v.position desc limit ?`

function selection(req: ExchangeActivityInvoke['conv:exchange-summaries']['req']) {
  if (
    !req ||
    typeof req.conversationId !== 'string' ||
    !req.conversationId ||
    req.conversationId.length > 256 ||
    !Array.isArray(req.entryIds) ||
    req.entryIds.length > 100 ||
    !req.entryIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)
  )
    throw new Error('Choose up to 100 activity entries from one conversation.')
  return JSON.stringify([...new Set(req.entryIds)])
}

export function exchangeActivityHandlers(
  db: Db,
  streamingText?: (room: string, entryId: string) => string | undefined
) {
  return {
    'conv:exchange-summaries': (
      req: ExchangeActivityInvoke['conv:exchange-summaries']['req']
    ): ExchangeSummary[] => {
      const ids = selection(req)
      if (!req.entryIds.length) return []
      const byAnchor = new Map<string, ExchangeSummary>()
      for (const row of db.prepare(summaries).all(ids, req.conversationId)) {
        const anchorId = str(row.anchor),
          callerId = str(row.caller_id)
        const summary = byAnchor.get(anchorId) ?? {
          anchorId,
          callerId,
          botIds: [callerId],
          messageCount: 0,
          active: false
        }
        for (const id of [callerId, str(row.child_id)])
          if (!summary.botIds.includes(id)) summary.botIds.push(id)
        summary.messageCount += 1 + num(row.reply_count)
        if (row.state === 'assigned') summary.active = true
        if (row.state === 'reconciliation_required') summary.attention = 'reconciliation_required'
        else if (row.state === 'failed' && !summary.attention) summary.attention = 'failed'
        if (bool(row.expects_reply) && !num(row.reply_count)) summary.incompleteHistory = true
        byAnchor.set(anchorId, summary)
      }
      return [...byAnchor.values()]
    },
    'conv:exchange-messages': (req: ExchangeActivityInvoke['conv:exchange-messages']['req']) => {
      const ids = selection(req),
        limit = req.limit ?? 50
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (req.before !== undefined &&
          (typeof req.before !== 'string' || !req.before || req.before.length > 256))
      )
        throw new Error('Invalid exchange transcript page.')
      const rows = db.prepare(page).all(ids, req.conversationId, req.before ?? null, limit + 1)
      const messages: ExchangeMessage[] = rows
        .slice(0, limit)
        .reverse()
        .map((row) => ({
          id: str(row.id),
          conversationId: str(row.conversation_id),
          authorId: str(row.author_id),
          recipientId: str(row.recipient_id),
          text:
            (bool(row.is_streaming) ? streamingText?.(str(row.conversation_id), str(row.id)) : undefined) ??
            str(row.text),
          createdAt: num(row.created_at),
          isStreaming: bool(row.is_streaming)
        }))
      return { messages, ...(rows.length > limit && { before: messages[0]!.id }) }
    }
  }
}
