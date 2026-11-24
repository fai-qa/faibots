import { statSync } from 'node:fs'
import { join } from 'node:path'

function hasDatabase(dataDir: string): boolean {
  try {
    return statSync(join(dataDir, 'faibots.db'), { throwIfNoEntry: false })?.isFile() ?? false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOTDIR') return false
    throw error
  }
}

/** Keep an existing store across the FaiBots to faibots product-name change. */
export function resolveDefaultUserData(appData: string, current: string): string {
  if (current !== join(appData, 'faibots')) return current
  const legacy = join(appData, 'FaiBots')
  if (hasDatabase(current)) return current
  return hasDatabase(legacy) ? legacy : current
}
