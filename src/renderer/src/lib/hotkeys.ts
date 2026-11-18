// App-wide shortcuts (report 04 §2.4). Matched on KeyboardEvent.code so they work on any
// keyboard layout and with Shift held.

import { useEffect } from 'react'
import { useData } from '../store/data'
import { goBack, goForward, navigate, openDetails, useUi } from '../store/ui'
import { openBot } from '../store/actions'
import { isMac } from './format'
import { sidebarOrder, type SidebarItem } from './sidebar'

function openItem(item: SidebarItem | undefined): void {
  if (!item) return
  if (item.conv) navigate({ kind: 'conversation', id: item.conv.id })
  else if (item.bot) void openBot(item.bot.id)
}

function currentIndex(order: SidebarItem[]): number {
  const route = useUi.getState().route
  if (route.kind !== 'conversation') return -1
  return order.findIndex((i) => i.conv?.id === route.id)
}

export function useGlobalHotkeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey
      const { code, shiftKey: shift, altKey: alt } = e
      const ui = useUi.getState()
      const inConversation = ui.route.kind === 'conversation'

      // Let open dialogs handle their own keys; only the palette shortcut toggles through.
      if (document.querySelector('[aria-modal="true"]')) {
        if (mod && code === 'KeyK' && ui.paletteOpen) {
          e.preventDefault()
          useUi.setState({ paletteOpen: false })
        }
        return
      }

      const act = (fn: () => void) => {
        e.preventDefault()
        fn()
      }

      if (mod && !shift && !alt && code === 'KeyK') return act(() => useUi.setState({ paletteOpen: true }))
      if (mod && shift && code === 'KeyF') return act(() => useUi.setState((s) => ({ focusSearch: s.focusSearch + 1 })))
      if (mod && !shift && code === 'KeyF' && inConversation) return act(() => useUi.setState({ findOpen: true }))
      if (mod && shift && code === 'KeyN') return act(() => navigate({ kind: 'new-chat' }))
      if (mod && !shift && code === 'KeyN') return act(() => useUi.setState({ newBotOpen: true }))
      if (mod && shift && code === 'Comma')
        return act(() => {
          if (ui.detailsOpen && ui.detailsTab === 'profile') useUi.setState({ detailsOpen: false })
          else openDetails('profile')
        })
      if (mod && !shift && code === 'Comma') return act(() => useUi.setState({ settingsSection: 'general' }))
      if (mod && shift && code === 'KeyM') return act(() => useUi.setState({ settingsSection: 'connectors' }))
      if (mod && shift && code === 'KeyW') return act(() => openDetails('skills'))
      if (mod && !shift && code === 'KeyI') return act(() => useUi.setState((s) => ({ focusComposer: s.focusComposer + 1 })))
      if (mod && alt && code === 'KeyB') return act(() => useUi.setState((s) => ({ detailsOpen: !s.detailsOpen })))
      if (mod && !shift && !alt && code === 'KeyB') return act(() => useUi.setState((s) => ({ compactSidebar: !s.compactSidebar })))
      if (mod && code === 'BracketLeft') return act(goBack)
      if (mod && code === 'BracketRight') return act(goForward)

      if (alt && !mod && (code === 'ArrowUp' || code === 'ArrowDown')) {
        const { bots, conversations } = useData.getState()
        const order = sidebarOrder(bots, conversations)
        if (!order.length) return
        const i = currentIndex(order)
        const next = code === 'ArrowUp' ? (i <= 0 ? order.length - 1 : i - 1) : (i + 1) % order.length
        return act(() => openItem(order[next]))
      }

      const digit = /^Digit([1-9])$/.exec(code)
      if (mod && !shift && !alt && digit) {
        const { bots, conversations } = useData.getState()
        const order = sidebarOrder(bots, conversations)
        return act(() => openItem(order[Number(digit[1]) - 1]))
      }

      if (code === 'Escape' && ui.findOpen) return act(() => useUi.setState({ findOpen: false }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
