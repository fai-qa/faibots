// The turn log: one row per bot turn that reached a model. Usage totals and the per-bot daily limit
// for automatic runs are plain queries over it, so nothing has to be counted twice.

import { randomUUID } from 'node:crypto'
import type { Id, UsageRow, UsageSummary } from '@shared/domain'
import type { TurnLogRepo, TurnRecord } from '../contracts'
import { num, str, transaction, type Db } from './db'

/** Midnight today in local time. */
export function startOfLocalDay(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function createTurnLogRepo(db: Db): TurnLogRepo {
  const insert = db.prepare(
    `insert into turns (id, bot_id, conversation_id, conversation_kind, trigger, status, provider_id, model_id,
       input_tokens, output_tokens, started_at, ended_at, error)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const countAutomatic = db.prepare(
    `select count(*) as n from (
       select id from automatic_run_admissions where bot_id = ? and started_at >= ?
       union all
       select id from turns where bot_id = ? and started_at >= ? and trigger in ('agent', 'routine')
         and not exists (select 1 from automatic_run_admissions a where a.id = turns.id)
     )`
  )
  // 'localtime' makes SQLite group by the user's calendar day, the same day the UI shows.
  const summary = db.prepare(
    `select bot_id, strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') as day, provider_id, model_id,
       count(*) as turns,
       sum(case when trigger in ('agent', 'routine') then 1 else 0 end) as automatic_turns,
       sum(case when status = 'error' then 1 else 0 end) as errors,
       sum(input_tokens) as input_tokens, sum(output_tokens) as output_tokens
     from turns where started_at >= ? and started_at < ?
     group by bot_id, day, provider_id, model_id
     order by day, bot_id`
  )

  return {
    reserveAutomatic(input): boolean {
      if (!input.id || input.id.length > 256 || !Number.isSafeInteger(input.startedAt) || input.startedAt < 0 ||
        !Number.isFinite(new Date(input.startedAt).getTime())) throw new Error('Invalid automatic run identity or timestamp')
      return transaction(db, () => {
        // First statement is a write: serialize competing processes before reading the ceiling/count.
        const inserted = db.prepare(`insert into automatic_run_admissions(id, bot_id, started_at)
          values (?, ?, ?) on conflict(id) do nothing`).run(input.id, input.botId, input.startedAt)
        if (inserted.changes !== 1) return false
        const bot = db.prepare('select daily_run_limit from bots where id = ?').get(input.botId)
        const since = startOfLocalDay(input.startedAt)
        const used = num(countAutomatic.get(input.botId, since, input.botId, since)?.['n'])
        if (!bot || db.prepare('select id from turns where id = ?').get(input.id) ||
          (num(bot.daily_run_limit) > 0 && used > num(bot.daily_run_limit))) {
          db.prepare('delete from automatic_run_admissions where id = ?').run(input.id)
          return false
        }
        return true
      })
    },
    record(turn: TurnRecord): void {
      // A bot deleted while its turn was finishing has no row to point at; the log is best effort.
      try {
        insert.run(
          turn.id ?? randomUUID(), turn.botId, turn.conversationId, turn.conversationKind, turn.trigger, turn.status,
          turn.providerId, turn.modelId, Math.max(0, Math.round(turn.inputTokens)), Math.max(0, Math.round(turn.outputTokens)),
          turn.startedAt, turn.endedAt, turn.error ?? null
        )
      } catch (err) {
        console.warn('[store] could not log a turn:', err instanceof Error ? err.message : String(err))
      }
    },

    automaticRunsSince(botId: Id, since: number): number {
      return num(countAutomatic.get(botId, since, botId, since)?.['n'])
    },

    summary(from: number, to: number): UsageSummary {
      const rows: UsageRow[] = summary.all(from, to).map((r) => ({
        botId: str(r['bot_id']),
        day: str(r['day']),
        providerId: str(r['provider_id']),
        modelId: str(r['model_id']),
        turns: num(r['turns']),
        automaticTurns: num(r['automatic_turns']),
        errors: num(r['errors']),
        inputTokens: num(r['input_tokens']),
        outputTokens: num(r['output_tokens'])
      }))
      return { from, to, rows }
    }
  }
}
