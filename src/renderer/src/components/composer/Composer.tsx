// Message box: Enter sends, Shift+Enter adds a line, @ opens the mention menu,
// files attach through the native picker. Drafts are kept per conversation.

import clsx from 'clsx'
import { ArrowUp, AtSign, CornerUpLeft, FileText, Paperclip, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Bot, Id } from '@shared/domain'
import { invoke } from '../../lib/bridge'
import { basename, plainPreview } from '../../lib/format'
import { useData } from '../../store/data'
import { reportError } from '../../store/actions'
import { setDraft, toast, useUi, type Draft } from '../../store/ui'
import { modelSetupIssue } from '../../lib/providers'
import { ModelSetupPrompt } from '../details/ModelPicker'
import { MentionMenu, mentionOptions, type MentionOption } from './MentionMenu'

const MAX_ATTACHMENTS = 6
const EMPTY: Draft = { text: '', attachmentPaths: [] }

interface ComposerProps {
  draftKey: string
  placeholder: string
  members: Bot[]
  allowEveryone: boolean
  /** A bot is working: show Stop next to Send. */
  busy?: boolean
  onSend: (draft: Draft) => void | Promise<void>
  onStop?: () => void
  /** For the reply chip. */
  conversationId?: Id
  disabled?: boolean
  autoFocus?: boolean
}

export function Composer({ draftKey, placeholder, members, allowEveryone, busy, onSend, onStop, conversationId, disabled, autoFocus = true }: ComposerProps) {
  const draft = useUi((s) => s.drafts[draftKey]) ?? EMPTY
  const providers = useData((s) => s.providers)
  const directBot = members.length === 1 ? members[0] : undefined
  const setup = directBot && modelSetupIssue(directBot.model, providers)
  const focusTick = useUi((s) => s.focusComposer)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const options = mention ? mentionOptions(mention.query, members, allowEveryone) : []

  const replyTarget = useData((s) => (draft.replyToId && conversationId ? s.entries[conversationId]?.find((e) => e.id === draft.replyToId) : undefined))
  const replyAuthor = useData((s) => (replyTarget?.author.kind === 'bot' ? s.botMap.get(replyTarget.author.botId)?.name : undefined))

  const update = (patch: Partial<Draft>) => setDraft(draftKey, { ...draft, ...patch })

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
    setMention(null)
  }, [draftKey, autoFocus])

  useEffect(() => {
    if (focusTick) ref.current?.focus()
  }, [focusTick])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`
  }, [draft.text])

  const detectMention = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const m = /(?:^|\s)@([\w-]*)$/.exec(before)
    if (m && members.length) {
      setMention({ query: m[1] ?? '', start: caret - (m[1]?.length ?? 0) - 1 })
      setActive(0)
    } else setMention(null)
  }

  const pick = (o: MentionOption) => {
    const el = ref.current
    if (!el || !mention) return
    const token = o.kind === 'everyone' ? '@everyone ' : `@${o.bot.handle} `
    const caret = el.selectionStart
    const text = draft.text.slice(0, mention.start) + token + draft.text.slice(caret)
    update({ text })
    setMention(null)
    const pos = mention.start + token.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const send = () => {
    if (disabled || setup) return
    if (!draft.text.trim() && draft.attachmentPaths.length === 0) return
    const toSend = draft
    setDraft(draftKey, EMPTY)
    setMention(null)
    void onSend(toSend)
  }

  const attach = async () => {
    try {
      const paths = await invoke('dialog:open-files', { title: 'Attach files' })
      if (!paths.length) return
      const merged = [...new Set([...draft.attachmentPaths, ...paths])]
      if (merged.length > MAX_ATTACHMENTS) toast(`Only ${MAX_ATTACHMENTS} attachments allowed in one message`, 'error')
      update({ attachmentPaths: merged.slice(0, MAX_ATTACHMENTS) })
      ref.current?.focus()
    } catch (err) {
      reportError(err, "Couldn't attach files.")
    }
  }

  const insertAt = () => {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart
    const needsSpace = caret > 0 && !/\s/.test(draft.text[caret - 1] ?? '')
    const insert = `${needsSpace ? ' ' : ''}@`
    const text = draft.text.slice(0, caret) + insert + draft.text.slice(caret)
    update({ text })
    const pos = caret + insert.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
      detectMention(text, pos)
    })
  }

  const canSend = !disabled && !setup && (draft.text.trim().length > 0 || draft.attachmentPaths.length > 0)

  return (
    <div className="mx-auto w-full max-w-[820px] px-5 pb-4">
      {setup && directBot && (
        <div className="mb-2">
          <ModelSetupPrompt key={directBot.id} bot={directBot} issue={setup} />
        </div>
      )}
      <div
        className={clsx(
          'relative rounded-card border border-line-strong bg-pane shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition-[border-color,box-shadow] duration-150 focus-within:border-fg-4 focus-within:shadow-[0_2px_10px_-4px_rgb(0_0_0/0.12)]',
          disabled && 'opacity-60'
        )}
      >
        {mention && <MentionMenu options={options} active={active} onPick={pick} onHover={setActive} />}

        {draft.replyToId && (
          <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2 text-[12.5px] text-fg-3">
            <CornerUpLeft size={13} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Replying to <span className="font-medium text-fg-2">{replyTarget ? (replyTarget.author.kind === 'user' ? 'yourself' : (replyAuthor ?? 'Bot')) : 'a message'}</span>
              {replyTarget && `: ${plainPreview(replyTarget.text, 80)}`}
            </span>
            <button type="button" aria-label="Cancel reply" title="Cancel reply" onClick={() => update({ replyToId: undefined })} className="rounded-inner p-0.5 text-fg-3 transition-colors duration-150 hover:bg-hover hover:text-fg">
              <X size={14} />
            </button>
          </div>
        )}

        {draft.attachmentPaths.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {draft.attachmentPaths.map((p) => (
              <span key={p} title={p} className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-control border border-line bg-sunken pl-2 pr-1 text-[12px] text-fg-2">
                <FileText size={13} className="shrink-0 text-fg-3" />
                <span className="truncate">{basename(p)}</span>
                <button
                  type="button"
                  aria-label={`Remove ${basename(p)}`}
                  onClick={() => update({ attachmentPaths: draft.attachmentPaths.filter((x) => x !== p) })}
                  className="flex size-5 items-center justify-center rounded-inner text-fg-3 transition-colors duration-150 hover:bg-hover hover:text-fg"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          rows={1}
          value={draft.text}
          disabled={disabled}
          placeholder={draft.attachmentPaths.length ? 'Add a message, or hit send' : placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            update({ text: e.target.value })
            detectMention(e.target.value, e.target.selectionStart)
          }}
          onClick={(e) => detectMention(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (mention && options.length) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => (i + 1) % options.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => (i - 1 + options.length) % options.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                const o = options[active]
                if (o) pick(o)
                return
              }
            }
            if (e.key === 'Escape') {
              if (mention) {
                e.preventDefault()
                setMention(null)
              } else if (draft.replyToId) {
                e.preventDefault()
                update({ replyToId: undefined })
              }
              return
            }
            if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
          className="scroll-y block max-h-[40vh] w-full resize-none bg-transparent px-4 pb-1 pt-3 text-chat text-fg outline-none placeholder:text-fg-4"
        />

        <div className="flex items-center gap-0.5 px-2 pb-2">
          <ToolbarButton label="Attach files" onClick={() => void attach()} disabled={disabled}>
            <Paperclip size={16} />
          </ToolbarButton>
          {members.length > 0 && (
            <ToolbarButton label="Mention a bot" onClick={insertAt} disabled={disabled}>
              <AtSign size={16} />
            </ToolbarButton>
          )}
          <span className="flex-1" />
          {!setup && <span className="mr-2 hidden text-2xs text-fg-4 lg:inline">Enter to send, Shift+Enter for a new line</span>}
          {busy && onStop && (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop every bot in this chat"
              className="mr-1 flex h-9 items-center gap-1.5 rounded-pill border border-line-strong px-3 text-[12.5px] font-medium text-fg transition-[background-color,translate] duration-150 hover:-translate-y-px hover:bg-hover active:translate-y-0"
            >
              <Square size={11} className="fill-current" />
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Send message"
            title="Send message"
            className="flex size-11 items-center justify-center rounded-pill bg-ink text-on-ink transition-[opacity,translate] duration-150 hover:-translate-y-px hover:opacity-90 active:translate-y-0 disabled:pointer-events-none disabled:opacity-25"
          >
            <ArrowUp size={17} strokeWidth={2.2} />
          </button>
        </div>
      </div>
    </div>
  )
}

function ToolbarButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex size-8 items-center justify-center rounded-pill text-fg-3 transition-[background-color,color,translate] duration-150 hover:-translate-y-px hover:bg-hover hover:text-fg active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}
