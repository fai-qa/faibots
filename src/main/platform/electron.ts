// The only place, besides index.ts and ipc/, that talks to Electron APIs.

import { BrowserWindow, dialog, Notification, safeStorage } from 'electron'
import type { Cipher } from '../contracts'

/**
 * OS-backed encryption for secrets (DPAPI on Windows, Keychain on macOS).
 * Refuses to fall back to plaintext: losing a key is better than leaking one.
 */
export function createSafeStorageCipher(): Cipher {
  return {
    encrypt(plain) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available; secrets cannot be stored.')
      return safeStorage.encryptString(plain)
    },
    decrypt(data) {
      return safeStorage.decryptString(data)
    }
  }
}

/** Whether new secrets can be encrypted right now. Call after app ready (the value can be
 *  unreliable before that, and can change later on Linux). */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

export async function pickFiles(
  win: BrowserWindow | null,
  opts: { title?: string; filters?: { name: string; extensions: string[] }[]; directories?: boolean }
): Promise<string[]> {
  // Windows and Linux cannot show one dialog for both files and folders, so the caller picks.
  const options: Electron.OpenDialogOptions = {
    title: opts.title ?? (opts.directories ? 'Choose folders' : 'Choose files'),
    properties: [opts.directories ? 'openDirectory' : 'openFile', 'multiSelections'],
    ...(!opts.directories && { filters: opts.filters })
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

// A Notification that gets garbage-collected stops delivering clicks, so keep the recent ones.
const liveNotifications = new Set<Notification>()
const MAX_LIVE_NOTIFICATIONS = 20

/** Desktop notification that focuses the conversation when clicked. */
export function notify(input: { title: string; body: string; urgent?: boolean; onClick?: () => void }): void {
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: input.title,
    body: input.body,
    urgency: input.urgent ? 'critical' : 'normal',
    silent: !input.urgent
  })
  const release = () => liveNotifications.delete(n)
  n.on('click', () => {
    release()
    input.onClick?.()
  })
  n.on('close', release)
  liveNotifications.add(n)
  if (liveNotifications.size > MAX_LIVE_NOTIFICATIONS) {
    const oldest = liveNotifications.values().next().value
    if (oldest) liveNotifications.delete(oldest)
  }
  n.show()
}
