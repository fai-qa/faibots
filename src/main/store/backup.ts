// Verified file backups for the SQLite database, taken before a pending migration runs.
// The backup is a byte-for-byte copy of the database file plus its -wal/-shm sidecars
// (after a WAL checkpoint folds any pending commits into the main file), and every copy
// is hash-verified before the migration starts. On migration failure the same files are
// restored and verified again (docs/fai-qa/DATABASE.md: "Create verified backups before
// authorized real migration").

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import type { Db } from './db'

export interface VerifiedBackup {
  /** Timestamp suffix shared by every file of this backup. */
  stamp: string
  /** backup path -> live path, for the main file and any -wal/-shm sidecars that existed. */
  files: { backup: string; live: string }[]
  /** sha256 of the main database file at backup time. */
  hash: string
}

const SIDECARS = ['', '-wal', '-shm']

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Copy `from` over `to`, then prove the copy is byte-for-byte identical (by hash). */
function copyAndVerify(from: string, to: string, action: string): void {
  copyFileSync(from, to)
  if (sha256File(to) !== sha256File(from)) {
    if (action === 'Backup') rmSync(to, { force: true }) // drop the bad copy; the source is untouched
    throw new Error(`${action} verification failed: ${to} is not a byte-for-byte copy of ${from}`)
  }
}

/**
 * A verified, timestamped copy of the database at `path`, taken while `db` is open.
 * WAL content is checkpointed first so the main file alone is a complete snapshot; any
 * -wal/-shm sidecars on disk are copied too, so a restore can put back the exact file set.
 */
export function createVerifiedBackup(db: Db, path: string, opts: { stamp?: string } = {}): VerifiedBackup {
  if (path === ':memory:') throw new Error('cannot back up an in-memory database')
  // Fold any WAL content left by the previous process into the main file, so the copied
  // main file is a consistent snapshot even if its sidecars are lost.
  db.exec('pragma wal_checkpoint(truncate)')
  const stamp = opts.stamp ?? new Date().toISOString().replace(/[:.]/g, '-')
  const files: VerifiedBackup['files'] = []
  for (const sidecar of SIDECARS) {
    const live = `${path}${sidecar}`
    if (!existsSync(live)) continue
    const backup = `${live}.backup-${stamp}`
    copyAndVerify(live, backup, 'Backup')
    files.push({ backup, live })
  }
  if (!files.some((f) => f.live === path)) throw new Error(`Database file ${path} is missing`)
  return { stamp, files, hash: sha256File(path) }
}

/** Put a backup back: every backup file is copied over its live path and hash-verified. */
export function restoreVerifiedBackup(backup: VerifiedBackup): void {
  for (const { backup: from, live: to } of backup.files) copyAndVerify(from, to, 'Restore')
}
