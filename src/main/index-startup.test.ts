import { expect, it, vi } from 'vitest'

const { app, showErrorBox } = vi.hoisted(() => ({
  app: {
    getPath: vi.fn((name: string) => `/test/${name}`),
    requestSingleInstanceLock: vi.fn(() => false),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    exit: vi.fn()
  },
  showErrorBox: vi.fn()
}))

vi.mock('electron', () => ({ app, dialog: { showErrorBox } }))
vi.mock('./platform/user-data', () => ({
  resolveDefaultUserData: () => {
    throw Object.assign(new Error('Existing profile access denied'), { code: 'EACCES' })
  }
}))

it('reports a profile inspection failure before locking or starting the default profile', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await import('./index')
    await Promise.resolve()

    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(showErrorBox).toHaveBeenCalledWith('faibots could not start', expect.stringContaining('existing FaiBots data folder'))
    expect(app.exit).toHaveBeenCalledWith(1)
  } finally {
    error.mockRestore()
  }
})
