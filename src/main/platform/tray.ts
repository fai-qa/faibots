// The tray icon that keeps FaiBots (and its routines) running when the window is closed, plus
// "start at sign-in". Routines only run while the app is running.

import { app, Menu, nativeImage, Tray } from 'electron'

/** 32x32 FaiBots mark (a small bot face), drawn for FaiBots (generated pixel by pixel, no third-party art). */
const ICON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAuklEQVR4nO2XwQ2AIAxFGeMfemAqz2zEAu7EKI6g0WhCGtSiYCGxyT/R9D8rJK0xrQVAFiAPUABoLqSw17R35g6gqaAx11rbXZnXMuZy3NxW/vJUJ2wM4D80P+RjgJIXTqoQA3xtvukHyAZYo0RONkAqnuT0CXAVOTn9dqAJAPVXUEt9AQyjvLXS3P4AJIWleY8Bzgzuzl8DpEzOVOUSSkBy6zQ1kqkPpbpjudFeTBiEzmrGfofOcqoRCx8uLDqWFMWnAAAAAElFTkSuQmCC'

/** Launch argument used for start-at-sign-in: open straight to the tray, without a window. */
export const HIDDEN_ARG = '--hidden'

export interface TrayController {
  /** Show or remove the icon. */
  setVisible(visible: boolean): void
  /** Refresh the menu (paused state changed). */
  refresh(): void
  destroy(): void
}

export function createTrayController(deps: {
  open(): void
  quit(): void
  routinesPaused(): boolean
  setRoutinesPaused(paused: boolean): void
}): TrayController {
  let tray: Tray | undefined

  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Open FaiBots', click: () => deps.open() },
      { type: 'separator' },
      {
        label: 'Pause routines',
        type: 'checkbox',
        checked: deps.routinesPaused(),
        click: (item) => deps.setRoutinesPaused(item.checked)
      },
      { type: 'separator' },
      { label: 'Quit FaiBots', click: () => deps.quit() }
    ])

  return {
    setVisible(visible) {
      if (!visible) {
        tray?.destroy()
        tray = undefined
        return
      }
      if (tray) return
      const image = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_PNG_BASE64}`)
      tray = new Tray(process.platform === 'darwin' ? image.resize({ width: 18, height: 18 }) : image)
      tray.setToolTip('FaiBots: your bots keep running here')
      tray.setContextMenu(menu())
      tray.on('click', () => deps.open())
    },
    refresh() {
      tray?.setContextMenu(menu())
    },
    destroy() {
      tray?.destroy()
      tray = undefined
    }
  }
}

/** Start with Windows / macOS sign-in, opening to the tray. Not available in a dev build. */
export function setOpenAtLogin(open: boolean): void {
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: open, args: [HIDDEN_ARG] })
}
