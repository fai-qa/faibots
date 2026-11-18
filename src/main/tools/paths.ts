import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Windows paths compare case-insensitively. */
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** True when `child` is `parent` or inside it (lexically, after resolving . and ..). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(norm(resolve(parent)), norm(resolve(child)))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Real path of p, following symlinks of the longest existing ancestor, so a link inside the
 * workspace that points elsewhere is judged by where it really goes.
 */
export function realPath(p: string): string {
  let current = resolve(p)
  const rest: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return resolve(p)
    rest.unshift(current.slice(parent.length).replace(/^[\\/]/, ''))
    current = parent
  }
  try {
    return resolve(realpathSync.native(current), ...rest)
  } catch {
    return resolve(p)
  }
}

/** isInside, but judged on real paths (symlinks followed). */
export function isReallyInside(child: string, parent: string): boolean {
  return isInside(realPath(child), realPath(parent))
}

/** Resolve a tool path: `~` is the home folder, relative paths start at the workspace. */
export function resolveToolPath(p: string, workspaceDir: string, homeDir: string): string {
  const trimmed = p.trim()
  if (trimmed === '~') return homeDir
  if (/^~[\\/]/.test(trimmed)) return resolve(homeDir, trimmed.slice(2))
  return resolve(workspaceDir, trimmed)
}
