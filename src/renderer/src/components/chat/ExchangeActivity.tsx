import { ArrowLeftRight, ArrowRight } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Bot } from '@shared/domain'
import type { ExchangeMessage, ExchangeSummary } from '@shared/exchange-activity'
import { invoke } from '../../lib/bridge'
import { formatFull, formatTime } from '../../lib/format'
import { useData } from '../../store/data'
import { BotAvatar, GroupAvatar } from '../avatar/BotAvatar'
import { Spinner } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Markdown } from './Markdown'
import { useExchangeChanges } from './useExchangeActivity'

function FaceName({ bot }: { bot?: Bot }) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      {bot && <span aria-hidden="true" className="inline-flex"><BotAvatar bot={bot} size={18} /></span>}
      <bdi className="truncate">{bot?.name ?? 'Deleted bot'}</bdi>
    </span>
  )
}

export function ExchangeActivity({ conversationId, rows }: { conversationId: string; rows: ExchangeSummary[] }) {
  const bots = useData((state) => state.bots)
  const [open, setOpen] = useState(false)
  const byId = new Map(bots.map((bot) => [bot.id, bot]))
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
        className="inline-flex min-h-9 max-w-full flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-full px-3 py-1 text-xs font-medium text-fg-3 hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2">
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
              <Fragment key={id}>{i > 0 && <ArrowLeftRight size={13} className="shrink-0 text-fg-3" aria-hidden="true" />}<FaceName bot={byId.get(id)} /></Fragment>
            ))}
          </span>}
          onClose={() => setOpen(false)} width={680} bodyClassName="!overflow-hidden !p-0"
          footer={<Button data-autofocus size="sm" onClick={() => setOpen(false)}>Close chat</Button>}
        >
          <ExchangeHistory conversationId={conversationId} anchorKey={key} bots={byId}
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
  const [pages, setPages] = useState(1)
  const [retry, setRetry] = useState(0)
  const [view, setView] = useState<{ messages: ExchangeMessage[]; more: boolean; pages: number }>()
  const [error, setError] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const earlier = useRef<{ id: string; offset: number } | undefined>(undefined)

  useEffect(() => {
    let current = true
    const entryIds: string[] = JSON.parse(anchorKey)
    async function load() {
      let messages: ExchangeMessage[] = []
      let before: string | undefined
      for (let i = 0; current && i < pages; i++) {
        const page = await invoke('conv:exchange-messages', { conversationId, entryIds, before, limit: 50 })
        messages = [...page.messages, ...messages]
        before = page.before
        if (!before) break
      }
      if (current) {
        setView({ messages, more: Boolean(before), pages })
        setError(false)
      }
    }
    void load().catch(() => { if (current) setError(true) })
    return () => { current = false }
  }, [conversationId, anchorKey, pages, retry, version])

  useLayoutEffect(() => {
    const el = scroll.current
    if (!el || !view) return
    const saved = earlier.current
    if (saved && pages === view.pages) {
      const anchor = Array.from(el.querySelectorAll<HTMLElement>('[data-exchange-message]')).find((item) => item.dataset.exchangeMessage === saved.id)
      if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - saved.offset
      earlier.current = undefined
    } else if (pinned.current && !saved) {
      el.scrollTop = el.scrollHeight
    }
  }, [view, pages])

  function loadEarlier() {
    const first = scroll.current?.querySelector<HTMLElement>('[data-exchange-message]')
    if (first?.dataset.exchangeMessage) earlier.current = { id: first.dataset.exchangeMessage, offset: first.getBoundingClientRect().top }
    setPages((n) => n + 1)
  }

  return (
    <div ref={scroll} className="scroll-y max-h-[min(59vh,620px)] min-h-24 overscroll-contain px-5 py-3" onScroll={(e) => {
      const el = e.currentTarget
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    }}>
      {incomplete && <p className="mb-3 text-xs text-fg-3">Some older messages could not be linked to this exchange.</p>}
      {error && <div role="status" className="mb-3 flex items-center gap-2 text-xs text-fg-2">Couldn’t load the conversation. <Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button></div>}
      {!view && !error && <p role="status" className="text-xs text-fg-3">Loading messages…</p>}
      {view?.more && <div className="mb-3 text-center"><Button size="sm" variant="ghost" disabled={pages !== view.pages && !error} onClick={loadEarlier}>Show earlier messages</Button></div>}
      {view?.messages.length === 0 && <p className="text-xs text-fg-3">No messages available for this exchange.</p>}
      <ol className="space-y-3">
        {view?.messages.map((message) => {
          const bot = bots.get(message.authorId)
          return (
            <li key={message.id} data-exchange-message={message.id} className="flex min-w-0 items-start gap-2">
              <span aria-hidden="true" className="w-6 shrink-0 pt-0.5">{bot && <BotAvatar bot={bot} size={24} />}</span>
              <div className="min-w-0 max-w-full">
                <div className="mb-1 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-3">
                  <bdi className="font-semibold text-fg">{bot?.name ?? 'Deleted bot'}</bdi>
                  <ArrowRight aria-hidden="true" size={12} /><span className="sr-only">to </span><bdi>{bots.get(message.recipientId)?.name ?? 'Deleted bot'}</bdi>
                  <time dateTime={new Date(message.createdAt).toISOString()} title={formatFull(message.createdAt)}>{formatTime(message.createdAt)}</time>
                </div>
                <div dir="auto" className="selectable max-w-full break-words rounded-xl rounded-tl-sm bg-sunken px-3 py-2 text-[13px] text-fg">
                  <Markdown text={message.text} streaming={message.isStreaming} />
                </div>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
