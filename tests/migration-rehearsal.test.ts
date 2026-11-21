// Rehearses database upgrades, a failure mid-migration and a restore, on disposable temp databases
// with synthetic data only (docs/fai-qa/DATABASE.md). No real profile is ever touched.
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate, openDatabase, schemaVersion } from '../src/main/store/db'
import { MIGRATIONS } from '../src/main/store/schema'

import { PROJECT_CONTENT_SCHEMA } from '../src/main/store/project-content-schema'

import { ASSIGNMENT_BUDGET_SCHEMA } from '../src/main/store/assignment-budget-schema'

import { workBriefSchema } from '../src/main/store/work-brief-schema'

const BRIEF_VERSION = MIGRATIONS.indexOf(workBriefSchema) + 1
const BUDGET_VERSION = MIGRATIONS.indexOf(ASSIGNMENT_BUDGET_SCHEMA) + 1
const CONTENT_VERSION = MIGRATIONS.indexOf(PROJECT_CONTENT_SCHEMA) + 1
const LATEST = MIGRATIONS.length

// Every user-data table, the version that introduced it, and the columns we seed and hash
// (columns added by later migrations are deliberately left out so the hash is comparable).
const TABLES: { name: string; since: number; cols: string[]; order: string }[] = [
  { name: 'chief_work', since: BRIEF_VERSION, cols: ['id','conversation_id','user_entry_id','objective','revision','state'], order: 'id' },
  { name: 'chief_decisions', since: BRIEF_VERSION, cols: ['work_id','revision','decision','note','pending_reply'], order: 'work_id,revision' },
  { name: 'chief_wakes', since: BRIEF_VERSION, cols: ['work_id','revision','state','entry_id'], order: 'work_id,revision' },
  { name: 'chief_work_turns', since: BRIEF_VERSION, cols: ['turn_id','work_id'], order: 'turn_id' },
  { name: 'project_spaces', since: CONTENT_VERSION, cols: ['id', 'project_id', 'name'], order: 'id' },
  { name: 'library_items', since: CONTENT_VERSION, cols: ['id', 'owner_id'], order: 'id' },
  { name: 'library_revisions', since: CONTENT_VERSION, cols: ['item_id', 'revision', 'source_id'], order: 'item_id,revision' },
  { name: 'library_access', since: CONTENT_VERSION, cols: ['project_id', 'item_id', 'selected', 'revoked'], order: 'project_id,item_id' },
  { name: 'project_context', since: CONTENT_VERSION, cols: ['run_id', 'space_id', 'rubric', 'sources', 'baseline_run_id'], order: 'run_id' },
  { name: 'space_pages', since: CONTENT_VERSION, cols: ['id', 'run_id', 'revision_id', 'review_id', 'created_at'], order: 'id' },
  { name: 'project_run_turns', since: CONTENT_VERSION, cols: ['run_id', 'turn_id', 'phase'], order: 'run_id,turn_id' },
  { name: 'project_evaluations', since: CONTENT_VERSION, cols: ['run_id', 'observed', 'reason', 'revision_id', 'reviewer', 'turns', 'created_at'], order: 'run_id' },
  { name: 'evaluation_trials', since: CONTENT_VERSION, cols: ['id', 'run_id', 'candidate_id', 'outcome', 'reason', 'created_at', 'integrity', 'contract'], order: 'id' },
  { name: 'settings', since: 1, cols: ['id', 'data'], order: 'id' },
  { name: 'bots', since: 1, cols: ['id', 'name', 'handle', 'avatar', 'model', 'tool_permissions', 'created_at', 'updated_at'], order: 'id' },
  { name: 'conversations', since: 1, cols: ['id', 'kind', 'title', 'bot_ids', 'last_entry_at', 'created_at', 'updated_at'], order: 'id' },
  { name: 'entries', since: 1, cols: ['id', 'conversation_id', 'seq', 'kind', 'author', 'text', 'created_at', 'updated_at'], order: 'id' },
  { name: 'bot_context', since: 1, cols: ['conversation_id', 'bot_id', 'last_seen_seq', 'summary', 'engine_session_id'], order: 'conversation_id, bot_id' },
  { name: 'providers', since: 1, cols: ['id', 'kind', 'label', 'created_at', 'updated_at'], order: 'id' },
  { name: 'memory_profiles', since: 1, cols: ['bot_id', 'content', 'updated_at'], order: 'bot_id' },
  { name: 'memory_facts', since: 1, cols: ['rid', 'id', 'bot_id', 'text', 'created_by', 'created_at', 'updated_at'], order: 'rid' },
  { name: 'secrets', since: 1, cols: ['id', 'name', 'bot_id', 'created_at', 'updated_at'], order: 'id' },
  { name: 'mcp_servers', since: 1, cols: ['id', 'name', 'data', 'created_at', 'updated_at'], order: 'id' },
  { name: 'turns', since: 2, cols: ['id', 'bot_id', 'conversation_id', 'conversation_kind', 'trigger', 'status', 'started_at', 'ended_at'], order: 'id' },
  { name: 'routines', since: 2, cols: ['id', 'bot_id', 'name', 'prompt', 'schedule', 'created_at', 'updated_at'], order: 'id' },
  { name: 'routine_runs', since: 2, cols: ['id', 'routine_id', 'bot_id', 'trigger', 'status', 'started_at'], order: 'id' },
  { name: 'actions', since: 3, cols: ['id', 'bot_id', 'conversation_id', 'tool_name', 'input_digest', 'capability', 'state', 'created_at', 'updated_at'], order: 'id' },
  { name: 'automatic_run_admissions', since: 4, cols: ['id', 'bot_id', 'started_at'], order: 'id' },
  { name: 'projects', since: 6, cols: ['id', 'name', 'description', 'created_at', 'updated_at'], order: 'id' },
  { name: 'project_sources', since: 6, cols: ['id', 'project_id', 'attachment_id', 'name', 'sha256', 'size_bytes', 'kind', 'created_at'], order: 'id' },
  { name: 'artifacts', since: 6, cols: ['id', 'project_id', 'name', 'created_at', 'updated_at'], order: 'id' },
  { name: 'artifact_revisions', since: 6, cols: ['id', 'artifact_id', 'revision_no', 'sha256', 'provenance', 'created_at'], order: 'id' },
  { name: 'review_decisions', since: 6, cols: ['id', 'artifact_revision_id', 'rubric', 'reviewer', 'decision', 'explanation', 'created_at'], order: 'id' },
  { name: 'journey_runs', since: 7, cols: ['id', 'project_id', 'artifact_id', 'status', 'budgets', 'started_at', 'ended_at'], order: 'id' },
  { name: 'delegations', since: 8, cols: ['id', 'caller_id', 'child_id', 'input_hash', 'parent_entry_id', 'question_id', 'state', 'lease', 'engine', 'system_hash', 'receipt', 'delivered_at', 'created_at', 'updated_at'], order: 'id' },
  { name: 'assignment_admissions', since: BUDGET_VERSION, cols: ['assignment_id', 'root_turn_id', 'root_conversation_id', 'parent_assignment_id', 'created_at'], order: 'assignment_id' }
]

/** Insert synthetic rows into every table that exists at schema version v (ids are tagged by v). */
function seed(db: DatabaseSync, v: number): void {
  const t = `v${v}`
  const run = (sql: string, ...args: (string | number)[]) => db.prepare(sql).run(...args)
  if (v === 1) run(`insert into settings (id, data) values (1, ?)`, '{"synthetic":true}')
  run(`insert into bots (id, name, handle, avatar, model, tool_permissions, created_at, updated_at) values (?, ?, ?, 'a', 'm', ?, 1, 2)`,
    `bot-${t}`, `Bot ${t}`, `bot_${t}`, `{"read":"allow","${t}":"ask"}`)
  run(`insert into conversations (id, kind, title, bot_ids, last_entry_at, created_at, updated_at) values (?, 'dm', ?, ?, 3, 1, 2)`,
    `conv-${t}`, `Conv ${t}`, `["bot-${t}"]`)
  run(`insert into entries (id, conversation_id, seq, kind, author, text, created_at, updated_at) values (?, ?, 1, 'message', 'user', ?, 1, 2)`,
    `entry-${t}`, `conv-${t}`, `hello synthetic ${t}`)
  run(`insert into bot_context (conversation_id, bot_id, last_seen_seq, summary, engine_session_id) values (?, ?, 1, 'sum', ?)`,
    `conv-${t}`, `bot-${t}`, `session-${t}`)
  run(`insert into providers (id, kind, label, created_at, updated_at) values (?, 'openai', ?, 1, 2)`, `prov-${t}`, `Provider ${t}`)
  run(`insert into memory_profiles (bot_id, content, updated_at) values (?, ?, 2)`, `bot-${t}`, `profile ${t}`)
  run(`insert into memory_facts (rid, id, bot_id, text, created_by, created_at, updated_at) values (?, ?, ?, ?, 'user', 1, 2)`,
    v, `fact-${t}`, `bot-${t}`, `zebra${t} remembers the quokka`)
  run(`insert into secrets (id, name, bot_id, created_at, updated_at) values (?, ?, ?, 1, 2)`, `sec-${t}`, `NAME_${t}`, `bot-${t}`)
  run(`insert into mcp_servers (id, name, data, created_at, updated_at) values (?, ?, '{}', 1, 2)`, `mcp-${t}`, `mcp ${t}`)
  if (v >= 2) {
    run(`insert into turns (id, bot_id, conversation_id, conversation_kind, trigger, status, started_at, ended_at) values (?, ?, ?, 'dm', 'user', 'ok', 1, 2)`,
      `turn-${t}`, `bot-${t}`, `conv-${t}`)
    run(`insert into routines (id, bot_id, name, prompt, schedule, created_at, updated_at) values (?, ?, ?, 'p', 'daily', 1, 2)`,
      `rout-${t}`, `bot-${t}`, `Routine ${t}`)
    run(`insert into routine_runs (id, routine_id, bot_id, trigger, status, started_at) values (?, ?, ?, 'schedule', 'ok', 1)`,
      `run-${t}`, `rout-${t}`, `bot-${t}`)
  }
  if (v >= 3) {
    run(`insert into actions (id, bot_id, conversation_id, tool_name, input_digest, capability, state, created_at, updated_at) values (?, ?, ?, 'tool', 'digest', 'cap', 'prepared', 1, 2)`,
      `act-${t}`, `bot-${t}`, `conv-${t}`)
  }
  if (v >= 4) run(`insert into automatic_run_admissions (id, bot_id, started_at) values (?, ?, 1)`, `adm-${t}`, `bot-${t}`)
  if (v >= 6) {
    run(`insert into projects (id, name, description, created_at, updated_at) values (?, ?, ?, 1, 2)`, `proj-${t}`, `Project ${t}`, `desc ${t}`)
    run(`insert into project_sources (id, project_id, attachment_id, name, sha256, size_bytes, kind, created_at) values (?, ?, ?, ?, ?, 10, 'md', 1)`,
      `src-${t}`, `proj-${t}`, `att-${t}`, `note ${t}`, 'a'.repeat(64))
    run(`insert into artifacts (id, project_id, name, created_at, updated_at) values (?, ?, ?, 1, 2)`, `art-${t}`, `proj-${t}`, `proposal ${t}`)
    run(`insert into artifact_revisions (id, artifact_id, revision_no, sha256, provenance, created_at) values (?, ?, 1, ?, '{}', 1)`,
      `rev-${t}`, `art-${t}`, 'b'.repeat(64))
    run(`insert into review_decisions (id, artifact_revision_id, rubric, reviewer, decision, explanation, created_at) values (?, ?, ?, 'user', 'accepted', '', 1)`,
      `dec-${t}`, `rev-${t}`, `rubric ${t}`)
  }
  if (v >= 7) {
    run(`insert into journey_runs (id, project_id, artifact_id, status, budgets, started_at, ended_at) values (?, ?, ?, 'complete', '{}', 1, 2)`,
      `jr-${t}`, `proj-${t}`, `art-${t}`)
  }
  if (v >= 8) {
    run(`insert into delegations (id, caller_id, child_id, input_hash, parent_entry_id, question_id,
      state, engine, system_hash, receipt, delivered_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, 'answered', 'native', ?, '{"text":"synthetic reply"}', 3, 1, 2)`,
      `work-${t}`, `bot-${t}`, 'bot-v1', 'c'.repeat(64), `entry-${t}`, 'entry-v1', 'd'.repeat(64))
  }
  if (v >= CONTENT_VERSION) {
    // The project insert already created its Space. Seed every other content row explicitly.
    run('insert into library_items values (?,?)', `src-${t}`, `proj-${t}`)
    run('insert into library_revisions values (?,1,?)', `src-${t}`, `src-${t}`)
    run('insert into library_access values (?,?,1,0)', `proj-${t}`, `src-${t}`)
    run("insert into project_context values (?,?,?,'[]',null)", `jr-${t}`, `proj-${t}`, `rubric ${t}`)
    run("insert into project_run_turns values (?,?,'draft')", `jr-${t}`, `turn-${t}`)
    run('insert into space_pages values (?,?,?,?,1)', `page-${t}`, `jr-${t}`, `rev-${t}`, `dec-${t}`)
    run("insert into project_evaluations values (?,'complete','accepted',?,'user',1,2)", `jr-${t}`, `rev-${t}`)
    run("insert into evaluation_trials values (?,?,?,'passed','accepted',3,'verified','accepted')", v, `jr-${t}`, `jr-${t}`)
  }
  if (v >= BRIEF_VERSION) {
    run("insert into chief_work(id,conversation_id,user_entry_id,objective,deliverable,checks,state,revision,updated_at) values (?,?,?,'brief','draft','review','active',3,1)", `brief-${t}`,`conv-${t}`,`entry-${t}`)
    run("insert into chief_decisions values (?,2,'answer','two copies',1,1)", `brief-${t}`)
    run("insert into chief_wakes values (?,2,'finished',?)",`brief-${t}`,`entry-${t}`)
    run("insert into chief_work_turns values (?,?)",`turn-${t}`,`brief-${t}`)
  }
  if (v >= BUDGET_VERSION) run(`insert into assignment_admissions values (?, ?, ?, ?, 1)`, `work-${t}`, `root-${t}`, `conv-${t}`, 'work-v8')
}

interface Snapshot { counts: Record<string, number>; hash: string }

/** Row counts and a sha256 over the seeded columns of every table that exists at the given version. */
function snapshot(db: DatabaseSync, version: number): Snapshot {
  const counts: Record<string, number> = {}
  const h = createHash('sha256')
  for (const table of TABLES.filter((x) => x.since <= version)) {
    const rows = db.prepare(`select ${table.cols.join(', ')} from ${table.name} order by ${table.order}`).all()
    counts[table.name] = rows.length
    h.update(`${table.name}:${JSON.stringify(rows)}\n`)
  }
  return { counts, hash: h.digest('hex') }
}

function assertClean(db: DatabaseSync): void {
  expect(db.prepare('pragma foreign_key_check').all()).toEqual([])
  expect(db.prepare('pragma integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A raw database migrated to `version`, with synthetic rows seeded at every version on the way. */
function build(path: string, version: number): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma foreign_keys = on')
  for (let v = 1; v <= version; v++) {
    migrate(db, MIGRATIONS.slice(0, v))
    seed(db, v)
  }
  return db
}

let dir = ''
let open: DatabaseSync[] = []
const track = (db: DatabaseSync) => { open.push(db); return db }
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'faibots-migration-')); open = [] })
afterEach(() => {
  for (const db of open) { try { db.close() } catch { /* already closed */ } }
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe('migration rehearsal (disposable data)', () => {
  it('upgrades a chain of populated versions to latest without losing or altering rows', () => {
    const db = track(build(join(dir, 'chain.db'), LATEST - 1))
    expect(schemaVersion(db)).toBe(LATEST - 1)
    const before = snapshot(db, LATEST - 1)
    for (const t of TABLES.filter((x) => x.since <= LATEST - 1)) expect(before.counts[t.name]).toBeGreaterThan(0)

    migrate(db)
    expect(schemaVersion(db)).toBe(LATEST)
    const after = snapshot(db, LATEST - 1)
    expect(after.counts).toEqual(before.counts)
    expect(after.hash).toBe(before.hash)
    assertClean(db)

    // FTS index still finds a synthetic fact written at the first version, and the latest columns exist.
    const hit = db.prepare(`select f.id from memory_fts join memory_facts f on f.rid = memory_fts.rowid where memory_fts match 'zebrav1'`).all()
    expect(hit).toEqual([{ id: 'fact-v1' }])
    expect(db.prepare(`select engine_session_id, engine_binding from bot_context where bot_id = 'bot-v1'`).get())
      .toEqual({ engine_session_id: 'session-v1', engine_binding: null })
  })

  it.each(Array.from({ length: LATEST }, (_, v) => v))('upgrades from version %i to latest cleanly', (from) => {
    const db = track(build(join(dir, `from-${from}.db`), from))
    expect(schemaVersion(db)).toBe(from)
    const before = snapshot(db, from)
    migrate(db)
    expect(schemaVersion(db)).toBe(LATEST)
    expect(snapshot(db, from)).toEqual(before)
    assertClean(db)
  })

  it('rolls back a failing last migration, keeps data, then succeeds with the correct list', () => {
    const db = track(build(join(dir, 'fail.db'), LATEST - 1))
    const before = snapshot(db, LATEST - 1)
    const broken = [...MIGRATIONS.slice(0, LATEST - 1), 'create table partial_change (a integer); insert into no_such_table values (1);']
    expect(() => migrate(db, broken)).toThrow()
    expect(schemaVersion(db)).toBe(LATEST - 1)
    expect(db.prepare(`select name from sqlite_master where name = 'partial_change'`).all()).toEqual([])
    expect(snapshot(db, LATEST - 1)).toEqual(before)
    assertClean(db)

    migrate(db)
    expect(schemaVersion(db)).toBe(LATEST)
    expect(snapshot(db, LATEST - 1)).toEqual(before)
    assertClean(db)
  })

  it('refuses a database from a newer schema and leaves it untouched', () => {
    const path = join(dir, 'newer.db')
    const db = build(path, LATEST - 1)
    migrate(db)
    db.exec(`pragma user_version = ${LATEST + 1}`)
    const before = snapshot(db, LATEST - 1)
    db.exec('pragma wal_checkpoint(truncate)')
    db.close()
    const bytes = fileHash(path)

    const again = track(new DatabaseSync(path))
    expect(() => migrate(again)).toThrow(/newer than this app/)
    expect(schemaVersion(again)).toBe(LATEST + 1)
    again.close()
    expect(fileHash(path)).toBe(bytes)

    expect(() => openDatabase(path)).toThrow(/newer than this app/)
    const check = track(new DatabaseSync(path))
    expect(schemaVersion(check)).toBe(LATEST + 1)
    expect(snapshot(check, LATEST - 1)).toEqual(before)
  })

  it('restores a pre-upgrade copy byte-for-byte and it opens at the old version', () => {
    // Note: restoring a backup is the rollback path. Running an old binary against a newer schema
    // is NOT a rollback (DATABASE.md line 36); the old binary would refuse or misread it.
    const path = join(dir, 'live.db')
    const db = build(path, LATEST - 1)
    const before = snapshot(db, LATEST - 1)
    db.exec('pragma wal_checkpoint(truncate)')
    db.close()
    const backup = join(dir, 'backup.db')
    copyFileSync(path, backup)
    const backupHash = fileHash(backup)

    const upgraded = openDatabase(path)
    track(upgraded)
    expect(schemaVersion(upgraded)).toBe(LATEST)
    upgraded.close()

    const restored = join(dir, 'restored.db')
    copyFileSync(backup, restored)
    expect(fileHash(restored)).toBe(backupHash)
    const r = track(new DatabaseSync(restored))
    expect(schemaVersion(r)).toBe(LATEST - 1)
    expect(snapshot(r, LATEST - 1)).toEqual(before)
    assertClean(r)
  })

  it('makes a verified backup before a pending migration runs, and that backup restores the pre-upgrade database', () => {
    const path = join(dir, 'backed.db')
    const db = build(path, LATEST - 1)
    const before = snapshot(db, LATEST - 1)
    db.exec('pragma wal_checkpoint(truncate)')
    db.close()
    const preHash = fileHash(path)

    // openDatabase sees a pending migration and must back up first.
    const upgraded = track(openDatabase(path))
    expect(schemaVersion(upgraded)).toBe(LATEST)
    upgraded.close()

    // One timestamped backup of the main file, byte-for-byte identical to the pre-upgrade file,
    // plus copies of the -wal/-shm sidecars that existed at backup time.
    const backups = readdirSync(dir).filter((f) => f.includes('.backup-'))
    const mainBackup = backups.find((f) => f.startsWith('backed.db.backup-'))
    expect(mainBackup).toBeDefined()
    expect(fileHash(join(dir, mainBackup!))).toBe(preHash)
    expect(backups.some((f) => f.startsWith('backed.db-wal.backup-'))).toBe(true)
    expect(backups.some((f) => f.startsWith('backed.db-shm.backup-'))).toBe(true)

    // Putting the verified backup back yields the exact pre-upgrade database.
    rmSync(path, { force: true })
    copyFileSync(join(dir, mainBackup!), path)
    const restored = track(new DatabaseSync(path))
    expect(schemaVersion(restored)).toBe(LATEST - 1)
    expect(snapshot(restored, LATEST - 1)).toEqual(before)
    assertClean(restored)
  })

  it('restores the verified backup when a migration fails, leaving the database byte-for-byte untouched', () => {
    const path = join(dir, 'failing.db')
    const db = build(path, LATEST - 1)
    const before = snapshot(db, LATEST - 1)
    db.exec('pragma wal_checkpoint(truncate)')
    db.close()
    const preHash = fileHash(path)

    const broken = [...MIGRATIONS.slice(0, LATEST - 1), 'create table partial_change (a integer); insert into no_such_table values (1);']
    expect(() => openDatabase(path, broken)).toThrow()

    // The failed migration left nothing behind: the live file is the verified pre-upgrade copy.
    expect(fileHash(path)).toBe(preHash)
    const check = track(new DatabaseSync(path))
    expect(schemaVersion(check)).toBe(LATEST - 1)
    expect(check.prepare(`select name from sqlite_master where name = 'partial_change'`).all()).toEqual([])
    expect(snapshot(check, LATEST - 1)).toEqual(before)
    assertClean(check)
    check.close()

    // The backup files remain for inspection, and the same database migrates cleanly afterwards.
    expect(readdirSync(dir).some((f) => f.startsWith('failing.db.backup-'))).toBe(true)
    const ok = track(openDatabase(path))
    expect(schemaVersion(ok)).toBe(LATEST)
    expect(snapshot(ok, LATEST - 1)).toEqual(before)
    assertClean(ok)
  })

  it('fails when the schema adds a table the rehearsal does not seed (future-table guard)', () => {
    // The known rehearsal limit: hashes cover seeded columns only, so a new migration's table
    // could silently pass unrehearsed. This test turns that into a hard failure.
    const db = track(new DatabaseSync(':memory:'))
    migrate(db)
    const actual = db
      .prepare(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like 'memory_fts%' order by name`)
      .all()
      .map((r) => String(r['name']))
    const expected = TABLES.map((t) => t.name).sort()
    // When this fails, a new migration introduced a table: add it to TABLES and seed() it.
    expect(actual, 'every user table must be seeded and hashed by the rehearsal').toEqual(expected)
  })
})
