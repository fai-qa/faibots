import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { RoutineAcceptanceContract, RoutineAcceptanceEvidence } from '@shared/domain'

const MAX_BYTES = 1024 * 1024

/** Validate at the owner-facing boundary; do not run arbitrary verifier commands from a prompt. */
export function normalizeAcceptance(input: unknown): RoutineAcceptanceContract | null {
  if (input == null) return null
  if (typeof input !== 'object' || !('checks' in input) || !Array.isArray(input.checks) ||
    input.checks.length < 1 || input.checks.length > 8) throw new Error('Acceptance requires 1 to 8 file checks.')
  const seen = new Set<string>()
  return { checks: input.checks.map((c: unknown) => {
    if (!c || typeof c !== 'object' || !('path' in c) || typeof c.path !== 'string') throw new Error('Acceptance needs a relative file path.')
    const path = c.path.replace(/\\/g, '/')
    if (!path || path.length > 240 || isAbsolute(path) || /[:\x00-\x1f]/.test(path) ||
      path.split('/').some((part) => !part || part === '..' || part === '.') || seen.has(path.toLowerCase())) {
      throw new Error('Acceptance paths must be unique files inside the bot workspace.')
    }
    seen.add(path.toLowerCase())
    const contains = 'contains' in c ? c.contains : undefined
    const sha256 = 'sha256' in c ? c.sha256 : undefined
    if (contains !== undefined && (typeof contains !== 'string' || !contains.trim() || contains.length > 4000)) throw new Error('Acceptance text must be 1 to 4000 characters.')
    if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) throw new Error('Acceptance SHA-256 must be 64 hexadecimal characters.')
    if (contains === undefined && sha256 === undefined) throw new Error('Acceptance needs required text or an expected SHA-256.')
    return { path, ...(typeof contains === 'string' && { contains }), ...(typeof sha256 === 'string' && { sha256: sha256.toLowerCase() }) }
  }) }
}

export type Observation = { kind: 'ok'; sha256: string; bytes: number; data: Buffer } | { kind: 'missing' | 'invalid'; reason: string }
/** A not-yet-created workspace is pinned under its nearest existing canonical ancestor. */
export function pinWorkspace(root: string): string {
  let path = resolve(root)
  const tail: string[] = []
  for (;;) {
    try { return resolve(realpathSync(path), ...tail) }
    catch (err) {
      const parent = dirname(path)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw err
      tail.unshift(basename(path)); path = parent
    }
  }
}

/**
 * Read and hash one file relative to a canonical root. Shared by routine acceptance
 * (capture/verify) and by artifact-revision snapshots (FJ-06): the same safety rules
 * (inside the pinned root, a regular file no larger than 1 MiB, full SHA-256) apply to both.
 */
export function observeFile(root: string, path: string, expectedRoot: string): Observation {
  let fd: number | undefined
  try {
    const canonicalRoot = realpathSync(root)
    if (canonicalRoot !== expectedRoot) return { kind: 'invalid', reason: 'Workspace location changed during the run.' }
    const file = realpathSync(resolve(root, path))
    const rel = relative(canonicalRoot, file)
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      return { kind: 'invalid', reason: 'File resolves outside the bot workspace.' }
    }
    fd = openSync(file, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) return { kind: 'invalid', reason: 'Expected a regular file no larger than 1 MiB.' }
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, null)
      if (!n) break
      bytes += n
    }
    if (bytes > MAX_BYTES) return { kind: 'invalid', reason: 'File grew beyond the 1 MiB verification limit.' }
    const data = buffer.subarray(0, bytes)
    return { kind: 'ok', sha256: createHash('sha256').update(data).digest('hex'), bytes, data }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing', reason: 'Required file is missing.' }
      : { kind: 'invalid', reason: 'File could not be read safely.' }
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function captureAcceptance(root: string, contract: RoutineAcceptanceContract | null | undefined): RoutineAcceptanceEvidence {
  if (!contract) return { status: 'unverified', reason: 'No owner acceptance contract was defined.', checks: [] }
  let workspacePath: string
  try { workspacePath = pinWorkspace(root) }
  catch { return { status: 'unverified', reason: 'Workspace location could not be pinned before execution.',
    checks: contract.checks.map((check) => ({ ...check, status: 'unverified' })) } }
  return { status: 'pending', workspacePath, checks: contract.checks.map((check) => {
    const before = observeFile(root, check.path, workspacePath)
    return { ...check, status: 'pending', ...(before.kind === 'ok' && { beforeSha256: before.sha256 }),
      ...(before.kind === 'invalid' && { baselineError: before.reason }) }
  }) }
}

export function unverifiedAcceptance(evidence: RoutineAcceptanceEvidence, reason: string, at: number): RoutineAcceptanceEvidence {
  return { ...evidence, status: 'unverified', reason, checkedAt: at,
    checks: evidence.checks.map((check) => ({ ...check, status: 'unverified', reason })) }
}

export function verifyAcceptance(root: string, evidence: RoutineAcceptanceEvidence, at: number): RoutineAcceptanceEvidence {
  if (evidence.status !== 'pending') return { ...evidence, checkedAt: at }
  let locationMatches = false
  try { locationMatches = !!evidence.workspacePath && realpathSync(root) === evidence.workspacePath } catch { /* missing or unreadable */ }
  if (!locationMatches) {
    const reason = 'Workspace is unavailable or its location changed during the run.'
    return { ...evidence, status: 'failed', checkedAt: at, reason,
      checks: evidence.checks.map((check) => ({ ...check, status: 'failed', reason })) }
  }
  const checks = evidence.checks.map((check) => {
    const observed = observeFile(root, check.path, evidence.workspacePath!)
    const reason = check.baselineError ? `Baseline unavailable: ${check.baselineError}` : observed.kind !== 'ok' ? observed.reason
      : observed.sha256 === check.beforeSha256 ? 'File is unchanged from before this run.'
      : check.sha256 && check.sha256 !== observed.sha256 ? 'File SHA-256 does not match.'
      : check.contains && !observed.data.toString('utf8').includes(check.contains) ? 'File does not contain the required text.' : undefined
    return { ...check, status: reason ? 'failed' as const : 'passed' as const, ...(reason && { reason }),
      ...(observed.kind === 'ok' && { observedSha256: observed.sha256, bytes: observed.bytes }) }
  })
  return { ...evidence, status: checks.length && checks.every((c) => c.status === 'passed') ? 'passed' : 'failed', checkedAt: at, checks }
}

export interface RevisionFileVerdict {
  status: 'passed' | 'failed'
  reason?: string
  observedSha256?: string
  bytes?: number
}

/**
 * Host check for one artifact revision (FJ-06): observe the deliverable file with the same
 * rules as routine acceptance and compare its full SHA-256 with the snapshot the revision
 * stored. Unlike routine checks there is no before/after comparison — the stored hash is the
 * contract, and the observation must match it exactly.
 */
export function verifyRevisionFile(root: string, path: string, expectedRoot: string, expectedSha256: string): RevisionFileVerdict {
  const observed = observeFile(root, path, expectedRoot)
  if (observed.kind !== 'ok') return { status: 'failed', reason: observed.reason }
  if (observed.sha256 !== expectedSha256.toLowerCase()) {
    return { status: 'failed', reason: 'File SHA-256 does not match.', observedSha256: observed.sha256, bytes: observed.bytes }
  }
  return { status: 'passed', observedSha256: observed.sha256, bytes: observed.bytes }
}
