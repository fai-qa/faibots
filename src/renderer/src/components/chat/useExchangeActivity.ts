import { useEffect, useState } from 'react'
import type { Entry } from '@shared/domain'
import type { ExchangeSummary } from '@shared/exchange-activity'
import { invoke, on } from '../../lib/bridge'
import { useData } from '../../store/data'

/** A completed bot message or a changed call can update a row in the parent chat. */
export function useExchangeChanges(conversationId: string, enabled: boolean, watchText = false) {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    function schedule() {
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; setVersion((v) => v + 1) }, 160)
    }
    const isExchange = (id: string) => useData.getState().conversations.some((c) => c.id === id && c.kind === 'exchange')
    const off = [on('conv:entry', ({ entry }) => {
      if (entry.conversationId === conversationId || (entry.kind === 'message' && isExchange(entry.conversationId))) schedule()
    }), on('conv:deleted', schedule)]
    if (watchText) off.push(on('conv:delta', ({ conversationId: id }) => { if (isExchange(id)) schedule() }))
    return () => { clearTimeout(timer); off.forEach((unsubscribe) => unsubscribe()) }
  }, [conversationId, enabled, watchText])
  return version
}

const empty: ReadonlyMap<string, ExchangeSummary> = new Map()

export function useExchangeSummaries(conversationId: string, entries: Entry[] | undefined) {
  // External engine and background calls can anchor to a system event instead of a tool card.
  const ids = JSON.stringify((entries ?? []).filter((entry) => entry.kind === 'event' ||
    entry.toolCall?.toolName === 'send_to_agent' || entry.toolCall?.toolName === 'assign_to_agent').map((entry) => entry.id))
  const version = useExchangeChanges(conversationId, ids !== '[]')
  const [result, setResult] = useState<{ chat: string; rows: ReadonlyMap<string, ExchangeSummary> }>()
  useEffect(() => {
    let alive = true
    const anchors: string[] = JSON.parse(ids)
    async function refresh() {
      const rows = new Map<string, ExchangeSummary>()
      for (let i = 0; i < anchors.length && alive; i += 100) {
        const batch = await invoke('conv:exchange-summaries', { conversationId, entryIds: anchors.slice(i, i + 100) })
        for (const row of batch) if (row.messageCount > 0) rows.set(row.anchorId, row)
      }
      if (alive) setResult({ chat: conversationId, rows })
    }
    void refresh().catch(() => { if (alive) setResult({ chat: conversationId, rows: empty }) })
    return () => { alive = false }
  }, [conversationId, ids, version])
  return result?.chat === conversationId ? result.rows : empty
}
