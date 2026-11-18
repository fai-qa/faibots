// Secret values live encrypted in <dataDir>/secrets.json (base64 of cipher.encrypt), names and
// descriptions in the db. Values never leave the main process: they are injected into tool
// processes as env vars and scrubbed from tool output by redact().

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { Id, SecretInfo } from '@shared/domain'
import type { Cipher, SecretVault } from '../contracts'
import { num, optStr, str, transaction, type Db, type Row } from '../store/db'

export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/
const RESERVED_NAMES = new Set(['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP'])
const MAX_VALUE_CHARS = 16_384
/** Shorter values are too likely to match ordinary text to be worth redacting. */
const MIN_REDACT_CHARS = 6

export function validateSecretName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error('Secret names look like env vars: A-Z, 0-9 and _, starting with a letter, 2 to 64 characters')
  }
  if (RESERVED_NAMES.has(name) || name.startsWith('FAIBOTS_')) {
    throw new Error(`${name} is reserved; pick another name`)
  }
}

interface SecretsFile {
  version: 1
  values: Record<string, string>
}

const providerKeyId = (providerId: Id) => `provider:${providerId}`

function toInfo(r: Row): SecretInfo {
  const botId = optStr(r['bot_id'])
  return {
    id: str(r['id']),
    name: str(r['name']),
    description: str(r['description']),
    ...(botId && { botId }),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

export interface PlatformSecretVault extends SecretVault {
  /** Drop stored values that lost their metadata (e.g. after a bot was deleted). */
  prune(): void
  /** Whether new secrets may be stored right now (false when OS encryption is unavailable). */
  canStoreSecrets(): boolean
}

/** Bounded retry around the atomic rename of the save path (Windows can briefly hold the target). */
export interface SecretVaultRenameOpts {
  /** Total rename attempts. Default 3. */
  attempts?: number
  /** Delay before each retry after an EPERM, in ms. Default [25, 50]. */
  backoffMs?: number[]
  /** Injectable sleep for deterministic tests; defaults to a synchronous wait. */
  sleep?: (ms: number) => void
  /** Injectable rename for deterministic tests; defaults to renameSync. */
  rename?: (from: string, to: string) => void
}

const isEperm = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === 'EPERM'

/** renameSync is synchronous, so the backoff needs a synchronous wait (Atomics.wait is allowed in the main process). */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function createSecretVault(opts: {
  db: Db
  cipher: Cipher
  filePath: string
  /** When false (OS encryption unavailable), new secrets are refused; reads of existing entries still work. */
  canStore?: () => boolean
  /** Bounded retry around the atomic rename. See SecretVaultRenameOpts. */
  renameOpts?: SecretVaultRenameOpts
}): PlatformSecretVault {
  const { db, cipher, filePath } = opts
  const canStore = opts.canStore ?? (() => true)
  const rename = opts.renameOpts?.rename ?? renameSync
  const attempts = opts.renameOpts?.attempts ?? 3
  const backoffMs = opts.renameOpts?.backoffMs ?? [25, 50]
  const sleep = opts.renameOpts?.sleep ?? sleepSync
  const storeUnavailableError = () =>
    new Error('OS encryption is not available; new secrets cannot be stored. Existing secrets remain readable.')
  // Decrypted values, loaded on first use. Kept in memory because redact() runs on every tool result.
  let cache: Map<string, string> | undefined

  const load = (): Map<string, string> => {
    if (cache) return cache
    cache = new Map()
    if (!existsSync(filePath)) return cache
    const file = JSON.parse(readFileSync(filePath, 'utf8')) as SecretsFile
    for (const [id, encoded] of Object.entries(file.values ?? {})) {
      try {
        cache.set(id, cipher.decrypt(Buffer.from(encoded, 'base64')))
      } catch {
        // Undecryptable (OS key changed, file copied from another machine): treat as missing.
        console.warn(`[secrets] could not decrypt stored value ${id}; it must be set again`)
      }
    }
    return cache
  }

  /** Atomic rename with a bounded retry: a transient EPERM (a brief lock from another process) is
   *  retried a few times with a short backoff; anything else, or EPERM past the last attempt, fails. */
  const renameWithRetry = (tmp: string, target: string): void => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        rename(tmp, target)
        return
      } catch (err) {
        if (!isEperm(err) || attempt === attempts) throw err
        const wait = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0
        sleep(wait)
      }
    }
  }

  const save = (values: Map<string, string>) => {
    const file: SecretsFile = { version: 1, values: {} }
    for (const [id, value] of values) file.values[id] = cipher.encrypt(value).toString('base64')
    const tmp = `${filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 })
    try {
      renameWithRetry(tmp, filePath)
    } catch (err) {
      rmSync(tmp, { force: true }) // never leave a stray tmp behind
      throw err
    }
  }

  const setValue = (id: string, value: string | null) => {
    const next = new Map(load())
    if (value === null) next.delete(id)
    else next.set(id, value)
    save(next) // write first, so a failed encrypt leaves the cache unchanged
    cache = next
  }

  /** id -> display name for redaction. */
  const names = (): Map<string, string> => {
    const map = new Map<string, string>()
    for (const row of db.prepare('select id, name from secrets').all()) map.set(str(row['id']), str(row['name']))
    return map
  }

  return {
    list(botId) {
      const rows = botId
        ? db.prepare('select * from secrets where bot_id = ? order by name').all(botId)
        : db.prepare('select * from secrets order by bot_id is not null, bot_id, name').all()
      return rows.map(toInfo)
    },

    set(input) {
      if (!canStore()) throw storeUnavailableError()
      const name = input.name.trim()
      validateSecretName(name)
      if (!input.value) throw new Error('A secret needs a value')
      if (input.value.length > MAX_VALUE_CHARS) throw new Error(`Secret values are at most ${MAX_VALUE_CHARS} characters`)
      if (input.botId && !db.prepare('select 1 from bots where id = ?').get(input.botId)) throw new Error('Bot not found')

      return transaction(db, () => {
        const existing = db
          .prepare(`select * from secrets where coalesce(bot_id, '') = ? and name = ?`)
          .get(input.botId ?? '', name)
        const now = Date.now()
        const id = existing ? str(existing['id']) : randomUUID()
        db.prepare(
          `insert into secrets (id, name, description, bot_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?)
           on conflict (id) do update set description = excluded.description, updated_at = excluded.updated_at`
        ).run(id, name, input.description.trim(), input.botId ?? null, existing ? num(existing['created_at']) : now, now)
        // Inside the transaction: if writing the value fails, the metadata row rolls back too.
        setValue(id, input.value)
        return toInfo(db.prepare('select * from secrets where id = ?').get(id)!)
      })
    },

    delete(id) {
      db.prepare('delete from secrets where id = ?').run(id)
      if (load().has(id)) setValue(id, null)
    },

    envForBot(botId) {
      const values = load()
      const env: Record<string, string> = {}
      for (const row of db.prepare('select id, name from secrets where bot_id = ?').all(botId)) {
        const value = values.get(str(row['id']))
        if (value !== undefined) env[str(row['name'])] = value
      }
      return env
    },

    getProviderKey: (providerId) => load().get(providerKeyId(providerId)),

    setProviderKey(providerId, key) {
      const id = providerKeyId(providerId)
      if (key) {
        if (!canStore()) throw storeUnavailableError()
        setValue(id, key)
      } else if (load().has(id)) setValue(id, null)
    },

    redact(text) {
      const values = load()
      if (!text || values.size === 0) return text
      const labels = names()
      // Longest first, so a value that contains another is replaced whole.
      const sorted = [...values.entries()]
        .filter(([, v]) => v.length >= MIN_REDACT_CHARS)
        .sort((a, b) => b[1].length - a[1].length)
      let out = text
      for (const [id, value] of sorted) {
        if (!out.includes(value)) continue
        const label = id.startsWith('provider:') ? 'PROVIDER_KEY' : (labels.get(id) ?? 'SECRET')
        out = out.split(value).join(`«secret:${label}»`)
      }
      return out
    },

    prune() {
      const known = names()
      const providers = new Set(db.prepare('select id from providers').all().map((r) => providerKeyId(str(r['id']))))
      const orphans = [...load().keys()].filter((id) => (id.startsWith('provider:') ? !providers.has(id) : !known.has(id)))
      if (orphans.length === 0) return
      const next = new Map(load())
      for (const id of orphans) next.delete(id)
      save(next)
      cache = next
    },

    canStoreSecrets: () => canStore()
  }
}
