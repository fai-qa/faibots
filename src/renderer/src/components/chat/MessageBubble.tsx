import clsx from 'clsx'
import { CircleAlert, Copy, CornerUpLeft, FileText, Image as ImageIcon, RotateCcw } from 'lucide-react'
import type { Conversation, Entry } from '@shared/domain'
import { useData } from '../../store/data'
import { setDraft, useUi } from '../../store/ui'
import { resend } from '../../store/actions'
import { formatBytes, formatFull, plainPreview } from '../../lib/format'
import { Markdown } from './Markdown'

export function AttachmentChips({ entry, onInk }: { entry: Entry; onInk?: boolean }) {
  if (!entry.attachments.length) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {entry.attachments.map((a) => {
        const Icon = a.mimeType.startsWith('image/') ? ImageIcon : FileText
        return (
          <span
            key={a.id}
            title={a.path}
            className={clsx(
              'inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-lg px-2 text-[12px]',
              onInk ? 'bg-white/14 text-inherit' : 'border border-line bg-pane text-fg-2'
            )}
          >
            <Icon size={13} className="shrink-0 opacity-70" />
            <span className="truncate">{a.name}</span>
            {a.sizeBytes > 0 && <span className="shrink-0 opacity-60">{formatBytes(a.sizeBytes)}</span>}
          </span>
        )
      })}
    </div>
  )
}

function ReplyQuote({ entry }: { entry: Entry }) {
  const target = useData((s) => (entry.replyToId ? s.entries[entry.conversationId]?.find((e) => e.id === entry.replyToId) : undefined))
  const author = useData((s) => (target?.author.kind === 'bot' ? s.botMap.get(target.author.botId) : undefined))
  if (!entry.replyToId) return null
  const name = target ? (target.author.kind === 'user' ? 'You' : (author?.name ?? 'Bot')) : 'an earlier message'
  return (
    <button
      type="button"
      onClick={() => document.getElementById(`entry-${entry.replyToId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
      className="mb-1 flex max-w-full items-center gap-1 text-[12px] text-fg-3 hover:text-fg-2"
      aria-label="Jump to replied message"
    >
      <CornerUpLeft size={12} className="shrink-0" />
      <span className="truncate">
        Replying to <span className="font-medium">{name}</span>
        {target && `: ${plainPreview(target.text, 70)}`}
      </span>
    </button>
  )
}

export function MessageBubble({
  entry,
  conv,
  first,
  colored
}: {
  entry: Entry
  conv: Conversation
  first: boolean
  /** Fill the user bubble with the bot colour (Appearance > Accent). */
  colored?: string
}) {
  const failed = useData((s) => (entry.clientNonce ? s.failed[entry.clientNonce] : undefined))
  const isUser = entry.author.kind === 'user'
  const pending = entry.id.startsWith('local-') && !failed
  const empty = entry.isStreaming && !entry.text
  const readOnly = conv.kind === 'exchange'

  const reply = () => {
    const key = conv.id
    const draft = useUi.getState().drafts[key] ?? { text: '', attachmentPaths: [] }
    setDraft(key, { ...draft, replyToId: entry.id })
    useUi.setState((s) => ({ focusComposer: s.focusComposer + 1 }))
  }

  return (
    <div id={`entry-${entry.id}`} className={clsx('group/msg relative flex flex-col', isUser ? 'items-end' : 'items-start')}>
      <ReplyQuote entry={entry} />
      <div
        title={formatFull(entry.createdAt)}
        data-entry-text
        className={clsx(
          'relative max-w-[min(100%,720px)] rounded-[18px] px-3.5 py-2',
          isUser
            ? clsx('rounded-br-[6px] text-on-ink', !first && 'rounded-tr-[6px]', colored ? `${colored} bg-bot text-white` : 'bg-ink', pending && 'opacity-70')
            : clsx('rounded-bl-[6px] bg-bubble-bot text-fg', !first && 'rounded-tl-[6px]')
        )}
      >
        {empty ? (
          <span className="shimmer-text text-chat font-medium">Thinking</span>
        ) : entry.text ? (
          <Markdown text={entry.text} streaming={entry.isStreaming} onInk={isUser} />
        ) : null}
        <AttachmentChips entry={entry} onInk={isUser} />
      </div>
      {pending && <span className="mt-1 text-2xs text-fg-4">Sending…</span>}
      {failed && (
        <span className="mt-1 flex items-center gap-1.5 text-[12px] text-danger-fg" title={failed}>
          <CircleAlert size={13} />
          Failed to send
          <button type="button" onClick={() => resend(entry)} className="flex items-center gap-1 font-medium underline-offset-2 hover:underline">
            <RotateCcw size={12} />
            Resend
          </button>
        </span>
      )}
      {!empty && !pending && (
        <div
          className={clsx(
            'absolute -top-3 z-10 hidden items-center gap-0.5 rounded-lg border border-line bg-elevated p-0.5 shadow-pop group-hover/msg:flex',
            isUser ? 'right-2' : 'left-2'
          )}
          role="toolbar"
          aria-label="Message actions"
        >
          <ActionButton label="Copy" icon={Copy} onClick={() => void navigator.clipboard?.writeText(entry.text)} />
          {!readOnly && <ActionButton label="Reply" icon={CornerUpLeft} onClick={reply} />}
        </div>
      )}
    </div>
  )
}

function ActionButton({ label, icon: Icon, onClick }: { label: string; icon: typeof Copy; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="flex size-6 items-center justify-center rounded-md text-fg-3 hover:bg-hover hover:text-fg">
      <Icon size={13} />
    </button>
  )
}
