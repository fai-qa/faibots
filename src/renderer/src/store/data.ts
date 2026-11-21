// Mirror of backend state, kept fresh by the bridge's push events.

import { create } from 'zustand'
import type {
  AppSettings,
  Bot,
  BotLiveState,
  Conversation,
  Entry,
  Id,
  McpServerConfig,
  McpServerStatus,
  Project,
  ProviderConfig
} from '@shared/domain'
import type { AppInfo, ProviderTestResult } from '@shared/ipc'

export interface McpRow {
  server: McpServerConfig
  status: McpServerStatus
}

export type DisplayLiveState = BotLiveState & { stale?: boolean }
export const LIVE_STATUS_MAX_AGE_MS = 60_000

export function lastActivityLabel(state: DisplayLiveState): string {
  const time = new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `Status unknown · last reported ${state.activity || state.phase} at ${time}`
}

export interface DataState {
  status: 'loading' | 'ready' | 'error'
  bootError?: string
  appInfo?: AppInfo
  settings: AppSettings | null
  bots: Bot[]
  botMap: Map<Id, Bot>
  conversations: Conversation[]
  /** Loaded transcript per conversation, oldest first. Missing = not loaded yet. */
  entries: Record<Id, Entry[]>
  hasMore: Record<Id, boolean>
  /** Why a transcript could not be loaded (cleared when a load succeeds). */
  loadErrors: Record<Id, string>
  /** Newest known entry per conversation, for sidebar previews. */
  lastEntry: Record<Id, Entry>
  /** clientNonce → error for user messages that failed to send. */
  failed: Record<string, string>
  /** `${conversationId}:${botId}` → live state (idle states are removed). */
  live: Record<string, DisplayLiveState>
  providers: ProviderConfig[]
  providerTests: Record<Id, ProviderTestResult>
  mcp: McpRow[]
  /** Journey (M1b/M1c): record-only projects, loaded at boot. */
  projects: Project[]
  /** Bumped by push events so panels know to refetch. */
  versions: { skills: number; mcp: number; memory: Record<Id, number>; routines: Record<Id, number>; journey: Record<Id, number> }
}

export const useData = create<DataState>()(() => ({
  status: 'loading',
  settings: null,
  bots: [],
  botMap: new Map(),
  conversations: [],
  entries: {},
  hasMore: {},
  loadErrors: {},
  lastEntry: {},
  failed: {},
  live: {},
  providers: [],
  providerTests: {},
  mcp: [],
  projects: [],
  versions: { skills: 0, mcp: 0, memory: {}, routines: {}, journey: {} }
}))

export const liveKey = (conversationId: Id, botId: Id) => `${conversationId}:${botId}`

export function setProjects(projects: Project[]): void {
  useData.setState({ projects })
}

export function setBots(bots: Bot[]): void {
  useData.setState({ bots, botMap: new Map(bots.map((b) => [b.id, b])) })
}

export function upsertConversation(conv: Conversation): void {
  useData.setState((s) => {
    const i = s.conversations.findIndex((c) => c.id === conv.id)
    const conversations = i >= 0 ? s.conversations.map((c) => (c.id === conv.id ? conv : c)) : [...s.conversations, conv]
    return { conversations }
  })
}

export function removeConversation(id: Id): void {
  useData.setState((s) => {
    const entries = { ...s.entries }
    delete entries[id]
    const lastEntry = { ...s.lastEntry }
    delete lastEntry[id]
    return { conversations: s.conversations.filter((c) => c.id !== id), entries, lastEntry }
  })
}

function insertSorted(list: Entry[], entry: Entry): Entry[] {
  const next = list.slice()
  let i = next.length
  while (i > 0 && next[i - 1]!.seq > entry.seq) i--
  next.splice(i, 0, entry)
  return next
}

/** Add or replace an entry (matched by id, or by clientNonce for optimistic sends). */
export function upsertEntry(entry: Entry): void {
  useData.setState((s) => {
    const cid = entry.conversationId
    const list = s.entries[cid]
    let entries = s.entries
    if (list) {
      const rest = list.filter((e) => e.id !== entry.id && !(entry.clientNonce && e.clientNonce === entry.clientNonce))
      entries = { ...s.entries, [cid]: insertSorted(rest, entry) }
    }
    const prev = s.lastEntry[cid]
    const lastEntry = !prev || prev.id === entry.id || entry.seq >= prev.seq ? { ...s.lastEntry, [cid]: entry } : s.lastEntry
    return { entries, lastEntry }
  })
}

export function appendDelta(conversationId: Id, entryId: Id, textDelta: string): void {
  useData.setState((s) => {
    const list = s.entries[conversationId]
    const patch: Partial<DataState> = {}
    if (list) {
      const i = list.findIndex((e) => e.id === entryId)
      if (i >= 0) {
        const next = list.slice()
        next[i] = { ...next[i]!, text: next[i]!.text + textDelta }
        patch.entries = { ...s.entries, [conversationId]: next }
      }
    }
    const last = s.lastEntry[conversationId]
    if (last?.id === entryId) patch.lastEntry = { ...s.lastEntry, [conversationId]: { ...last, text: last.text + textDelta } }
    return patch
  })
}

export function setLiveState(state: BotLiveState): void {
  useData.setState((s) => {
    const live = { ...s.live }
    const key = liveKey(state.conversationId, state.botId)
    if (live[key] && live[key]!.updatedAt > state.updatedAt) return s
    if (state.phase === 'idle') delete live[key]
    else live[key] = Date.now() - state.updatedAt >= LIVE_STATUS_MAX_AGE_MS ? { ...state, stale: true } : state
    return { live }
  })
}

export function refreshLiveFreshness(now = Date.now()): void {
  useData.setState((state) => {
    const expired = Object.entries(state.live).filter(([, item]) => !item.stale && now - item.updatedAt >= LIVE_STATUS_MAX_AGE_MS)
    if (!expired.length) return state
    const live = { ...state.live }
    for (const [key, item] of expired) live[key] = { ...item, stale: true }
    return { live }
  })
}

export function liveFor(live: Record<string, DisplayLiveState>, conversationId: Id): DisplayLiveState[] {
  return Object.values(live).filter((s) => s.conversationId === conversationId)
}

/** The most urgent live state of a bot across all conversations. */
export function botStatus(live: Record<string, DisplayLiveState>, botId: Id): DisplayLiveState | undefined {
  let best: DisplayLiveState | undefined
  for (const s of Object.values(live)) {
    if (s.botId !== botId) continue
    if (!best || (best.stale && !s.stale) || (Boolean(best.stale) === Boolean(s.stale) && s.phase === 'waiting')) best = s
  }
  return best
}
