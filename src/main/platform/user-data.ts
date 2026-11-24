import { statSync } from 'node:fs'
import { join } from 'node:path'

/** Keep an existing store across the FaiBots to faibots product-name change. */
export function resolveDefaultUserData(appData: string, current: string): string {
  if (current !== join(appData, 'faibots')) return current
  const legacy = join(appData, 'FaiBots')
  const options = { throwIfNoEntry: false } as const
  if (statSync(join(current, 'faibots.db'), options)) return current
  return statSync(join(legacy, 'faibots.db'), options)?.isFile() ? legacy : current
}
