// UI state: where you are, which panes and dialogs are open, drafts and toasts.

import { create } from 'zustand'
import type { Id } from '@shared/domain'

export type Route = { kind: 'conversation'; id: Id } | { kind: 'project'; id: Id } | { kind: 'new-chat' } | { kind: 'home' }

export type DetailsTab = 'profile' | 'memory' | 'skills' | 'routines' | 'tools' | 'connectors'

export type SettingsSection = 'general' | 'providers' | 'connectors' | 'permissions' | 'background' | 'usage' | 'appearance' | 'workspace' | 'about'

export interface Draft {
  text: string
  attachmentPaths: string[]
  replyToId?: Id
}

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'error' | 'success'
}

export interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export interface UiState {
  route: Route
  back: Route[]
  forward: Route[]
  detailsOpen: boolean
  detailsTab: DetailsTab
  /** In a group: the member whose profile is open in the details pane. */
  detailsBotId: Id | null
  settingsSection: SettingsSection | null
  paletteOpen: boolean
  findOpen: boolean
  newBotOpen: boolean
  newProjectOpen: boolean
  compactSidebar: boolean
  avatarEditorBotId: Id | null
  drafts: Record<string, Draft>
  toasts: Toast[]
  confirm: ConfirmRequest | null
  /** Bumped to ask a component to take focus. */
  focusComposer: number
  focusSearch: number
}

const STORAGE_KEY = 'faibots.ui.v1'

interface Persisted {
  drafts: Record<string, Draft>
  compactSidebar: boolean
  detailsOpen: boolean
  lastConversationId?: Id
}

function loadPersisted(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Partial<Persisted>) : {}
  } catch {
    return {}
  }
}

const persisted = loadPersisted()
export const lastConversationId = persisted.lastConversationId

export const useUi = create<UiState>()(() => ({
  route: { kind: 'home' },
  back: [],
  forward: [],
  detailsOpen: persisted.detailsOpen ?? true,
  detailsTab: 'profile',
  detailsBotId: null,
  settingsSection: null,
  paletteOpen: false,
  findOpen: false,
  newBotOpen: false,
  newProjectOpen: false,
  compactSidebar: persisted.compactSidebar ?? false,
  avatarEditorBotId: null,
  drafts: persisted.drafts ?? {},
  toasts: [],
  confirm: null,
  focusComposer: 0,
  focusSearch: 0
}))

let saveTimer: ReturnType<typeof setTimeout> | undefined
useUi.subscribe((s) => {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const data: Persisted = {
      drafts: s.drafts,
      compactSidebar: s.compactSidebar,
      detailsOpen: s.detailsOpen,
      lastConversationId: s.route.kind === 'conversation' ? s.route.id : undefined
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      // Storage full or blocked: drafts just won't survive a restart.
    }
  }, 300)
})

const sameRoute = (a: Route, b: Route) => {
  if (a.kind !== b.kind) return false
  if (a.kind === 'conversation' || a.kind === 'project') return b.kind === a.kind && a.id === b.id
  return true
}

export function navigate(route: Route): void {
  useUi.setState((s) => {
    if (sameRoute(s.route, route)) return {}
    return {
      route,
      back: [...s.back.slice(-49), s.route],
      forward: [],
      findOpen: false,
      detailsBotId: null
    }
  })
}

export function goBack(): void {
  useUi.setState((s) => {
    const prev = s.back[s.back.length - 1]
    if (!prev) return {}
    return { route: prev, back: s.back.slice(0, -1), forward: [s.route, ...s.forward], findOpen: false, detailsBotId: null }
  })
}

export function goForward(): void {
  useUi.setState((s) => {
    const next = s.forward[0]
    if (!next) return {}
    return { route: next, back: [...s.back, s.route], forward: s.forward.slice(1), findOpen: false, detailsBotId: null }
  })
}

export function openDetails(tab?: DetailsTab, botId?: Id | null): void {
  useUi.setState((s) => ({
    detailsOpen: true,
    detailsTab: tab ?? s.detailsTab,
    detailsBotId: botId === undefined ? s.detailsBotId : botId
  }))
}

export function setDraft(key: string, draft: Draft): void {
  useUi.setState((s) => {
    const drafts = { ...s.drafts }
    if (!draft.text && draft.attachmentPaths.length === 0 && !draft.replyToId) delete drafts[key]
    else drafts[key] = draft
    return { drafts }
  })
}

let toastId = 0
export function toast(message: string, tone: Toast['tone'] = 'info'): void {
  const id = ++toastId
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, tone }] }))
  setTimeout(() => dismissToast(id), tone === 'error' ? 6000 : 3500)
}

export function dismissToast(id: number): void {
  useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function confirmDialog(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    useUi.setState({
      confirm: {
        ...req,
        resolve: (ok) => {
          useUi.setState({ confirm: null })
          resolve(ok)
        }
      }
    })
  })
}
