// Maps every IPC channel in src/shared/ipc.ts to a main-process service call.
// Handlers stay thin: validation and behaviour live in the services.

import { app, BrowserWindow, ipcMain } from 'electron'
import { MAX_GROUP_BOTS } from '@shared/domain'
import type { InvokeChannel, InvokeMap } from '@shared/ipc'
import type { Services } from '../contracts'
import { assertRemovableBot } from '../store/bots'
import { createSnapshotService } from '../attachments/snapshots'
import { encryptionAvailable, pickFiles } from '../platform/electron'
import { revisionText } from '../attachments/project-reads'
import { workScope } from '../store/work-scope'
import { workBriefs } from '../store/work-briefs'
import { deliverWorkReplies } from '../agent/work-brief-tools'
import { projectContentHandlers } from './project-content'
import { turnContextHandlers } from '../store/turn-context'
import { projectSessionHandlers } from './project-sessions'
import { improvementHandlers } from './project-improvements'
import { escalationHandlers } from './escalations'
import { startOfLocalDay } from '../store/turns'
import type { PlatformStore } from '../store'
import { exchangeActivityHandlers } from './exchange-activity'

type Handler<C extends InvokeChannel> = (req: InvokeMap[C]['req']) => Promise<InvokeMap[C]['res']> | InvokeMap[C]['res']
type HandlerTable = { [C in InvokeChannel]: Handler<C> }

export function buildHandlers(s: Services, getWindow: () => BrowserWindow | null): HandlerTable {
  const emitBots = () => s.bus.emit('bots:changed', { bots: s.store.bots.list() })

  // The journey repositories live on the concrete PlatformStore (added in M1a); the base
  // Store contract does not declare them, so narrow once for the journey channels below.
  const store = s.store as PlatformStore

  return {
    ...exchangeActivityHandlers(store.db,(room,entryId) => s.runtime.streamingText(room,entryId)),
    ...projectContentHandlers(s, store),
    'work:scope': ({ conversationId, id }) => workScope(store, s, conversationId, id),
    'work:list': ({ conversationId }) => workBriefs(store.db).list(conversationId),
    'work:decide': async (req) => {
      const result = workBriefs(store.db).decide(req.conversationId, req)
      if (req.decision === 'cancel') s.runtime.cancelBrief(req.id)
      s.bus.emit('work:changed', { conversationId: req.conversationId })
      await deliverWorkReplies(store, s.runtime)
      return result
    },
    ...turnContextHandlers(s, store),
    ...projectSessionHandlers(s, store),
    ...improvementHandlers(s, store),
    ...escalationHandlers(s, store),
    'app:info': () => ({
      name: app.getName(),
      version: app.getVersion(),
      dataDir: s.dataDir,
      platform: process.platform,
      // False is the warning state: OS encryption unavailable, so no NEW secrets can be stored
      // (existing ones stay readable). The renderer can show this without a dedicated event.
      encryptionAvailable: encryptionAvailable()
    }),

    // Bots
    'bots:list': () => s.store.bots.list(),
    'bots:create': (req) => {
      const bot = s.store.bots.create(req)
      emitBots()
      return bot
    },
    'bots:update': ({ id, patch }) => {
      const bot = s.store.bots.update(id, patch)
      emitBots()
      return bot
    },
    'bots:delete': ({ id }) => {
      assertRemovableBot(s.store.bots.get(id))
      // Stop the bot's running turns first; the store then removes its dm and exchanges, drops it
      // from groups and emits conv:deleted / conv:changed itself.
      for (const conversation of s.store.conversations.list()) {
        if (conversation.botIds.includes(id)) s.runtime.stop(conversation.id)
      }
      s.store.bots.delete(id)
      emitBots()
    },
    'bots:export-recipe': ({ id }) => s.recipes.exportRecipe(id),
    'bots:import-recipe': ({ recipe }) => {
      const bot = s.recipes.importRecipe(recipe)
      emitBots()
      return bot
    },

    // Conversations
    'conv:list': () => s.store.conversations.list(),
    'conv:open-dm': ({ botId }) => s.runtime.openDm(botId),
    'conv:create-group': (req) => s.runtime.createGroup(req),
    'conv:update': ({ id, patch }) => {
      const current = s.store.conversations.get(id)
      if (!current) throw new Error('Conversation not found')
      if (patch.botIds !== undefined) {
        if (current.kind !== 'group') throw new Error('Only group members can be changed')
        if (patch.botIds.length === 0) throw new Error('A group needs at least one bot')
        if (new Set(patch.botIds).size !== patch.botIds.length) throw new Error('A bot can only be in a group once')
        if (patch.botIds.length > MAX_GROUP_BOTS) throw new Error(`A group has at most ${MAX_GROUP_BOTS} bots`)
        if (patch.botIds.some((botId) => !s.store.bots.get(botId))) throw new Error('Bot not found')
      }
      // A removed member stops its turn in this group.
      if (patch.botIds !== undefined && current.botIds.some((botId) => !patch.botIds!.includes(botId))) {
        s.runtime.stop(id)
      }
      const conversation = s.store.conversations.update(id, {
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.botIds !== undefined && { botIds: patch.botIds }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
        ...(patch.group && current.group && { group: { ...current.group, ...patch.group } })
      })
      s.bus.emit('conv:changed', { conversation })
      return conversation
    },
    'conv:delete': ({ id }) => {
      const conversation = s.store.conversations.get(id)
      if (conversation?.kind === 'dm') assertRemovableBot(s.store.bots.get(conversation.botIds[0]!))
      s.runtime.stop(id)
      s.store.conversations.delete(id)
      s.bus.emit('conv:deleted', { conversationId: id })
    },
    'conv:entries': ({ conversationId, beforeSeq, limit }) =>
      s.store.entries.page(conversationId, { beforeSeq, limit: Math.min(limit ?? 100, 500) }),
    'conv:send': (req) => {
      if (typeof req.clientNonce === 'string' && /^(?:project-result-|work-)/.test(req.clientNonce))
        throw new Error('This message ID is reserved for a saved application request.')
      return s.runtime.send(req)
    },
    'conv:stop': ({ conversationId }) => s.runtime.stop(conversationId),
    'conv:reset': ({ conversationId }) => s.runtime.reset(conversationId),
    'conv:mark-read': ({ conversationId }) => {
      const conversation = s.store.conversations.update(conversationId, { unreadCount: 0 })
      s.bus.emit('conv:changed', { conversation })
    },
    'conv:live-states': () => s.runtime.liveStates(),

    // Approvals
    'approval:resolve': ({ approvalId, decision }) => s.approvals.resolve(approvalId, decision),

    // Memory
    'memory:list': ({ botId, query, limit }) => s.memory.list(botId, { query, limit }),
    'memory:add': ({ botId, text, pinned }) => s.memory.add({ botId, text, pinned, createdBy: 'user' }),
    'memory:update': ({ id, patch }) => s.memory.update(id, patch),
    'memory:delete': ({ id }) => s.memory.delete(id),
    'memory:get-profile': ({ botId }) => s.memory.getProfile(botId),
    'memory:set-profile': ({ botId, content }) => s.memory.setProfile(botId, content),

    // Skills
    'skills:list': ({ botId }) => s.skills.list(botId),
    'skills:get': ({ id }) => s.skills.get(id),
    'skills:save': (req) => s.skills.save(req),
    'skills:delete': ({ id }) => s.skills.delete(id),
    'skills:import-files': ({ paths, assignToBotId }) => s.skills.importFiles(paths, assignToBotId),
    'skills:rescan': () => s.skills.rescan(),

    // Tools
    'tools:list': ({ botId }) => s.tools.info(botId),
    'tools:set-permission': ({ toolName, botId, mode }) => s.tools.setPermission(toolName, mode, botId),

    // MCP
    'mcp:list': () => s.mcp.list(),
    'mcp:save': (req) => s.mcp.save(req),
    'mcp:delete': ({ id }) => s.mcp.delete(id),
    'mcp:restart': ({ id }) => s.mcp.restart(id),
    'mcp:tools': ({ id }) => s.mcp.tools(id),
    'mcp:import': ({ source, json }) => s.mcp.import(source, json),

    // Providers
    'providers:list': () => s.providers.list(),
    'providers:save': (req) => s.providers.save(req),
    'providers:delete': ({ id }) => s.providers.delete(id),
    'providers:test': ({ id }) => s.providers.test(id),
    'providers:models': ({ id }) => s.providers.models(id),

    // Secrets
    'secrets:list': ({ botId }) => s.secrets.list(botId),
    'secrets:set': (req) => s.secrets.set(req),
    'secrets:delete': ({ id }) => s.secrets.delete(id),

    // Routines
    'routines:list': ({ botId }) => s.routines.list(botId),
    'routines:save': (req) => s.routines.save(req, 'user'),
    'routines:delete': ({ id }) => s.routines.delete(id),
    'routines:run-now': ({ id }) => s.routines.runNow(id, 'manual'),
    'routines:runs': (filter) => s.routines.runs(filter),
    'routines:webhook-token': ({ id }) => ({
      token: s.routines.newWebhookToken(id),
      url: s.webhooks.url(id, s.store.settings.get().webhooks.port)
    }),
    'routines:webhook-status': () => {
      const { enabled, port } = s.store.settings.get().webhooks
      const status = s.webhooks.status()
      return { enabled, listening: status.listening, port, ...(status.error && { error: status.error }) }
    },

    // Usage
    'usage:summary': ({ days }) => {
      const count = Math.min(Math.max(Math.round(days) || 1, 1), 366)
      const today = new Date(startOfLocalDay(Date.now()))
      // Calendar arithmetic, so a daylight-saving change inside the range does not shift days.
      const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (count - 1)).getTime()
      return s.store.turns.summary(from, Date.now() + 1)
    },

    // Settings
    'settings:get': () => s.store.settings.get(),
    'settings:update': (patch) => {
      const settings = s.store.settings.update(patch)
      s.bus.emit('settings:changed', { settings })
      return settings
    },

    // Journey: record-only projects, note sources and artifacts (M1b slice)
    'projects:list': () => store.projects.list(),
    'projects:get': ({ id }) => {
      const project = store.projects.get(id)
      if (!project) throw new Error('Project not found')
      return project
    },
    'projects:create': ({ name, description }) => store.projects.create({ name, description }),
    'projects:attach-notes': ({ projectId, paths }) => {
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('Pick at least one note file')
      // The snapshot service (built lazily: it is stateless and needs no wiring at startup)
      // copies the files and enforces md/txt/pdf and 10 MB per note before anything is stored;
      // its errors are plain messages for the renderer.
      const added = createSnapshotService({
        attachments: s.attachments,
        projects: store.projects,
        projectSources: store.projectSources
      }).attach(projectId, paths)
      s.bus.emit('journey:changed', { projectId })
      return added
    },
    'projects:list-sources': ({ projectId }) => {
      if (!store.projects.get(projectId)) throw new Error('Project not found')
      return store.projectContent.library(projectId).filter(item => item.readable && item.selected).map(item => item.source)
    },
    'artifacts:list': ({ projectId }) => {
      if (!store.projects.get(projectId)) throw new Error('Project not found')
      // Owner-saved chat results are private Space Pages with their own live access checks.
      return store.artifacts.listByProject(projectId).filter((artifact) => artifact.kind !== 'work-result').map((artifact) => {
        const revisions = store.artifacts.revisions(artifact.id)
        const latest = revisions[revisions.length - 1]
        // The latest revision's content is shown only when the workspace deliverable file still
        // matches the recorded snapshot hash (verified read; never a stale or guessed body).
        let content: string | undefined
        const file = latest?.provenance.file
        if (file && latest) {
          try {
            content = revisionText(store, projectId, latest, s.dataDir, s.attachments)
          } catch {
            // Unreadable or moved workspace: no content, the revision record stays authoritative.
          }
        }
        return {
          artifact,
          revisions: revisions.map((revision) => ({ ...revision, reviews: store.artifacts.reviews(revision.id) })),
          ...(content !== undefined && { content })
        }
      })
    },
    'projects:start-mission': ({ projectId }) => s.missions.start(projectId),
    'projects:list-runs': ({ projectId, limit }) => {
      if (!store.projects.get(projectId)) throw new Error('Project not found')
      return s.missions.runs(projectId, limit)
    },

    'dialog:open-files': (req) => pickFiles(getWindow(), req)
  }
}

/** Register the table with ipcMain. Errors reach the renderer as rejected promises with a message. */
export function registerHandlers(table: HandlerTable, getWindow: () => BrowserWindow | null): void {
  for (const channel of Object.keys(table) as InvokeChannel[]) {
    const fn = table[channel] as (req: unknown) => unknown
    ipcMain.handle(channel, async (event, req) => {
      const win = getWindow()
      if (!win || win.isDestroyed() || win.webContents !== event.sender ||
          event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
        throw new Error('This action is available only in the faibots window.')
      }
      try {
        return await fn(req)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[ipc] ${channel} failed:`, message)
        throw new Error(message)
      }
    })
  }
}
