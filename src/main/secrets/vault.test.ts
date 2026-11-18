import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Cipher } from '../contracts'
import { fakeCipher } from '../store/test-helpers'
import { openStore, type PlatformStore } from '../store'
import { createSecretVault, validateSecretName, type PlatformSecretVault } from './vault'

const eperm = (): NodeJS.ErrnoException => {
  const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
  err.code = 'EPERM'
  return err
}

describe('SecretVault', () => {
  let dir: string
  let store: PlatformStore
  let vault: PlatformSecretVault
  let botId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-secrets-'))
    store = openStore(':memory:', { homeDir: dir })
    vault = createSecretVault({ db: store.db, cipher: fakeCipher, filePath: join(dir, 'secrets.json') })
    botId = store.bots.create({ name: 'Ops' }).id
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('validates names', () => {
    expect(() => validateSecretName('CRM_API_TOKEN')).not.toThrow()
    for (const bad of ['crm_token', '1TOKEN', 'A', 'WITH-DASH', 'PATH', 'USERPROFILE', 'FAIBOTS_X', 'X'.repeat(65)]) {
      expect(() => validateSecretName(bad), bad).toThrow()
    }
  })

  it('stores values encrypted and never returns them in listings', () => {
    const info = vault.set({ botId, name: 'CRM_API_TOKEN', description: 'CRM access', value: 'tok-123456789' })
    expect(info).toMatchObject({ name: 'CRM_API_TOKEN', botId, description: 'CRM access' })
    expect(JSON.stringify(vault.list(botId))).not.toContain('tok-123456789')
    const file = readFileSync(join(dir, 'secrets.json'), 'utf8')
    expect(file).not.toContain('tok-123456789')
    expect(vault.envForBot(botId)).toEqual({ CRM_API_TOKEN: 'tok-123456789' })
  })

  it('replaces a value under the same name and survives a reload', () => {
    const first = vault.set({ botId, name: 'TOKEN_A', description: '', value: 'one-value' })
    const second = vault.set({ botId, name: 'TOKEN_A', description: 'updated', value: 'two-value' })
    expect(second.id).toBe(first.id)
    expect(vault.list(botId)).toHaveLength(1)
    const reloaded = createSecretVault({ db: store.db, cipher: fakeCipher, filePath: join(dir, 'secrets.json') })
    expect(reloaded.envForBot(botId)).toEqual({ TOKEN_A: 'two-value' })
  })

  it('keeps bot secrets apart', () => {
    const other = store.bots.create({ name: 'Other' }).id
    vault.set({ botId, name: 'TOKEN', description: '', value: 'mine-123' })
    vault.set({ botId: other, name: 'TOKEN', description: '', value: 'theirs-123' })
    expect(vault.envForBot(botId)).toEqual({ TOKEN: 'mine-123' })
    expect(vault.envForBot(other)).toEqual({ TOKEN: 'theirs-123' })
    expect(vault.list()).toHaveLength(2)
  })

  it('handles provider keys write-only', () => {
    vault.setProviderKey('p1', 'sk-provider-secret')
    expect(vault.getProviderKey('p1')).toBe('sk-provider-secret')
    vault.setProviderKey('p1', null)
    expect(vault.getProviderKey('p1')).toBeUndefined()
  })

  it('redacts values of 6+ characters, longest first', () => {
    vault.set({ botId, name: 'SHORT', description: '', value: 'abc12' })
    vault.set({ botId, name: 'TOKEN', description: '', value: 'secret-value' })
    vault.set({ botId, name: 'LONGER', description: '', value: 'secret-value-extended' })
    vault.setProviderKey('p1', 'sk-ant-xyz789')
    const out = vault.redact('a=secret-value b=secret-value-extended c=abc12 d=sk-ant-xyz789 e=secret-value')
    expect(out).toBe('a=«secret:TOKEN» b=«secret:LONGER» c=abc12 d=«secret:PROVIDER_KEY» e=«secret:TOKEN»')
  })

  it('deletes values with their metadata, and prune drops orphans after a bot delete', () => {
    const info = vault.set({ botId, name: 'TOKEN', description: '', value: 'gone-soon' })
    vault.delete(info.id)
    expect(vault.envForBot(botId)).toEqual({})
    vault.set({ botId, name: 'TOKEN', description: '', value: 'orphan-value' })
    store.bots.delete(botId)
    vault.prune()
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain(Buffer.from('orphan-value').toString('hex'))
    expect(vault.redact('orphan-value')).toBe('orphan-value')
  })

  it('treats undecryptable values as missing instead of failing', () => {
    vault.set({ botId, name: 'TOKEN', description: '', value: 'value-123' })
    const broken: Cipher = { encrypt: fakeCipher.encrypt, decrypt: () => { throw new Error('key changed') } }
    const reloaded = createSecretVault({ db: store.db, cipher: broken, filePath: join(dir, 'secrets.json') })
    expect(reloaded.envForBot(botId)).toEqual({})
  })
})

describe('SecretVault rename retry', () => {
  let dir: string
  let store: PlatformStore
  let botId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-secrets-'))
    store = openStore(':memory:', { homeDir: dir })
    botId = store.bots.create({ name: 'Ops' }).id
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('retries a transient EPERM on the atomic rename and saves', () => {
    let renames = 0
    const sleeps: number[] = []
    const vault = createSecretVault({
      db: store.db,
      cipher: fakeCipher,
      filePath: join(dir, 'secrets.json'),
      renameOpts: {
        attempts: 3,
        backoffMs: [10, 20],
        sleep: (ms) => {
          sleeps.push(ms)
        },
        rename: (from, to) => {
          renames++
          if (renames === 1) throw eperm() // one transient Windows lock
          renameSync(from, to)
        }
      }
    })
    const info = vault.set({ botId, name: 'TOKEN', description: '', value: 'saved-value' })
    expect(info).toMatchObject({ name: 'TOKEN' })
    expect(renames).toBe(2)
    expect(sleeps).toEqual([10]) // one backoff between the two attempts
    expect(vault.envForBot(botId)).toEqual({ TOKEN: 'saved-value' })
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain(Buffer.from('saved-value').toString('hex'))
  })

  it('gives up after the bounded attempts on a permanent EPERM and leaves the file untouched', () => {
    const healthy = createSecretVault({ db: store.db, cipher: fakeCipher, filePath: join(dir, 'secrets.json') })
    healthy.set({ botId, name: 'TOKEN', description: '', value: 'first-value' })
    const before = readFileSync(join(dir, 'secrets.json'), 'utf8')

    let renames = 0
    const locked = createSecretVault({
      db: store.db,
      cipher: fakeCipher,
      filePath: join(dir, 'secrets.json'),
      renameOpts: {
        attempts: 3,
        backoffMs: [0, 0],
        sleep: () => {},
        rename: () => {
          renames++
          throw eperm()
        }
      }
    })
    expect(() => locked.set({ botId, name: 'TOKEN', description: '', value: 'second-value' })).toThrow(/EPERM/)
    expect(renames).toBe(3)
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).toBe(before) // existing file intact
    expect(existsSync(join(dir, 'secrets.json.tmp'))).toBe(false) // stray tmp cleaned up
  })

  it('does not retry errors that are not EPERM', () => {
    let renames = 0
    const vault = createSecretVault({
      db: store.db,
      cipher: fakeCipher,
      filePath: join(dir, 'secrets.json'),
      renameOpts: {
        attempts: 3,
        backoffMs: [0, 0],
        sleep: () => {},
        rename: () => {
          renames++
          throw new Error('ENOSPC: no space left on device')
        }
      }
    })
    expect(() => vault.set({ botId, name: 'TOKEN', description: '', value: 'v' })).toThrow(/ENOSPC/)
    expect(renames).toBe(1) // honest failure, no pointless retries
  })
})

describe('SecretVault without OS encryption', () => {
  let dir: string
  let store: PlatformStore
  let botId: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-secrets-'))
    store = openStore(':memory:', { homeDir: dir })
    botId = store.bots.create({ name: 'Ops' }).id
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses to store new secrets but reads existing entries and reports the warning state', () => {
    const filePath = join(dir, 'secrets.json')
    const healthy = createSecretVault({ db: store.db, cipher: fakeCipher, filePath })
    healthy.set({ botId, name: 'TOKEN', description: '', value: 'kept-value' })

    const gated = createSecretVault({ db: store.db, cipher: fakeCipher, filePath, canStore: () => false })
    expect(gated.canStoreSecrets()).toBe(false)
    expect(() => gated.set({ botId, name: 'NEW_TOKEN', description: '', value: 'x' })).toThrow(/OS encryption is not available/)
    expect(() => gated.setProviderKey('p1', 'key')).toThrow(/OS encryption is not available/)
    // Reads of existing entries still work.
    expect(gated.list(botId)).toHaveLength(1)
    expect(gated.envForBot(botId)).toEqual({ TOKEN: 'kept-value' })
    expect(gated.redact('kept-value')).toBe('«secret:TOKEN»')
    // Removing a key is not a store and keeps working.
    expect(() => gated.setProviderKey('p1', null)).not.toThrow()
  })

  it('stores nothing at all when encryption is unavailable (never silently plaintext)', () => {
    const filePath = join(dir, 'secrets.json')
    const gated = createSecretVault({ db: store.db, cipher: fakeCipher, filePath, canStore: () => false })
    expect(() => gated.set({ botId, name: 'TOKEN', description: '', value: 'plaintext-value' })).toThrow(/OS encryption is not available/)
    expect(existsSync(filePath)).toBe(false) // no value file was ever written
    expect(gated.list(botId)).toEqual([]) // and no metadata row either
    expect(gated.envForBot(botId)).toEqual({})
  })
})
