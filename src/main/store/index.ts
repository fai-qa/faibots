// The SQLite store: one file <dataDir>/faibots.db shared by every platform service.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../contracts'
import { createBotContextRepo } from './bot-context'
import { createBotRepo, MAIN_BOT_NAME, type BotDeletion } from './bots'
import { createConversationRepo } from './conversations'
import { openDatabase, type Db } from './db'
import { createEntryRepo, type PlatformEntryRepo } from './entries'
import { createProviderRepo } from './providers'
import { createProjectRepo, createProjectSourceRepo, createArtifactRepo, type ArtifactRepo, type ProjectRepo, type ProjectSourceRepo } from './projects'
import { createProjectContentRepo } from './project-content'
import { createJourneyRunRepo, type JourneyRunRepo } from './journey-runs'
import { createRoutineRepo } from './routines'
import { createSettingsRepo, defaultSettings } from './settings'
import { createTurnLogRepo } from './turns'
import { createActionRepo } from './actions'

export type { BotDeletion } from './bots'

/** The Store contract plus what other platform services need (the shared db, delete hooks). */
export interface PlatformStore extends Store {
  db: Db
  entries: PlatformEntryRepo
  /** Journey repos (migration 6 + 7). */
  projectContent: ReturnType<typeof createProjectContentRepo>
  projects: ProjectRepo
  projectSources: ProjectSourceRepo
  artifacts: ArtifactRepo
  journeyRuns: JourneyRunRepo
  /** Called after a bot and its rows are deleted, to remove files (skills, secret values) and notify the UI. */
  onBotDeleted(listener: (deletion: BotDeletion) => void): () => void
}

export function createStore(opts: { dataDir: string; homeDir: string; userName?: string; defaultWorkspaceRoot?: string }): PlatformStore {
  mkdirSync(opts.dataDir, { recursive: true })
  const store = openStore(join(opts.dataDir, 'faibots.db'), opts)
  try {
    // Hold the write lock while selecting the old identity and its DM, including on first launch.
    store.db.exec('begin immediate')
    const named = store.bots.list().filter((bot) => bot.name.trim().toLowerCase() === MAIN_BOT_NAME)
    const existing = named.find((bot) => bot.isPrimary) ?? named.find((bot) => bot.handle === MAIN_BOT_NAME) ?? named[0]
    let main = existing
    if (!main) {
      main = store.bots.create({ name: MAIN_BOT_NAME, label: 'Main bot', isPrimary: true, pinned: true })
    } else if (!main.isPrimary || main.name !== MAIN_BOT_NAME || main.hidden) {
      main = store.bots.update(main.id, { name: MAIN_BOT_NAME, isPrimary: true, hidden: false })
    }
    const dm = store.conversations.findDm(main.id)
    if (!dm) store.conversations.create({ kind: 'dm', title: MAIN_BOT_NAME, botIds: [main.id] })
    else if (dm.title !== MAIN_BOT_NAME && dm.title.trim().toLowerCase() === MAIN_BOT_NAME) {
      store.conversations.update(dm.id, { title: MAIN_BOT_NAME })
    }
    store.db.exec('commit')
    return store
  } catch (error) {
    // Closing rolls back this startup transaction, including any new bot or DM.
    store.close()
    throw error
  }
}

/** Open a store at an explicit path (':memory:' in tests). */
export function openStore(path: string, opts: { homeDir: string; userName?: string; defaultWorkspaceRoot?: string }): PlatformStore {
  const db = openDatabase(path)
  const listeners = new Set<(deletion: BotDeletion) => void>()
  const settings = createSettingsRepo(db, defaultSettings(opts.homeDir, opts.userName, opts.defaultWorkspaceRoot))

  const projectSources = createProjectSourceRepo(db)
  const bots = createBotRepo(db, settings, (deletion) => {
    for (const listener of listeners) {
      try {
        listener(deletion)
      } catch (err) {
        console.error('[store] bot delete listener failed:', err instanceof Error ? err.message : err)
      }
    }
  })

  return {
    db,
    bots,
    conversations: createConversationRepo(db),
    entries: createEntryRepo(db),
    botContext: createBotContextRepo(db),
    settings,
    providers: createProviderRepo(db),
    turns: createTurnLogRepo(db),
    routines: createRoutineRepo(db),
    actions: createActionRepo(db),
    projectContent: createProjectContentRepo(db, projectSources),
    projects: createProjectRepo(db),
    projectSources,
    artifacts: createArtifactRepo(db),
    journeyRuns: createJourneyRunRepo(db),
    onBotDeleted(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => db.close()
  }
}
