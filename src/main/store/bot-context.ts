import type { BotContextRepo, BotContextState } from '../contracts'
import { num, optStr, parseJson, str, type Db } from './db'

export function createBotContextRepo(db: Db): BotContextRepo {
  return {
    get(conversationId, botId) {
      const row = db.prepare('select * from bot_context where conversation_id = ? and bot_id = ?').get(conversationId, botId)
      const engineSessionId = optStr(row?.['engine_session_id'])
      const binding = optStr(row?.['engine_binding'])
      const systemHash = optStr(row?.['system_hash'])
      const codexUsageBaseline = parseJson<BotContextState['codexUsageBaseline']>(row?.['codex_usage_baseline'], undefined)
      return {
        conversationId,
        botId,
        lastSeenSeq: num(row?.['last_seen_seq']),
        summary: str(row?.['summary']),
        summarizedUpToSeq: num(row?.['summarized_up_to_seq']),
        ...(engineSessionId && { engineSessionId }),
        ...(binding && { engineBinding: binding }),
        ...(systemHash && { systemHash }),
        ...(codexUsageBaseline?.threadId === engineSessionId && codexUsageBaseline && { codexUsageBaseline })
      }
    },

    set(state: BotContextState) {
      db.prepare(
        `insert into bot_context (conversation_id, bot_id, last_seen_seq, summary, summarized_up_to_seq, engine_session_id, engine_binding, system_hash, codex_usage_baseline)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (conversation_id, bot_id) do update set last_seen_seq = excluded.last_seen_seq,
           summary = excluded.summary, summarized_up_to_seq = excluded.summarized_up_to_seq,
           engine_session_id = excluded.engine_session_id, engine_binding = excluded.engine_binding,
           system_hash = excluded.system_hash, codex_usage_baseline = excluded.codex_usage_baseline`
      ).run(
        state.conversationId, state.botId, state.lastSeenSeq, state.summary, state.summarizedUpToSeq,
        state.engineSessionId ?? null, state.engineBinding ?? null, state.systemHash ?? null,
        state.codexUsageBaseline?.threadId === state.engineSessionId ? JSON.stringify(state.codexUsageBaseline) ?? null : null
      )
    },

    clearConversation(conversationId) {
      db.prepare('delete from bot_context where conversation_id = ?').run(conversationId)
    }
  }
}
