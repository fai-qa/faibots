import { ArrowLeftRight, ArrowRight } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Bot } from '@shared/domain'
import type { ExchangeMessage, ExchangeSummary } from '@shared/exchange-activity'
import type { SelectionComparison } from '@shared/specialist-work'
import { invoke, on } from '../../lib/bridge'
import { formatFull, formatTime } from '../../lib/format'
import { useData } from '../../store/data'
import { BotAvatar, GroupAvatar } from '../avatar/BotAvatar'
import { Spinner } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Markdown } from './Markdown'
import { useExchangeChanges } from './useExchangeActivity'

function selectionHistory(sample: SelectionComparison): string {
  const scope = 'in this chat on the same model and provider'
  if (!sample.count || sample.medianMs === null) return `At selection, there were no earlier matching ${sample.kind} jobs ${scope}.`
  const duration = sample.medianMs < 1000 ? `${sample.medianMs} ms` : `${(sample.medianMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`
  const usage = sample.medianTokens === null ? 'Token use unknown.' :
    `Median ${sample.medianTokens.toLocaleString()} tokens (${sample.metered} of ${sample.count} measured).`
  const history = sample.count === 20
    ? `the sample covered the 20 most recent ${sample.kind} jobs ${scope}.`
    : `${sample.count} earlier ${sample.kind} ${sample.count === 1 ? 'job' : 'jobs'} in this chat used the same model and provider.`
  return `At selection, ${history} Median turnaround ${duration}. ${usage}`
}

function FaceName({ bot }: { bot?: Bot }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {bot && <span aria-hidden="true" className="inline-flex"><BotAvatar bot={bot} size={18} /></span>}
      <bdi className="truncate">{bot?.name ?? 'Deleted bot'}</bdi>
    </span>
  )
}

export function ExchangeActivity({ conversationId, rows }: { conversationId: string; rows: ExchangeSummary[] }) {
  const byId = useData((state) => state.botMap)
  const [open, setOpen] = useState(false)
  const ids = [...new Set(rows.flatMap((row) => row.botIds))]
  const peers = ids.filter((id) => id !== rows[0]?.callerId)
  const count = rows.reduce((sum, row) => sum + row.messageCount, 0)
  const messageLabel = String(count) + (count === 1 ? ' message' : ' messages')
  const peerLabel = peers.length > 2 ? peers.length + ' bots' : peers.map((id) => byId.get(id)?.name ?? 'Deleted bot').join(' and ')
  const key = JSON.stringify(rows.map((row) => row.anchorId))
  return (
    <div className="flex min-w-0 justify-center py-1">
      <button type="button" aria-haspopup="dialog" aria-expanded={open}
        aria-label={'Open bot conversation: ' + messageLabel + (peerLabel ? ' with ' + peerLabel : '')}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-9 max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full px-3 py-1 text-xs font-medium text-fg-2 hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2">
        {rows.some((row) => row.active) && <Spinner size={12} />}
        <span>{messageLabel}{peers.length > 0 && ' with'}</span>
        {peers.length > 2 ? (
          <><span aria-hidden="true"><GroupAvatar bots={botsFor(peers, byId)} size={23} /></span>{peerLabel}</>
        ) : peers.map((id, i) => (
          <Fragment key={id}>{i > 0 && <span>and</span>}<FaceName bot={byId.get(id)} /></Fragment>
        ))}
      </button>
      {open && (
        <Dialog
          title={<span className="flex flex-wrap items-center gap-2">
            <span className="sr-only">Bot conversation with </span>
            {ids.map((id, i) => (
              <Fragment key={id}>
                {i > 0 && (ids.length === 2
                  ? <ArrowLeftRight size={13} className="shrink-0 text-fg-3" aria-hidden="true" />
                  : <span aria-hidden="true" className="text-fg-3">·</span>)}
                <FaceName bot={byId.get(id)} />
              </Fragment>
            ))}
          </span>}
          onClose={() => setOpen(false)} width={680} bodyClassName="!overflow-hidden !p-0"
          footer={<Button data-autofocus size="sm" onClick={() => setOpen(false)}>Close chat</Button>}
        >
          <ExchangeHistory key={conversationId + key} conversationId={conversationId} anchorKey={key} bots={byId}
            incomplete={rows.some((row) => row.incompleteHistory)} />
        </Dialog>
      )}
    </div>
  )
}

function botsFor(ids: string[], byId: Map<string, Bot>): Bot[] {
  return ids.flatMap((id) => { const bot = byId.get(id); return bot ? [bot] : [] })
}

function ExchangeHistory({ conversationId, anchorKey, bots, incomplete }: {
  conversationId: string; anchorKey: string; bots: Map<string, Bot>; incomplete: boolean
}) {
  const version = useExchangeChanges(conversationId, true, true)
  const [view, setView] = useState<{ messages: ExchangeMessage[]; before?: string }>()
  const [error, setError] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const read = useRef<(older?: boolean) => void>(() => {})
  const retryOlder = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const earlier = useRef<{ id: string; offset: number } | undefined>(undefined)

  useEffect(() => {
    const entryIds: string[] = JSON.parse(anchorKey)
    let generation = 0
    let current = true
    let running = false
    let pending = false
    let pendingOlder = false
    let visible: { messages: ExchangeMessage[]; before?: string } | undefined
    async function drain() {
      if (running) return
      running = true
      try {
        while (current && (pending || pendingOlder)) {
          const older = Boolean(pendingOlder && visible?.before)
          const start = generation
          if (older) pendingOlder = false
          else { pending = false; pendingOlder = false }
          try {
            let page = await invoke('conv:exchange-messages', { conversationId, entryIds, before: older ? visible?.before : undefined, limit: 50 })
            if (!current || generation !== start) continue
            if (older && visible) {
              page = { before: page.before, messages: [...page.messages, ...visible.messages] }
            } else if (visible && page.messages.length) {
              // Catch up from the newest page to the first message we already have.
              // Keep older pages open while new messages arrive.
              const positions = new Map(visible.messages.map((message, index) => [message.id, index]))
              while (current && generation === start && page.before && !page.messages.some((m) => positions.has(m.id))) {
                const previous = await invoke('conv:exchange-messages', { conversationId, entryIds, before: page.before, limit: 50 })
                page = { before: previous.before, messages: [...previous.messages, ...page.messages] }
              }
              if (!current || generation !== start) continue
              const first = page.messages[0]
              const overlap = first ? positions.get(first.id) : undefined
              if (overlap !== undefined && overlap > 0) {
                page = { before: visible.before, messages: [...visible.messages.slice(0, overlap), ...page.messages] }
              }
            }
            visible = page
            setView(page)
            setError(false)
          } catch {
            if (current && start === generation) {
              retryOlder.current = older
              setError(true)
            }
          } finally {
            if (current && older) setLoadingEarlier(false)
          }
        }
      } finally {
        running = false
      }
    }
    read.current = (older = false) => {
      if (older && visible?.before) { pendingOlder = true; setLoadingEarlier(true) }
      else pending = true
      void drain()
    }
    const off = on('conv:deleted', () => {
      generation++
      visible = undefined
      earlier.current = undefined
      setView(undefined)
      setLoadingEarlier(false)
      read.current()
    })
    return () => { current = false; off(); read.current = () => {} }
  }, [conversationId, anchorKey])

  useEffect(() => { read.current() }, [version, conversationId, anchorKey])

  useLayoutEffect(() => {
    const el = scroll.current
    if (!el || !view) return
    const saved = earlier.current
    if (saved && !loadingEarlier) {
      const anchor = Array.from(el.querySelectorAll<HTMLElement>('[data-exchange-message]')).find((item) => item.dataset.exchangeMessage === saved.id)
      if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - saved.offset
      earlier.current = undefined
    } else if (pinned.current && !saved) {
      el.scrollTop = el.scrollHeight
    }
  }, [view, loadingEarlier])

  function loadEarlier() {
    const first = scroll.current?.querySelector<HTMLElement>('[data-exchange-message]')
    if (first?.dataset.exchangeMessage) earlier.current = { id: first.dataset.exchangeMessage, offset: first.getBoundingClientRect().top }
    read.current(true)
  }

  return (
    <div ref={scroll} className="scroll-y max-h-[min(59vh,620px)] min-h-24 overscroll-contain px-5 py-3" onScroll={(e) => {
      const el = e.currentTarget
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    }}>
      {incomplete && <p className="mb-3 text-xs text-fg-2">Some older messages could not be linked to this exchange.</p>}
      {error && <div role="status" className="mb-3 flex items-center gap-2 text-xs text-fg-2">Couldn’t load the conversation. <Button size="sm" onClick={() => retryOlder.current ? loadEarlier() : read.current()}>Try again</Button></div>}
      {!view && !error && <p role="status" className="text-xs text-fg-2">Loading messages…</p>}
      {view?.before && <div className="mb-3 text-center"><Button size="sm" variant="ghost" disabled={loadingEarlier} onClick={loadEarlier}>Show earlier messages</Button></div>}
      {view?.messages.length === 0 && <p className="text-xs text-fg-2">No messages available for this exchange.</p>}
      <ol className="space-y-3">
        {view?.messages.map((message) => {
          const bot = bots.get(message.authorId)
          const recipient = bots.get(message.recipientId)
          return (
            <li key={message.id} data-exchange-message={message.id} className="flex min-w-0 items-start gap-2">
              <span aria-hidden="true" className="w-6 shrink-0 pt-0.5">{bot && <BotAvatar bot={bot} size={24} />}</span>
              <div className="min-w-0 max-w-full">
                <div className="mb-1 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-2">
                  <bdi className="font-semibold text-fg">{bot?.name ?? 'Deleted bot'}</bdi>
                  <ArrowRight aria-hidden="true" size={12} /><span className="sr-only">to </span><bdi>{recipient?.name ?? 'Deleted bot'}</bdi>
                  <time dateTime={new Date(message.createdAt).toISOString()} title={formatFull(message.createdAt)}>{formatTime(message.createdAt)}</time>
                </div>
                <div dir="auto" className="selectable max-w-full break-words rounded-xl rounded-tl-sm bg-sunken px-3 py-2 text-[13px] text-fg">
                  <Markdown text={message.text} streaming={message.isStreaming} />
                </div>
                {(message.selectionReason || message.selectionComparison) && (
                  <div className="selectable mt-1.5 max-w-prose break-words text-xs text-fg-2">
                    <span className="font-semibold">Why <bdi>{recipient?.name ?? 'this specialist'}</bdi> was chosen</span>
                    {message.selectionReason && <p dir="auto" className="whitespace-pre-wrap">{message.selectionReason}</p>}
                    {message.selectionComparison && <p>{selectionHistory(message.selectionComparison)}</p>}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
