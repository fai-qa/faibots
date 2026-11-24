// Compact inline relay in place of the "N messages with …" pill and its modal.
// Question and answer come from the exchange messages, or from the tool call when
// that text is already stored. Nothing here is invented.

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { Bot, ToolCallInfo } from '@shared/domain'
import type { ExchangeMessage, ExchangeSummary } from '@shared/exchange-activity'
import type { SelectionComparison } from '@shared/specialist-work'
import { invoke } from '../../lib/bridge'
import { findBotByRef } from '../../lib/bots'
import { useData } from '../../store/data'
import { BotAvatar } from '../avatar/BotAvatar'
import { Spinner } from '../ui/Badge'
import { Markdown } from './Markdown'
import { useExchangeChanges } from './useExchangeActivity'

/** First sentence, split on a period. The rest wraps; nothing is cut mid-word. */
export function firstSentence(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return ''
  return trimmed.split(/(?<=\.)\s/)[0] || trimmed
}

export function relayPeers(row: ExchangeSummary, bots: Map<string, Bot>, call?: ToolCallInfo): Bot[] {
  const listed = row.botIds.filter((id) => id !== row.callerId).flatMap((id) => {
    const bot = bots.get(id)
    return bot ? [bot] : []
  })
  if (listed.length > 0) return listed
  const input = call?.input as { to?: unknown } | undefined
  const found = findBotByRef(input?.to, [...bots.values()])
  return found ? [found] : []
}

export function peerLabelOf(peers: Bot[]): string {
  if (peers.length === 0) return 'a bot'
  if (peers.length === 1) return peers[0]!.name
  if (peers.length === 2) return `${peers[0]!.name} and ${peers[1]!.name}`
  return `${peers.length} bots`
}

export interface RelayLineCopy {
  authorId: string
  text: string
  selectionReason?: string
  selectionComparison?: SelectionComparison
}

export interface RelayCopy {
  question?: RelayLineCopy
  answer?: RelayLineCopy
}

/** The caller's question and the peer's answer. Messages win over the tool-call text. */
export function relayCopy(messages: ExchangeMessage[], callerId: string, peerIds: string[], call?: ToolCallInfo): RelayCopy {
  const questionMsg = messages.find((message) => message.authorId === callerId && message.text.trim())
  const answerMsg = [...messages].reverse().find((message) => peerIds.includes(message.authorId) && message.text.trim())
  const input = call?.input as { message?: unknown } | undefined
  const asked = typeof input?.message === 'string' ? input.message.trim() : ''
  const question: RelayLineCopy | undefined = questionMsg
    ? { authorId: questionMsg.authorId, text: questionMsg.text, selectionReason: questionMsg.selectionReason, selectionComparison: questionMsg.selectionComparison }
    : asked
      ? { authorId: callerId, text: asked }
      : undefined
  const answer: RelayLineCopy | undefined = answerMsg
    ? { authorId: answerMsg.authorId, text: answerMsg.text, selectionReason: answerMsg.selectionReason, selectionComparison: answerMsg.selectionComparison }
    : call?.resultText?.trim()
      ? { authorId: peerIds[0] ?? callerId, text: call.resultText }
      : undefined
  return { question, answer }
}

/** Close an open relay on Escape. The caller returns focus to the toggle. */
export function relayEscape(event: { key: string; preventDefault(): void; stopPropagation(): void }, open: boolean): boolean {
  if (event.key !== 'Escape' || !open) return false
  event.preventDefault()
  event.stopPropagation()
  return true
}

function selectionHistory(sample: SelectionComparison): string {
  const scope = 'in this chat on the same model and provider'
  if (!sample.count || sample.medianMs === null) return `At selection, there were no earlier matching ${sample.kind} jobs ${scope}.`
  const duration = sample.medianMs < 1000 ? `${sample.medianMs} ms` : `${(sample.medianMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`
  const usage = sample.medianTokens === null ? 'Token use unknown.' : `Median ${sample.medianTokens.toLocaleString()} tokens (${sample.metered} of ${sample.count} measured).`
  const history = sample.count === 20
    ? `the sample covered the 20 most recent ${sample.kind} jobs ${scope}.`
    : `${sample.count} earlier ${sample.kind} ${sample.count === 1 ? 'job' : 'jobs'} in this chat used the same model and provider.`
  return `At selection, ${history} Median turnaround ${duration}. ${usage}`
}

async function readExchange(conversationId: string, row: ExchangeSummary): Promise<ExchangeMessage[]> {
  const collected: ExchangeMessage[] = []
  let before: string | undefined
  for (let page = 0; page < 20; page++) {
    const result = await invoke('conv:exchange-messages', {
      conversationId,
      entryIds: [row.anchorId],
      before,
      limit: 50
    })
    if (page === 0) collected.push(...result.messages)
    else collected.unshift(...result.messages)
    const sawCaller = collected.some((message) => message.authorId === row.callerId && message.text.trim())
    if (!result.before || sawCaller) break
    before = result.before
  }
  return collected
}

export function RelayRow({
  row,
  bots,
  call,
  messages,
  loadMessages,
  reloadToken = 0,
  defaultOpen = false
}: {
  row: ExchangeSummary
  bots: Map<string, Bot>
  call?: ToolCallInfo
  /** Already-loaded messages. When set, the row does not fetch. */
  messages?: ExchangeMessage[]
  loadMessages?: () => Promise<ExchangeMessage[]>
  reloadToken?: number
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [loaded, setLoaded] = useState<ExchangeMessage[] | undefined>(messages)
  const [failed, setFailed] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const regionId = useId()
  const caller = bots.get(row.callerId)
  const peers = relayPeers(row, bots, call)
  const peerIds = peers.map((bot) => bot.id)
  const callerName = caller?.name ?? 'Deleted bot'
  const peersText = peerLabelOf(peers)
  const countLabel = `${row.messageCount} ${row.messageCount === 1 ? 'message' : 'messages'}`
  const withPeers = `${countLabel} with ${peersText}`
  const known = loaded ?? messages ?? []
  const copy = relayCopy(known, row.callerId, peerIds.length ? peerIds : row.botIds.filter((id) => id !== row.callerId), call)
  const sentence = call?.resultText ? firstSentence(call.resultText) : ''
  const summaryTitle = call?.title?.trim() && call.title.trim() !== call.toolName && !call.title.includes('mcp__') ? call.title.trim() : undefined

  useEffect(() => {
    if (messages) setLoaded(messages)
  }, [messages])

  useEffect(() => {
    if (!open || messages || !loadMessages) return
    let alive = true
    setFailed(false)
    loadMessages().then(
      (next) => {
        if (alive) setLoaded(next)
      },
      () => {
        if (alive) setFailed(true)
      }
    )
    return () => {
      alive = false
    }
  }, [open, messages, loadMessages, reloadToken, row.anchorId, row.messageCount])

  const close = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }

  return (
    <div
      className="my-2"
      onKeyDown={(event) => {
        if (relayEscape(event, open)) close()
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        aria-label={open ? `Hide the messages with ${peersText}` : `Open bot conversation: ${withPeers}${row.active ? ', still in progress' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex w-full items-start gap-3 rounded-2xl border border-line-soft bg-sunken px-3 py-2.5 text-left hover:bg-hover"
      >
        <span className="mt-0.5 flex shrink-0 items-center gap-1" aria-hidden="true">
          {caller && <BotAvatar bot={caller} size={24} />}
          <span className="handoff-relay" />
          {peers[0] && <BotAvatar bot={peers[0]} size={24} state={row.active ? 'thinking' : 'idle'} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13px] font-semibold text-fg">
              {callerName}
              <span className="px-1 font-normal text-fg-4">to</span>
              {peersText}
            </span>
            <span className="text-[12px] font-medium text-fg-3">{withPeers}</span>
            {row.active && <Spinner size={12} />}
            {row.attention === 'failed' && <span className="text-[12px] text-danger-fg">Failed</span>}
          </span>
          {!open && (summaryTitle || sentence) && (
            <span className="mt-1 block text-[13px] leading-5 text-fg-2">
              {summaryTitle && <span className="font-medium text-fg-3">{summaryTitle}. </span>}
              {sentence}
            </span>
          )}
        </span>
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-[13px] font-medium text-accent-fg" aria-hidden="true">
          {open ? 'Hide' : 'Show'}
          {open ? <ChevronDown size={16} strokeWidth={2.25} /> : <ChevronRight size={16} strokeWidth={2.25} />}
        </span>
      </button>
      {open && (
        <div id={regionId} role="region" tabIndex={-1} aria-label={`Messages between ${callerName} and ${peersText}`} className="mt-1 rounded-2xl border border-line-soft bg-sunken px-3 py-3 outline-none">
          {row.incompleteHistory && <p className="mb-2 text-[12px] text-fg-3">Some older messages could not be linked to this exchange.</p>}
          {failed && !copy.question && !copy.answer && <p className="text-[12px] text-fg-2">Couldn’t load the conversation.</p>}
          {!failed && loaded === undefined && !copy.question && !copy.answer && <p className="text-[12px] text-fg-3">Loading messages…</p>}
          <ol className="space-y-2">
            {copy.question && <RelayLine from={caller} fromName={callerName} toName={peersText} line={copy.question} />}
            {copy.answer && (
              <RelayLine
                from={peers.find((bot) => bot.id === copy.answer?.authorId) ?? peers[0]}
                fromName={peers.find((bot) => bot.id === copy.answer?.authorId)?.name ?? peersText}
                toName={callerName}
                line={copy.answer}
              />
            )}
          </ol>
        </div>
      )}
    </div>
  )
}

function RelayLine({ from, fromName, toName, line }: { from?: Bot; fromName: string; toName: string; line: RelayLineCopy }) {
  return (
    <li data-relay-line="" className="flex gap-2.5">
      {from && <BotAvatar bot={from} size={22} />}
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-fg-4">
          <span className="font-semibold text-fg">{fromName}</span>
          <span className="px-1">to</span>
          {toName}
        </p>
        <div className="mt-1 text-[13px] leading-5 text-fg">
          <Markdown text={line.text} className="!text-[13px] !leading-5" />
        </div>
        {(line.selectionReason || line.selectionComparison) && (
          <div className="selectable mt-1.5 max-w-prose break-words text-[12px] text-fg-3">
            <span className="font-semibold">Why {toName} was chosen</span>
            {line.selectionReason && <p className="whitespace-pre-wrap">{line.selectionReason}</p>}
            {line.selectionComparison && <p>{selectionHistory(line.selectionComparison)}</p>}
          </div>
        )}
      </div>
    </li>
  )
}

export function ExchangeActivity({ conversationId, rows }: { conversationId: string; rows: ExchangeSummary[] }) {
  const bots = useData((state) => state.botMap)
  const entries = useData((state) => state.entries[conversationId])
  const version = useExchangeChanges(conversationId, rows.length > 0, true)
  return (
    <>
      {rows.map((row) => (
        <RelayRow
          key={row.anchorId}
          row={row}
          bots={bots}
          call={entries?.find((entry) => entry.id === row.anchorId)?.toolCall}
          loadMessages={() => readExchange(conversationId, row)}
          reloadToken={version}
        />
      ))}
    </>
  )
}
