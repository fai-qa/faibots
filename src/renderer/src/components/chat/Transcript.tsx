import { ArrowDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { Author, Conversation, Entry } from '@shared/domain'
import { useData } from '../../store/data'
import { loadEntries, loadOlder } from '../../store/actions'
import { dayLabel, sameDay } from '../../lib/format'
import { Spinner } from '../ui/Badge'
import { AuthorRun } from './AuthorRun'
import { EventLine } from './EventLine'

type Block =
  | { type: 'day'; key: string; label: string }
  | { type: 'event'; key: string; entry: Entry }
  | { type: 'run'; key: string; author: Author; entries: Entry[] }

const RUN_GAP_MS = 10 * 60_000

const authorKey = (a: Author) => (a.kind === 'bot' ? `bot:${a.botId}` : a.kind)

function isEventLike(e: Entry): boolean {
  return e.kind === 'event' || e.author.kind === 'system' || (e.kind === 'tool-call' && e.toolCall?.toolName === 'pass_turn')
}

function buildBlocks(entries: Entry[]): Block[] {
  const blocks: Block[] = []
  let run: Extract<Block, { type: 'run' }> | null = null
  let prev: Entry | undefined
  for (const e of entries) {
    if (!prev || !sameDay(prev.createdAt, e.createdAt)) {
      blocks.push({ type: 'day', key: `day-${e.id}`, label: dayLabel(e.createdAt) })
      run = null
    }
    if (isEventLike(e)) {
      blocks.push({ type: 'event', key: e.id, entry: e })
      run = null
    } else {
      const lastInRun = run?.entries[run.entries.length - 1]
      if (run && lastInRun && authorKey(run.author) === authorKey(e.author) && e.createdAt - lastInRun.createdAt < RUN_GAP_MS) {
        run.entries.push(e)
      } else {
        run = { type: 'run', key: `run-${e.id}`, author: e.author, entries: [e] }
        blocks.push(run)
      }
    }
    prev = e
  }
  return blocks
}

export function Transcript({ conv, scrollRef, empty }: { conv: Conversation; scrollRef: RefObject<HTMLDivElement | null>; empty: React.ReactNode }) {
  const entries = useData((s) => s.entries[conv.id])
  const loadError = useData((s) => s.loadErrors[conv.id])
  const hasMore = useData((s) => s.hasMore[conv.id] ?? false)
  const blocks = useMemo(() => buildBlocks(entries ?? []), [entries])
  const atBottom = useRef(true)
  const prevHeight = useRef<number | null>(null)
  const lastCount = useRef(0)
  const [newCount, setNewCount] = useState(0)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // Jump to the end when a conversation opens.
  useLayoutEffect(() => {
    atBottom.current = true
    lastCount.current = 0
    setNewCount(0)
  }, [conv.id])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !entries) return
    if (prevHeight.current !== null) {
      // Older entries were prepended: keep the view where it was.
      el.scrollTop += el.scrollHeight - prevHeight.current
      prevHeight.current = null
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight
    } else if (entries.length > lastCount.current && lastCount.current > 0) {
      setNewCount((n) => n + (entries.length - lastCount.current))
    }
    lastCount.current = entries.length
  }, [entries, scrollRef])

  // Keep pinned to the bottom while content grows (streaming, images, expanding rows).
  useEffect(() => {
    const el = scrollRef.current
    const inner = el?.firstElementChild
    if (!el || !inner) return
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [scrollRef, conv.id])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (atBottom.current && newCount) setNewCount(0)
  }

  const showEarlier = async () => {
    const el = scrollRef.current
    if (el) prevHeight.current = el.scrollHeight
    setLoadingOlder(true)
    await loadOlder(conv.id)
    setLoadingOlder(false)
  }

  const scrollToEnd = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setNewCount(0)
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={onScroll} className="scroll-y h-full" data-transcript>
        <div className="mx-auto flex min-h-full max-w-[820px] flex-col justify-end px-5 pb-2 pt-6">
          {!entries && loadError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[13px] text-fg-3">
              <p>Couldn't load this chat: {loadError}</p>
              <button
                type="button"
                className="rounded-lg border border-line px-3 py-1 text-[12.5px] text-fg hover:bg-hover"
                onClick={() => void loadEntries(conv.id)}
              >
                Try again
              </button>
            </div>
          ) : !entries ? (
            <div className="flex flex-1 items-center justify-center text-fg-3">
              <Spinner size={16} />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-1 items-center justify-center">{empty}</div>
          ) : (
            <>
              {hasMore && (
                <div className="flex justify-center pb-3">
                  <button
                    type="button"
                    onClick={() => void showEarlier()}
                    className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] font-medium text-fg-2 hover:bg-hover"
                  >
                    {loadingOlder && <Spinner size={12} />}
                    Show earlier
                  </button>
                </div>
              )}
              {blocks.map((b) =>
                b.type === 'day' ? (
                  <div key={b.key} className="flex items-center gap-3 py-3" role="separator">
                    <span className="h-px flex-1 bg-line-soft" />
                    <span className="text-2xs font-medium text-fg-3">{b.label}</span>
                    <span className="h-px flex-1 bg-line-soft" />
                  </div>
                ) : b.type === 'event' ? (
                  <EventLine key={b.key} entry={b.entry} />
                ) : (
                  <AuthorRun key={b.key} author={b.author} entries={b.entries} conv={conv} />
                )
              )}
            </>
          )}
        </div>
      </div>
      {newCount > 0 && (
        <button
          type="button"
          onClick={scrollToEnd}
          className="pop-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-on-ink shadow-pop"
        >
          <ArrowDown size={13} />
          {newCount === 1 ? '1 new message' : `${newCount} new messages`}
        </button>
      )}
    </div>
  )
}
