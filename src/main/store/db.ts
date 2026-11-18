import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { MIGRATIONS } from './schema'
import { createVerifiedBackup, restoreVerifiedBackup } from './backup'

export type Db = DatabaseSync
export type Row = Record<string, SQLOutputValue>

/** Open (or create) the database, switch to WAL and bring the schema up to date. */
export function openDatabase(path: string, migrations: string[] = MIGRATIONS): Db {
  // Whether the file existed before we opened it: a fresh database has nothing to lose.
  const preExisting = path !== ':memory:' && existsSync(path)
  const db = new DatabaseSync(path)
  try {
    // Opening a second process can contend while enabling WAL, before migration.
    db.exec('pragma busy_timeout = 5000')
    if (path !== ':memory:') db.exec('pragma journal_mode = wal')
    db.exec('pragma foreign_keys = on')
    if (!preExisting || schemaVersion(db) >= migrations.length) {
      migrate(db, migrations)
    } else {
      // Pending migrations on an existing database: make a verified backup first, and restore
      // it if migrating fails, so the database is never left partway through an upgrade.
      const backup = createVerifiedBackup(db, path)
      try {
        migrate(db, migrations)
      } catch (error) {
        try {
          db.close()
        } catch {
          // already closed
        }
        restoreVerifiedBackup(backup)
        throw error
      }
    }
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // the restore path already closed it
    }
    throw error
  }
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('pragma user_version').get() as { user_version: number }
  return row.user_version
}

export function migrate(db: Db, migrations: string[] = MIGRATIONS): void {
  const current = schemaVersion(db)
  if (current > migrations.length) {
    throw new Error(`Database schema v${current} is newer than this app (v${migrations.length}). Update FaiBots.`)
  }
  for (let v = current; v < migrations.length; v++) {
    transaction(db, () => {
      db.exec(migrations[v]!)
      db.exec(`pragma user_version = ${v + 1}`)
    })
  }
}

let savepointCounter = 0

/** Run fn atomically. Nests safely (savepoints), so repos can call each other inside one. */
export function transaction<T>(db: Db, fn: () => T): T {
  const name = `sp${++savepointCounter}`
  db.exec(`savepoint ${name}`)
  try {
    const result = fn()
    db.exec(`release ${name}`)
    return result
  } catch (err) {
    db.exec(`rollback to ${name}`)
    db.exec(`release ${name}`)
    throw err
  }
}

export function parseJson<T>(value: SQLOutputValue | undefined, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** JSON for a nullable column: undefined/null become SQL null. */
export function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/** Drop keys whose value is undefined, so `{ ...current, ...patch }` never blanks a field. */
export function defined<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>
}

export const str =(v: SQLOutputValue | undefined): string => (typeof v === 'string' ? v : v == null ? '' : String(v))
export const num = (v: SQLOutputValue | undefined): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0)
export const bool = (v: SQLOutputValue | undefined): boolean => num(v) !== 0
export const optStr = (v: SQLOutputValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined)
