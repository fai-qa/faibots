import { expect, it, vi } from 'vitest'
import { app } from 'electron'
import { HIDDEN_ARG, setOpenAtLogin } from './tray'

vi.mock('electron', () => ({ app: { isPackaged: true, setLoginItemSettings: vi.fn() } }))

it.skipIf(process.platform !== 'win32')('keeps each explicit Windows profile separate from the installed sign-in entry', () => {
  const observed = vi.mocked(app.setLoginItemSettings)
  const profile = 'C:/Preview profiles/desktop'
  setOpenAtLogin(true, profile)
  setOpenAtLogin(false, profile.toUpperCase())
  setOpenAtLogin(true, 'C:/Preview profiles/other')
  setOpenAtLogin(false)
  const [first, disabled, other, installed] = observed.mock.calls.map(([opts]) => opts)
  expect(first).toMatchObject({ args: [`--user-data-dir=${profile}`, HIDDEN_ARG], openAtLogin: true })
  expect(first!.name).toMatch(/^faibots-profile-[0-9a-f]{24}$/)
  expect(disabled!.name).toBe(first!.name)
  expect(other!.name).not.toBe(first!.name)
  expect(installed).toEqual({ args: [HIDDEN_ARG], openAtLogin: false })
})
