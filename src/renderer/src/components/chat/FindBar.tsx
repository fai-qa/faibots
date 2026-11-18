// Find in chat (mod+F). Marks matches with the CSS Custom Highlight API, so the
// transcript's DOM is never rewritten.

import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useData } from '../../store/data'
import { useUi } from '../../store/ui'
import { useDebounced } from '../../lib/hooks'
import { IconButton } from '../ui/Button'

const supported = typeof CSS !== 'undefined' && 'highlights' in CSS

function findRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  const needle = query.toLowerCase()
  for (const block of root.querySelectorAll<HTMLElement>('[data-entry-text]')) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? '').toLowerCase()
      let from = text.indexOf(needle)
      while (from !== -1) {
        const range = new Range()
        range.setStart(node, from)
        range.setEnd(node, from + needle.length)
        ranges.push(range)
        from = text.indexOf(needle, from + needle.length)
      }
    }
  }
  return ranges
}

export function FindBar({ scrollRef, conversationId }: { scrollRef: RefObject<HTMLDivElement | null>; conversationId: string }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const debounced = useDebounced(query.trim(), 120)
  const entries = useData((s) => s.entries[conversationId])
  const inputRef = useRef<HTMLInputElement>(null)
  const scrolledTo = useRef('')

  useEffect(() => inputRef.current?.focus(), [])

  const [ranges, setRanges] = useState<Range[]>([])

  // After each render of new entries, search the DOM as it now is. Newest match first.
  useEffect(() => {
    const root = scrollRef.current
    const next = root && debounced.length >= 2 ? findRanges(root, debounced) : []
    setRanges(next)
    setIndex((i) => (next.length ? Math.min(i, next.length - 1) : 0))
  }, [debounced, entries, scrollRef])

  useEffect(() => {
    setIndex(Number.MAX_SAFE_INTEGER)
  }, [debounced])

  useEffect(() => {
    if (!supported) return
    const at = Math.min(index, ranges.length - 1)
    const current = ranges[at]
    CSS.highlights.set('find-match', new Highlight(...ranges.filter((_, i) => i !== at)))
    if (current) {
      CSS.highlights.set('find-current', new Highlight(current))
      // Only move the view when you step or change the query, not when new entries stream in.
      const key = `${debounced}:${at}`
      if (scrolledTo.current !== key) {
        scrolledTo.current = key
        current.startContainer.parentElement?.scrollIntoView({ block: 'center' })
      }
    } else CSS.highlights.delete('find-current')
  }, [ranges, index, debounced])

  useEffect(
    () => () => {
      if (!supported) return
      CSS.highlights.delete('find-match')
      CSS.highlights.delete('find-current')
    },
    []
  )

  const close = () => useUi.setState({ findOpen: false })
  const step = (dir: 1 | -1) => {
    if (!ranges.length) return
    setIndex((i) => (Math.min(i, ranges.length - 1) + dir + ranges.length) % ranges.length)
  }

  return (
    <div className="pop-in absolute right-4 top-2 z-20 flex items-center gap-1 rounded-xl border border-line bg-elevated py-1 pl-3 pr-1 shadow-pop">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            step(e.shiftKey ? 1 : -1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
        placeholder="Find in chat"
        aria-label="Find in chat"
        className="w-48 bg-transparent text-ui text-fg outline-none placeholder:text-fg-4"
      />
      <span className="min-w-[64px] text-right text-2xs text-fg-3">
        {debounced.length >= 2 ? (ranges.length ? `${Math.min(index, ranges.length - 1) + 1} of ${ranges.length}` : 'No results') : ''}
      </span>
      <IconButton icon={ChevronUp} label="Previous match" size="sm" onClick={() => step(-1)} disabled={!ranges.length} />
      <IconButton icon={ChevronDown} label="Next match" size="sm" onClick={() => step(1)} disabled={!ranges.length} />
      <IconButton icon={X} label="Close find" size="sm" onClick={close} />
    </div>
  )
}
