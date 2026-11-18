// A bot's tool call as a compact row that expands to show input and result.
// send_to_agent calls render as a "Messaged X" card that opens the exchange.

import clsx from 'clsx'
import { Ban, Check, ChevronDown, ChevronRight, CircleX, MessagesSquare } from 'lucide-react'
import { useState } from 'react'
import type { Entry, ToolCallInfo } from '@shared/domain'
import { useData } from '../../store/data'
import { navigate } from '../../store/ui'
import { findBotByRef } from '../../lib/bots'
import { commandOf, parseMcpName, prettyJson, toolIcon, toolTitle } from '../../lib/tools'
import { BotAvatar } from '../avatar/BotAvatar'
import { Spinner } from '../ui/Badge'

function detailOf(call: ToolCallInfo): string | undefined {
  const input = (call.input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  switch (call.toolName) {
    case 'shell':
      return commandOf(call.input)
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'list_dir':
      return str(input.path)
    case 'web_fetch': {
      const url = str(input.url)
      try {
        return url ? new URL(url).host + new URL(url).pathname.replace(/\/$/, '') : undefined
      } catch {
        return url
      }
    }
    case 'update_memory':
      return str(input.content)
    case 'recall_memory':
      return str(input.query)
    case 'skill':
    case 'update_skill':
      return str(input.name)
    default: {
      const mcp = parseMcpName(call.toolName)
      return mcp?.tool
    }
  }
}

function StatusIcon({ status }: { status: ToolCallInfo['status'] }) {
  switch (status) {
    case 'running':
      return <Spinner size={13} className="text-fg-3" />
    case 'done':
      return <Check size={14} className="text-success-fg" aria-label="Done" />
    case 'error':
      return <CircleX size={14} className="text-danger-fg" aria-label="Failed" />
    case 'denied':
      return <Ban size={13} className="text-fg-3" aria-label="Denied" />
    case 'cancelled':
      return <Ban size={13} className="text-fg-4" aria-label="Cancelled" />
  }
}

export function ToolCallRow({ entry }: { entry: Entry }) {
  const call = entry.toolCall
  const [open, setOpen] = useState(false)
  if (!call) return null
  if (call.toolName === 'send_to_agent') return <ExchangeCard entry={entry} call={call} />

  const Icon = toolIcon(call.toolName)
  const detail = detailOf(call)
  const title = call.title || toolTitle(call.toolName)
  const muted = call.status === 'denied' || call.status === 'cancelled'

  return (
    <div className={clsx('max-w-[min(100%,620px)] rounded-[10px] border border-line-soft', open && 'bg-sunken')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[12.5px] hover:bg-hover"
      >
        <Icon size={14} className={clsx('shrink-0', muted ? 'text-fg-4' : 'text-fg-3')} />
        <span className={clsx('shrink-0 font-medium', muted ? 'text-fg-3' : 'text-fg-2')}>{title}</span>
        {detail && <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-fg-3">{detail}</span>}
        {!detail && <span className="flex-1" />}
        {call.status === 'denied' && <span className="text-2xs text-fg-3">Denied</span>}
        {call.status === 'cancelled' && <span className="text-2xs text-fg-4">Stopped</span>}
        <StatusIcon status={call.status} />
        {open ? <ChevronDown size={14} className="text-fg-4" /> : <ChevronRight size={14} className="text-fg-4" />}
      </button>
      {open && (
        <div className="space-y-2 px-2.5 pb-2.5 pt-0.5">
          <div>
            <div className="mb-1 text-2xs font-medium text-fg-3">
              Input <span className="font-mono font-normal text-fg-4">{call.toolName}</span>
            </div>
            <pre className="selectable max-h-48 overflow-auto rounded-lg border border-line-soft bg-pane px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">
              {prettyJson(call.input) || '(none)'}
            </pre>
          </div>
          {call.resultText && (
            <div>
              <div className="mb-1 text-2xs font-medium text-fg-3">Result</div>
              <pre className="selectable max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line-soft bg-pane px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">
                {call.resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ExchangeCard({ entry, call }: { entry: Entry; call: ToolCallInfo }) {
  const bots = useData((s) => s.bots)
  const author = entry.author
  const asker = author.kind === 'bot' ? bots.find((b) => b.id === author.botId) : undefined
  const input = (call.input ?? {}) as { to?: unknown; message?: unknown }
  const peer = findBotByRef(input.to, bots)
  const running = call.status === 'running'
  const name = peer?.name ?? (typeof input.to === 'string' ? input.to.replace(/^@/, '') : 'a bot')
  const title = running ? `Messaging ${name}` : `Messaged ${name}`
  const canOpen = !!call.exchangeConversationId

  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={() => call.exchangeConversationId && navigate({ kind: 'conversation', id: call.exchangeConversationId })}
      aria-label={canOpen ? `Open exchange with ${name}` : title}
      className={clsx(
        'group block w-full max-w-[min(100%,520px)] rounded-xl border border-line bg-pane px-3 py-2.5 text-left transition-colors',
        canOpen && 'hover:border-line-strong hover:bg-hover',
        peer && `bot-${peer.avatar.color}`
      )}
    >
      <div className="flex items-center gap-2">
        <span className="relative flex shrink-0">
          {asker && <BotAvatar bot={asker} size={20} />}
          {peer && <BotAvatar bot={peer} size={20} state={running ? 'thinking' : 'idle'} className="-ml-1.5" />}
          {!asker && !peer && <MessagesSquare size={16} className="text-fg-3" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{title}</span>
        {running ? (
          <Spinner size={13} className="text-fg-3" />
        ) : call.status === 'error' ? (
          <span className="flex items-center gap-1 text-2xs text-danger-fg">
            <CircleX size={13} />
            Failed
          </span>
        ) : call.status === 'cancelled' || call.status === 'denied' ? (
          <span className="text-2xs text-fg-4">{call.status === 'denied' ? 'Denied' : 'Stopped'}</span>
        ) : null}
        {canOpen && (
          <span className="flex items-center gap-0.5 text-2xs font-medium text-fg-3 group-hover:text-fg-2">
            Open exchange
            <ChevronRight size={13} />
          </span>
        )}
      </div>
      {typeof input.message === 'string' && <p className="mt-1.5 line-clamp-2 text-[12.5px] text-fg-2">{input.message}</p>}
      {call.resultText && (
        <p className="mt-1.5 line-clamp-2 border-l-2 border-bot pl-2 text-[12.5px] text-fg-3">
          {peer && <span className="font-medium text-bot-fg">{peer.name}: </span>}
          {call.resultText}
        </p>
      )}
    </button>
  )
}
