// Everything that talks to the backend and updates the stores lives here, so components
// stay small: they read the stores and call these functions.

import type { Bot, Conversation, Entry, GroupSettings, Id, Project, ProjectSource } from '@shared/domain'
import type { InvokeChannel, InvokeMap } from '@shared/ipc'
import { errorMessage, initBridge, invoke, on } from '../lib/bridge'
import { findDm, resolveMentions } from '../lib/bots'
import { basename, nonce } from '../lib/format'
import {
  appendDelta,
  removeConversation,
  setBots,
  setLiveState,
  setProjects,
  upsertConversation,
  upsertEntry,
  useData
} from './data'
import { navigate, toast, useUi, type Draft } from './ui'

// ---------------------------------------------------------------------------
// Boot and push events
// ---------------------------------------------------------------------------

let booted = false

export async function boot(): Promise<void> {
  // StrictMode runs effects twice in development; subscribe to events only once.
  if (booted) return
  booted = true
  try {
    await initBridge()
    subscribeToEvents()
    const [appInfo, settings, bots, conversations, live, providers, mcp, projects] = await Promise.all([
      invoke('app:info', undefined),
      invoke('settings:get', undefined),
      invoke('bots:list', undefined),
      invoke('conv:list', undefined),
      invoke('conv:live-states', undefined),
      invoke('providers:list', undefined),
      invoke('mcp:list', undefined),
      invoke('projects:list', undefined)
    ])
    const primary = bots.find((bot) => bot.isPrimary)
    if (!primary) throw new Error('The main bot fai could not be loaded.')
    const existingDm = findDm(conversations, primary.id)
    const home = existingDm ?? await invoke('conv:open-dm', { botId: primary.id })
    setBots(bots)
    setProjects(projects)
    useData.setState({ appInfo, settings, conversations: existingDm ? conversations : [...conversations, home], providers, mcp })
    useUi.setState({ route: { kind: 'conversation', id: home.id } })
    useData.setState({ status: 'ready' })
    for (const state of live) setLiveState(state)
    void loadPreviews(conversations)
  } catch (err) {
    useData.setState({ status: 'error', bootError: errorMessage(err) })
  }
}

function subscribeToEvents(): void {
  on('conv:entry', ({ entry }) => upsertEntry(entry))
  on('conv:delta', ({ conversationId, entryId, textDelta }) => appendDelta(conversationId, entryId, textDelta))
  on('conv:changed', ({ conversation }) => upsertConversation(conversation))
  on('conv:deleted', ({ conversationId }) => {
    removeConversation(conversationId)
    const route = useUi.getState().route
    if (route.kind === 'conversation' && route.id === conversationId) navigate({ kind: 'home' })
  })
  on('bot:state', ({ state }) => setLiveState(state))
  on('bots:changed', ({ bots }) => setBots(bots))
  on('settings:changed', ({ settings }) => useData.setState({ settings }))
  on('skills:changed', () => bump('skills'))
  on('memory:changed', ({ botId }) =>
    useData.setState((s) => ({
      versions: { ...s.versions, memory: { ...s.versions.memory, [botId]: (s.versions.memory[botId] ?? 0) + 1 } }
    }))
  )
  on('routines:changed', ({ botId }) =>
    useData.setState((s) => ({
      versions: { ...s.versions, routines: { ...s.versions.routines, [botId]: (s.versions.routines[botId] ?? 0) + 1 } }
    }))
  )
  on('journey:changed', ({ projectId }) =>
    useData.setState((s) => ({
      versions: { ...s.versions, journey: { ...s.versions.journey, [projectId]: (s.versions.journey[projectId] ?? 0) + 1 } }
    }))
  )
  on('mcp:changed', () => {
    bump('mcp')
    void refreshMcp()
  })
  on('providers:changed', () => void refreshProviders())
  on('nav:focus-conversation', ({ conversationId }) => navigate({ kind: 'conversation', id: conversationId }))
}

function bump(key: 'skills' | 'mcp'): void {
  useData.setState((s) => ({ versions: { ...s.versions, [key]: s.versions[key] + 1 } }))
}

async function loadPreviews(conversations: Conversation[]): Promise<void> {
  await Promise.all(
    conversations
      .filter((c) => c.kind !== 'exchange')
      .map(async (c) => {
        try {
          const page = await invoke('conv:entries', { conversationId: c.id, limit: 1 })
          const last = page.entries[page.entries.length - 1]
          if (last && !useData.getState().lastEntry[c.id]) {
            useData.setState((s) => ({ lastEntry: { ...s.lastEntry, [c.id]: last } }))
          }
        } catch {
          // A missing preview is harmless.
        }
      })
  )
}

export async function refreshProviders(): Promise<void> {
  try {
    useData.setState({ providers: await invoke('providers:list', undefined) })
  } catch (err) {
    reportError(err)
  }
}

export async function refreshMcp(): Promise<void> {
  try {
    useData.setState({ mcp: await invoke('mcp:list', undefined) })
  } catch (err) {
    reportError(err)
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function reportError(err: unknown, prefix?: string): void {
  const message = errorMessage(err)
  toast(prefix ? `${prefix} ${message}` : message, 'error')
}

/** invoke() that shows a toast on failure and returns undefined instead of throwing. */
export async function attempt<C extends InvokeChannel>(
  channel: C,
  req: InvokeMap[C]['req'],
  failure?: string
): Promise<InvokeMap[C]['res'] | undefined> {
  try {
    return await invoke(channel, req)
  } catch (err) {
    reportError(err, failure)
    return undefined
  }
}

/** For channels without a useful result: true when it worked, false after a toast. */
export async function run<C extends InvokeChannel>(channel: C, req: InvokeMap[C]['req'], failure?: string): Promise<boolean> {
  try {
    await invoke(channel, req)
    return true
  } catch (err) {
    reportError(err, failure)
    return false
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function openBot(botId: Id): Promise<void> {
  const existing = findDm(useData.getState().conversations, botId)
  if (existing) return navigate({ kind: 'conversation', id: existing.id })
  const conv = await attempt('conv:open-dm', { botId }, "Couldn't open the chat.")
  if (!conv) return
  upsertConversation(conv)
  navigate({ kind: 'conversation', id: conv.id })
}

export async function loadEntries(conversationId: Id): Promise<void> {
  try {
    const page = await invoke('conv:entries', { conversationId, limit: 80 })
    useData.setState((s) => {
      // Keep entries that arrived by push while the page was loading.
      const known = new Set(page.entries.map((e) => e.id))
      const pushed = (s.entries[conversationId] ?? []).filter((e) => !known.has(e.id))
      const merged = [...page.entries, ...pushed].sort((a, b) => a.seq - b.seq)
      const last = merged[merged.length - 1]
      const { [conversationId]: _cleared, ...loadErrors } = s.loadErrors
      return {
        entries: { ...s.entries, [conversationId]: merged },
        hasMore: { ...s.hasMore, [conversationId]: page.hasMore },
        loadErrors,
        ...(last && { lastEntry: { ...s.lastEntry, [conversationId]: last } })
      }
    })
  } catch (err) {
    // Shown in the transcript with a retry, instead of a spinner that never ends.
    useData.setState((s) => ({ loadErrors: { ...s.loadErrors, [conversationId]: errorMessage(err) } }))
    reportError(err, "Couldn't load this chat.")
  }
}

export async function loadOlder(conversationId: Id): Promise<void> {
  const list = useData.getState().entries[conversationId]
  const first = list?.find((e) => Number.isInteger(e.seq))
  if (!first) return
  try {
    const page = await invoke('conv:entries', { conversationId, beforeSeq: first.seq, limit: 80 })
    useData.setState((s) => ({
      entries: { ...s.entries, [conversationId]: [...page.entries, ...(s.entries[conversationId] ?? [])] },
      hasMore: { ...s.hasMore, [conversationId]: page.hasMore }
    }))
  } catch (err) {
    reportError(err)
  }
}

export function markRead(conv: Conversation): void {
  if (!conv.unreadCount) return
  upsertConversation({ ...conv, unreadCount: 0 })
  void invoke('conv:mark-read', { conversationId: conv.id }).catch(() => undefined)
}

export async function createGroup(botIds: Id[], title?: string, settings?: Partial<GroupSettings>): Promise<Conversation | undefined> {
  const conv = await attempt('conv:create-group', { botIds, title, settings }, 'The group could not be created.')
  if (conv) upsertConversation(conv)
  return conv
}

export async function updateConversation(id: Id, patch: InvokeMap['conv:update']['req']['patch']): Promise<void> {
  const conv = await attempt('conv:update', { id, patch }, "Couldn't save. Try again.")
  if (conv) upsertConversation(conv)
}

export async function resetConversation(id: Id): Promise<void> {
  if (!(await run('conv:reset', { conversationId: id }, "Couldn't reset the conversation."))) return
  useData.setState((s) => {
    const lastEntry = { ...s.lastEntry }
    delete lastEntry[id]
    return { entries: { ...s.entries, [id]: [] }, hasMore: { ...s.hasMore, [id]: false }, lastEntry }
  })
  void loadEntries(id)
}

export async function deleteConversation(id: Id): Promise<void> {
  const route = useUi.getState().route
  if (!(await run('conv:delete', { id }, "Couldn't delete the group."))) return
  removeConversation(id)
  if (route.kind === 'conversation' && route.id === id) navigate({ kind: 'home' })
}

export async function stopConversation(id: Id): Promise<void> {
  await run('conv:stop', { conversationId: id }, "Couldn't stop.")
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export async function sendMessage(conv: Conversation, draft: Draft, members: Bot[]): Promise<void> {
  const text = draft.text.trim()
  if (!text && draft.attachmentPaths.length === 0) return
  const clientNonce = nonce()
  const { ids, everyone } = resolveMentions(text, members)
  const list = useData.getState().entries[conv.id] ?? []
  const at = Date.now()
  const optimistic: Entry = {
    id: `local-${clientNonce}`,
    conversationId: conv.id,
    seq: (list[list.length - 1]?.seq ?? 0) + 0.5,
    kind: 'message',
    author: { kind: 'user' },
    text,
    mentions: ids,
    mentionsEveryone: everyone && conv.kind === 'group',
    replyToId: draft.replyToId,
    attachments: draft.attachmentPaths.map((p) => ({ id: p, name: basename(p), mimeType: '', sizeBytes: 0, path: p })),
    isStreaming: false,
    clientNonce,
    createdAt: at,
    updatedAt: at
  }
  upsertEntry(optimistic)
  await deliver(optimistic, draft.attachmentPaths)
}

async function deliver(entry: Entry, attachmentPaths: string[]): Promise<void> {
  const nonceKey = entry.clientNonce!
  useData.setState((s) => {
    const failed = { ...s.failed }
    delete failed[nonceKey]
    return { failed }
  })
  try {
    const saved = await invoke('conv:send', {
      conversationId: entry.conversationId,
      text: entry.text,
      mentions: entry.mentions,
      mentionsEveryone: entry.mentionsEveryone,
      attachmentPaths,
      replyToId: entry.replyToId,
      clientNonce: nonceKey
    })
    upsertEntry(saved)
  } catch (err) {
    useData.setState((s) => ({ failed: { ...s.failed, [nonceKey]: errorMessage(err) } }))
  }
}

export function resend(entry: Entry): void {
  void deliver(entry, entry.attachments.map((a) => a.path))
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export async function updateBot(id: Id, patch: InvokeMap['bots:update']['req']['patch']): Promise<Bot | undefined> {
  // Optimistic: the pane feels instant; the push event or the reply corrects it.
  const prev = useData.getState().botMap.get(id)
  if (prev) setBots(useData.getState().bots.map((b) => (b.id === id ? { ...b, ...patch } : b)))
  try {
    const bot = await invoke('bots:update', { id, patch })
    setBots(useData.getState().bots.map((b) => (b.id === id ? bot : b)))
    return bot
  } catch (err) {
    if (prev) setBots(useData.getState().bots.map((b) => (b.id === id ? prev : b)))
    reportError(err, "Couldn't save.")
    return undefined
  }
}

export async function createBot(name: string, extra: Partial<Bot> = {}): Promise<Bot | undefined> {
  const bot = await attempt('bots:create', { name, ...extra }, "Couldn't create the bot.")
  if (bot) {
    const bots = useData.getState().bots
    if (!bots.some((b) => b.id === bot.id)) setBots([...bots, bot])
  }
  return bot
}

export async function deleteBot(id: Id): Promise<void> {
  if (!(await run('bots:delete', { id }, "Couldn't delete the bot."))) return
  const bots = await attempt('bots:list', undefined)
  if (bots) setBots(bots)
  const conversations = await attempt('conv:list', undefined)
  if (conversations) useData.setState({ conversations })
}

export async function resolveApproval(approvalId: Id, decision: InvokeMap['approval:resolve']['req']['decision']): Promise<void> {
  await run('approval:resolve', { approvalId, decision }, "Couldn't answer the request.")
}

export async function saveSettings(patch: InvokeMap['settings:update']['req']): Promise<void> {
  const prev = useData.getState().settings
  if (prev) useData.setState({ settings: { ...prev, ...patch } })
  try {
    useData.setState({ settings: await invoke('settings:update', patch) })
  } catch (err) {
    if (prev) useData.setState({ settings: prev })
    reportError(err, "Couldn't save.")
  }
}

// ---------------------------------------------------------------------------
// Journey (M1b): projects, note sources and artifacts
// ---------------------------------------------------------------------------

export async function refreshProjects(): Promise<void> {
  try {
    setProjects(await invoke('projects:list', undefined))
  } catch (err) {
    reportError(err)
  }
}

export async function createProject(name: string, description: string): Promise<Project | undefined> {
  const project = await attempt('projects:create', { name, description }, "Couldn't create the project.")
  if (project) useData.setState((s) => ({ projects: [...s.projects, project] }))
  return project
}

/** Open the system file picker for text notes. Empty = cancelled. */
export async function pickNoteFiles(): Promise<string[]> {
  try {
    const paths = await invoke('dialog:open-files', {
      title: 'Attach notes',
      filters: [{ name: 'Notes (Markdown or text)', extensions: ['md', 'txt'] }]
    })
    return paths ?? []
  } catch (err) {
    reportError(err, "Couldn't open the file picker.")
    return []
  }
}

/** Copy the picked note files into the attachment store and record them as sources. */
export async function attachProjectNotes(projectId: Id, paths: string[]): Promise<ProjectSource[] | undefined> {
  return attempt('projects:attach-notes', { projectId, paths }, "Couldn't attach those notes.")
}

/** Start a mission run; it continues in the background and pushes journey:changed. */
export async function startMission(projectId: Id): Promise<boolean> {
  return run('projects:start-mission', { projectId }, "Couldn't start the mission.")
}
