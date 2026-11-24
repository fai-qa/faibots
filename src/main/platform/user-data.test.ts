import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveDefaultUserData } from './user-data'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, statSync: vi.fn(fs.statSync) }
})

let appData: string
let current: string
let legacy: string

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'faibots-user-data-'))
  current = join(appData, 'faibots')
  legacy = join(appData, 'FaiBots')
})

afterEach(() => {
  vi.mocked(statSync).mockReset()
  rmSync(appData, { recursive: true, force: true })
})

function createStore(folder: string): void {
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'faibots.db'), '')
}

it('keeps the existing database after the product name changes case', () => {
  createStore(legacy)
  mkdirSync(current, { recursive: true })
  // On a case-insensitive file system the two names already resolve to the same store.
  const expected = existsSync(join(current, 'faibots.db')) ? current : legacy
  expect(resolveDefaultUserData(appData, current)).toBe(expected)
})

it('prefers the current store if it has already been created', () => {
  createStore(legacy)
  createStore(current)
  expect(resolveDefaultUserData(appData, current)).toBe(current)
})

it('keeps the legacy database when the current database path is a directory', () => {
  createStore(legacy)
  const directory = statSync(appData)
  const database = statSync(join(legacy, 'faibots.db'))
  // Model both entries on a case-sensitive volume, even on case-insensitive CI.
  vi.mocked(statSync).mockReturnValueOnce(directory).mockReturnValueOnce(database)
  expect(resolveDefaultUserData(appData, current)).toBe(legacy)
})

it('keeps the legacy database when the current profile path is not a directory', () => {
  createStore(legacy)
  const database = statSync(join(legacy, 'faibots.db'))
  const inspect = vi.mocked(statSync)
  inspect.mockImplementationOnce(() => { throw Object.assign(new Error('Not a directory'), { code: 'ENOTDIR' }) })
  inspect.mockReturnValueOnce(database)
  expect(resolveDefaultUserData(appData, current)).toBe(legacy)
})

it('keeps fresh installations and custom paths on their chosen folders', () => {
  expect(resolveDefaultUserData(appData, current)).toBe(current)
  createStore(legacy)
  const custom = join(appData, 'work-profile')
  expect(resolveDefaultUserData(appData, custom)).toBe(custom)
})
