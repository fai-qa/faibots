import { app, BrowserWindow, dialog, shell } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppSettings } from '@shared/domain'
import type { EventBus, Services } from './contracts'
import { buildHandlers, registerHandlers } from './ipc/handlers'
import { createSafeStorageCipher, encryptionAvailable, notify } from './platform/electron'
import { createNotifier } from './platform/notifier'
import { createTrayController, HIDDEN_ARG, setOpenAtLogin, type TrayController } from './platform/tray'
import { resolveDefaultUserData } from './platform/user-data'
import { createPlatformServices } from './platform-services'
import { deliverWorkReplies } from './agent/work-brief-tools'
import { createRuntimeServices } from './runtime-services'

let mainWindow: BrowserWindow | null = null
let services: Services | undefined
let onBusEvent: EventBus['emit'] | undefined
let tray: TrayController | undefined
/** Set once the user really quits (tray menu, app menu), so closing the window stops hiding it. */
let quitting = false
let toldAboutTray = false
/** Launched at sign-in: stay in the tray until the user opens the window. */
const startHidden = process.argv.includes(HIDDEN_ARG)

/** Main -> renderer events. Every service emits through this one bus. */
const bus: EventBus = {
  emit(channel, payload) {
    const win = mainWindow
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    onBusEvent?.(channel, payload)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'faibots',
    backgroundColor: '#0f1012',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => {
    if (!(startHidden && keepRunning()) || shownOnce) win.show()
    shownOnce = true
  })

  // With "keep running" on, closing the window hides FaiBots to the tray so routines go on.
  win.on('close', (event) => {
    if (quitting || !keepRunning()) return
    event.preventDefault()
    win.hide()
    if (!toldAboutTray) {
      toldAboutTray = true
      notify({
        title: 'faibots is still running',
        body: 'Your routines keep going. Open faibots or quit it from the tray icon.',
        urgent: false,
        onClick: () => focusWindow()
      })
    }
  })

  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch((err) => console.error('[main] could not open link:', err))
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // The dev server URL is for `npm run dev` only. The installed app ignores it, so no other program
  // can point this window (and its preload bridge) at another page.
  const devUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  win.webContents.once('did-finish-load', () => win.webContents.send('app:ready', { at: Date.now() }))
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

let shownOnce = false

function keepRunning(): boolean {
  try {
    return services?.store.settings.get().background.keepRunning ?? false
  } catch {
    return false
  }
}

// Portable and command-line profiles have their own workspace and Windows sign-in entry.
function explicitProfile(): string | undefined {
  const custom = process.argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
  return custom ? app.getPath('userData') : undefined
}

/** Tray, sign-in item, routine timer and webhook server follow the settings. */
function applyBackgroundSettings(s: Services, settings: AppSettings): void {
  tray?.setVisible(settings.background.keepRunning)
  tray?.refresh()
  try {
    setOpenAtLogin(settings.background.keepRunning && settings.background.openAtLogin, explicitProfile())
  } catch (err) {
    console.error('[main] could not change the sign-in item:', err instanceof Error ? err.message : err)
  }
  s.routines.refresh()
  if (settings.webhooks.enabled) {
    void s.webhooks.listen(settings.webhooks.port).then((status) => {
      if (!status.listening) console.error('[main] webhook server:', status.error)
    })
  } else {
    void s.webhooks.close()
  }
}

function quitApp(): void {
  quitting = true
  app.quit()
}

function focusWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  return mainWindow
}

function startServices(): Services {
  const dataDir = app.getPath('userData')
  // Startup safeStorage gate: with OS encryption unavailable the vault must refuse NEW secrets
  // (never silently store plaintext); reads of existing entries keep working. Checked live at
  // every save too, since availability can change at runtime.
  if (!encryptionAvailable()) {
    console.warn('[main] OS encryption (safeStorage) is not available: new secrets cannot be stored. Existing secrets remain readable.')
  }
  const platform = createPlatformServices({
    dataDir,
    bus,
    cipher: createSafeStorageCipher(),
    homeDir: homedir(),
    defaultWorkspaceRoot: explicitProfile() ? join(dataDir, 'workspaces') : undefined,
    canStoreSecrets: encryptionAvailable
  })
  const base = { ...platform, bus, dataDir }
  const runtime = createRuntimeServices(base)
  const all: Services = { ...base, ...runtime }

  const notifier = createNotifier({
    store: all.store,
    isWindowFocused: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused(),
    show: ({ title, body, urgent, conversationId }) =>
      notify({
        title,
        body,
        urgent,
        onClick: () => focusWindow().webContents.send('nav:focus-conversation', { conversationId })
      })
  })
  onBusEvent = (channel, payload) => {
    notifier.onEvent(channel, payload)
    if (channel === 'settings:changed') applyBackgroundSettings(all, (payload as { settings: AppSettings }).settings)
  }
  all.approvals.subscribe((event) => notifier.onApproval(event))

  tray = createTrayController({
    open: () => void focusWindow(),
    quit: quitApp,
    routinesPaused: () => all.store.settings.get().background.routinesPaused,
    setRoutinesPaused: (routinesPaused) => {
      const current = all.store.settings.get()
      const settings = all.store.settings.update({ background: { ...current.background, routinesPaused } })
      bus.emit('settings:changed', { settings })
    }
  })
  applyBackgroundSettings(all, all.store.settings.get())
  all.routines.start()
  void deliverWorkReplies(platform.store, all.runtime).catch((err) => console.warn('[work] Could not deliver pending owner reply', err instanceof Error ? err.message : 'unknown'))
  return all
}

let shuttingDown = false

/** Stop background work before quitting. The renderer can still read until its window closes. */
async function shutdown(): Promise<void> {
  const s = services
  if (!s) return
  services = undefined
  app.once('will-quit', () => {
    try {
      s.store.close()
    } catch (err) {
      console.error('[main] closing the database failed:', err instanceof Error ? err.message : err)
    }
  })
  tray?.destroy()
  tray = undefined
  // Routines and webhooks first (they start turns), then turns (they use the bridge and MCP
  // servers); every step runs even if one fails, so MCP child processes never outlive the app.
  const steps = (async () => {
    await Promise.allSettled([s.routines.shutdown(), s.webhooks.close()])
    await s.runtime.shutdown().catch((err) => console.error('[main] runtime shutdown failed:', err))
    await Promise.allSettled([s.mcp.shutdown(), s.bridge.shutdown()])
  })()
  await Promise.race([steps, new Promise((r) => setTimeout(r, 5000))])
}

// Choose the established profile before Electron locks the folder or opens any services.
if (!explicitProfile()) {
  const current = app.getPath('userData')
  try {
    const established = resolveDefaultUserData(app.getPath('appData'), current)
    if (established !== current) app.setPath('userData', established)
  } catch (err) {
    console.warn('[main] could not check the existing data folder:', err)
  }
}

// One running copy only: two would write the same database and secrets file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => focusWindow())

  // Windows ties toasts to this id; it must match the installer's appId.
  if (process.platform === 'win32') app.setAppUserModelId('com.faibots.app')

  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : reason)
  })

  app.whenReady().then(() => {
    try {
      services = startServices()
      const getWindow = () => mainWindow
      registerHandlers(buildHandlers(services, getWindow), getWindow)
    } catch (err) {
      // Without services the window would be an empty shell; say why and quit instead.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[main] startup failed:', err)
      dialog.showErrorBox('faibots could not start', `${message}\n\nData folder: ${app.getPath('userData')}`)
      app.exit(1)
      return
    }
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (shuttingDown) {
      event.preventDefault()
      return
    }
    if (!services) return
    event.preventDefault()
    shuttingDown = true
    void shutdown().finally(() => {
      shuttingDown = false
      app.quit()
    })
  })

  app.on('window-all-closed', () => {
    // With "keep running" the window only hides, so this fires on a real quit only.
    if (process.platform !== 'darwin' && !keepRunning()) app.quit()
  })
}
