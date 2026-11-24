import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resolveDefaultUserData } from './user-data'

let appData: string
let current: string
let legacy: string

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'faibots-user-data-'))
  current = join(appData, 'faibots')
  legacy = join(appData, 'FaiBots')
})

afterEach(() => rmSync(appData, { recursive: true, force: true }))

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

it('keeps fresh installations and custom paths on their chosen folders', () => {
  expect(resolveDefaultUserData(appData, current)).toBe(current)
  createStore(legacy)
  const custom = join(appData, 'work-profile')
  expect(resolveDefaultUserData(appData, custom)).toBe(custom)
})
