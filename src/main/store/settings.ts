import { join } from 'node:path'
import type { AppSettings } from '@shared/domain'
import type { SettingsRepo } from '../contracts'
import { parseJson, type Db } from './db'

export function defaultSettings(homeDir: string, userName = ''): AppSettings {
  return {
    theme: 'system',
    botColorInChat: false,
    defaultModel: null,
    toolPermissions: {},
    workspaceRoot: join(homeDir, 'FaiBots', 'workspaces'),
    notifications: { enabled: true, sound: true },
    compactAt: 0.7,
    userName,
    // Off by default: closing the window quits, as people expect. Routines ask to turn it on.
    background: { keepRunning: false, openAtLogin: false, routinesPaused: false },
    webhooks: { enabled: false, port: DEFAULT_WEBHOOK_PORT }
  }
}

/** Unassigned in IANA's registry and rarely used by local dev servers. */
export const DEFAULT_WEBHOOK_PORT = 47821

const THEMES: AppSettings['theme'][] = ['system', 'light', 'dark']

function validate(s: AppSettings): void {
  if (!THEMES.includes(s.theme)) throw new Error(`Unknown theme "${s.theme}"`)
  if (!(s.compactAt >= 0.1 && s.compactAt <= 0.95)) throw new Error('compactAt must be between 0.1 and 0.95')
  if (!s.workspaceRoot.trim()) throw new Error('Workspace folder cannot be empty')
  if (!Number.isInteger(s.webhooks.port) || s.webhooks.port < 1024 || s.webhooks.port > 65535) {
    throw new Error('The webhook port must be a number from 1024 to 65535')
  }
}

export function createSettingsRepo(db: Db, defaults: AppSettings): SettingsRepo {
  const read = db.prepare('select data from settings where id = 1')
  const write = db.prepare('insert into settings (id, data) values (1, ?) on conflict (id) do update set data = excluded.data')

  // Seed on first run so the stored workspace folder stays put even if the home folder changes.
  if (!read.get()) write.run(JSON.stringify(defaults))

  const get = (): AppSettings => {
    const stored = parseJson<Partial<AppSettings>>(read.get()?.['data'], {})
    // Defaults first, so keys added in later versions get a value.
    return {
      ...defaults,
      ...stored,
      notifications: { ...defaults.notifications, ...stored.notifications },
      toolPermissions: { ...stored.toolPermissions },
      background: { ...defaults.background, ...stored.background },
      webhooks: { ...defaults.webhooks, ...stored.webhooks }
    }
  }

  return {
    get,
    update(patch) {
      const next: AppSettings = { ...get(), ...patch }
      validate(next)
      write.run(JSON.stringify(next))
      return next
    }
  }
}
