// A bot's tool call as an affectUI Tool Call Card. send_to_agent stays a small exchange
// card when this entry is still in the transcript (a failed call). The inline relay
// replaces the ordinary "N messages with …" control.

import clsx from 'clsx'
import { CircleX, MessagesSquare } from 'lucide-react'
import type { Entry, ToolCallInfo } from '@shared/domain'
import { useData } from '../../store/data'
import { findBotByRef } from '../../lib/bots'
import { toolIcon, visibleToolLabel } from '../../lib/tools'
import { BotAvatar } from '../avatar/BotAvatar'
import { Spinner } from '../ui/Badge'
import { ToolCallCard, type ToolCallStatus } from '../ui/tool-call-card-clean'

function cardOf(call: ToolCallInfo): { status: ToolCallStatus; summary: string; error?: string } {
  const label = visibleToolLabel(call.toolName, call.title)
  if (call.status === 'running') return { status: 'running', summary: label }
  if (call.status === 'done') return { status: 'success', summary: label }
  if (call.status === 'denied') return { status: 'error', summary: `${label}. Denied`, error: 'Denied' }
  if (call.status === 'cancelled') return { status: 'error', summary: `${label}. Stopped`, error: 'Stopped' }
  return { status: 'error', summary: label, error: call.resultText?.trim() || 'The tool call failed.' }
}

export function ToolCallRow({ entry }: { entry: Entry }) {
  const call = entry.toolCall
  if (!call) return null
  if (call.toolName === 'send_to_agent') return <ExchangeCard entry={entry} call={call} />

  const Icon = toolIcon(call.toolName)
  const { status, summary, error } = cardOf(call)
  const elapsed = entry.updatedAt - entry.createdAt
  const label = visibleToolLabel(call.toolName, call.title)

  return (
    <div className="w-full max-w-[min(100%,620px)]">
      <ToolCallCard
        name={label}
        summary={summary}
        status={status}
        icon={<Icon size={16} strokeWidth={1.6} />}
        args={call.input}
        result={call.resultText}
        error={error}
        startedAt={call.status === 'running' ? entry.createdAt : undefined}
        duration={call.status === 'running' || !Number.isFinite(elapsed) || elapsed < 0 ? undefined : elapsed}
      />
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
  const name = peer?.name ?? (typeof input.to === 'string' && !input.to.startsWith('mcp__') ? input.to.replace(/^@/, '') : 'a bot')
  const title = running ? `Messaging ${name}` : `Messaged ${name}`
  return (
    <div
      className={clsx(
        'block w-full max-w-[min(100%,520px)] rounded-xl border border-line bg-pane px-3 py-2.5 text-left',
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
      </div>
      {typeof input.message === 'string' && <p className="mt-1.5 line-clamp-2 text-[12.5px] text-fg-2">{input.message}</p>}
      {call.resultText && (
        <p className="mt-1.5 line-clamp-2 border-l-2 border-bot pl-2 text-[12.5px] text-fg-3">
          {peer && <span className="font-medium text-bot-fg">{peer.name}: </span>}
          {call.resultText}
        </p>
      )}
    </div>
  )
}
