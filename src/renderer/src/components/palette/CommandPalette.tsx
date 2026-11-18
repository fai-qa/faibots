// mod+K "Jump to": chats, groups, actions and settings sections.

import clsx from 'clsx'
import { MessageSquarePlus, PanelLeft, PanelRight, Plus, Search, Settings, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useData } from '../../store/data'
import { navigate, useUi } from '../../store/ui'
import { openBot } from '../../store/actions'
import { conversationTitle, membersOf } from '../../lib/bots'
import { modKey } from '../../lib/format'
import { BotAvatar, GroupAvatar } from '../avatar/BotAvatar'
import { Kbd } from '../ui/Badge'
import { useFocusTrap } from '../ui/Dialog'
import { SETTINGS_SECTIONS } from '../settings/SettingsOverlay'
import { createPortal } from 'react-dom'

interface Item {
  id: string
  group: 'Bots' | 'Groups' | 'Actions' | 'Settings'
  label: string
  hint?: string
  keywords?: string
  icon?: LucideIcon
  render?: React.ReactNode
  run: () => void
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  if (!open) return null
  return <Palette />
}

function Palette() {
  const bots = useData((s) => s.bots)
  const conversations = useData((s) => s.conversations)
  const botMap = useData((s) => s.botMap)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const close = () => useUi.setState({ paletteOpen: false })
  useFocusTrap(ref, close)

  const items = useMemo<Item[]>(() => {
    const list: Item[] = []
    for (const b of [...bots].sort((a, c) => Number(a.hidden) - Number(c.hidden) || a.name.localeCompare(c.name))) {
      list.push({
        id: `bot:${b.id}`,
        group: 'Bots',
        label: `Chat with ${b.name}`,
        hint: b.hidden ? 'Hidden' : b.label,
        keywords: `${b.handle} ${b.label}`,
        render: <BotAvatar bot={b} size={20} />,
        run: () => void openBot(b.id)
      })
    }
    for (const c of conversations.filter((x) => x.kind === 'group')) {
      list.push({
        id: `group:${c.id}`,
        group: 'Groups',
        label: conversationTitle(c, botMap),
        hint: 'Group',
        render: <GroupAvatar bots={membersOf(c, botMap)} size={20} />,
        run: () => navigate({ kind: 'conversation', id: c.id })
      })
    }
    list.push(
      { id: 'a:new-chat', group: 'Actions', label: 'Start a chat', hint: `${modKey}⇧N`, icon: MessageSquarePlus, keywords: 'new group', run: () => navigate({ kind: 'new-chat' }) },
      { id: 'a:new-bot', group: 'Actions', label: 'New Bot', hint: `${modKey}N`, icon: Plus, keywords: 'create', run: () => useUi.setState({ newBotOpen: true }) },
      {
        id: 'a:details',
        group: 'Actions',
        label: 'Toggle details',
        hint: `${modKey}⌥B`,
        icon: PanelRight,
        run: () => useUi.setState((s) => ({ detailsOpen: !s.detailsOpen }))
      },
      {
        id: 'a:sidebar',
        group: 'Actions',
        label: 'Toggle compact sidebar',
        hint: `${modKey}B`,
        icon: PanelLeft,
        run: () => useUi.setState((s) => ({ compactSidebar: !s.compactSidebar }))
      }
    )
    for (const s of SETTINGS_SECTIONS) {
      list.push({ id: `s:${s.id}`, group: 'Settings', label: `Settings: ${s.label}`, icon: s.icon ?? Settings, keywords: s.description, run: () => useUi.setState({ settingsSection: s.id }) })
    }
    return list
  }, [bots, conversations, botMap])

  const q = query.trim().toLowerCase()
  const shown = q ? items.filter((i) => `${i.label} ${i.keywords ?? ''} ${i.hint ?? ''}`.toLowerCase().includes(q)) : items
  useEffect(() => setActive(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const runItem = (item: Item | undefined) => {
    if (!item) return
    close()
    item.run()
  }

  let lastGroup = ''
  return createPortal(
    <div className="fade-in fixed inset-0 z-50 flex justify-center bg-scrim/60 pt-[14vh]" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Jump to" className="pop-in flex h-fit max-h-[60vh] w-[min(580px,92vw)] flex-col overflow-hidden rounded-2xl bg-elevated shadow-modal">
        <div className="flex items-center gap-2.5 border-b border-line-soft px-4">
          <Search size={16} className="shrink-0 text-fg-3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, shown.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runItem(shown[active])
              }
            }}
            placeholder="Jump to a bot, group or setting"
            aria-label="Jump to"
            className="h-12 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-4"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} className="scroll-y min-h-0 flex-1 p-1.5" role="listbox">
          {shown.length === 0 && <p className="px-3 py-6 text-center text-[12.5px] text-fg-3">No matches for “{query}”</p>}
          {shown.map((item, i) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pb-1 pt-2.5 text-[12px] font-semibold text-fg-3">{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onClick={() => runItem(item)}
                  onMouseMove={() => setActive(i)}
                  className={clsx('flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left', i === active && 'bg-hover')}
                >
                  {item.render ?? (item.icon && <item.icon size={16} className="text-fg-3" />)}
                  <span className="min-w-0 flex-1 truncate text-ui text-fg">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-[12px] text-fg-4">{item.hint}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
