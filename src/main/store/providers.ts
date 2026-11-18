import { randomUUID } from 'node:crypto'
import type { ProviderConfig, ProviderKind } from '@shared/domain'
import type { ProviderRepo } from '../contracts'
import { bool, num, optStr, str, type Db, type Row } from './db'

const KINDS: ProviderKind[] = ['anthropic', 'openai', 'google', 'xai', 'openai-compatible', 'claude-code', 'codex']

function toProvider(r: Row): ProviderConfig {
  const baseUrl = optStr(r['base_url'])
  return {
    id: str(r['id']),
    kind: str(r['kind']) as ProviderKind,
    label: str(r['label']),
    ...(baseUrl && { baseUrl }),
    hasApiKey: bool(r['has_api_key']),
    defaultModelId: str(r['default_model_id']),
    enabled: bool(r['enabled']),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

export function createProviderRepo(db: Db): ProviderRepo {
  const get = (id: string) => {
    const row = db.prepare('select * from providers where id = ?').get(id)
    return row ? toProvider(row) : undefined
  }

  return {
    list: () => db.prepare('select * from providers order by created_at, rowid').all().map(toProvider),
    get,

    save(input) {
      if (!KINDS.includes(input.kind)) throw new Error(`Unknown provider kind "${input.kind}"`)
      const label = input.label.trim()
      if (!label) throw new Error('A provider needs a label')
      const baseUrl = input.baseUrl?.trim() || undefined
      if (input.kind === 'openai-compatible' && !baseUrl) throw new Error('OpenAI-compatible providers need a base URL')
      if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('The base URL must start with http:// or https://')

      const existing = input.id ? get(input.id) : undefined
      if (input.id && !existing) throw new Error('Provider not found')
      if (existing && existing.kind !== input.kind) throw new Error('A provider cannot change kind; add a new one')
      const now = Date.now()
      const provider: ProviderConfig = {
        id: existing?.id ?? randomUUID(),
        kind: input.kind,
        label,
        ...(baseUrl && { baseUrl }),
        hasApiKey: input.hasApiKey,
        defaultModelId: input.defaultModelId.trim(),
        enabled: input.enabled,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      db.prepare(
        `insert into providers (id, kind, label, base_url, has_api_key, default_model_id, enabled, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set label = excluded.label, base_url = excluded.base_url,
           has_api_key = excluded.has_api_key, default_model_id = excluded.default_model_id,
           enabled = excluded.enabled, updated_at = excluded.updated_at`
      ).run(
        provider.id, provider.kind, provider.label, provider.baseUrl ?? null, provider.hasApiKey ? 1 : 0,
        provider.defaultModelId, provider.enabled ? 1 : 0, provider.createdAt, provider.updatedAt
      )
      return provider
    },

    delete(id) {
      db.prepare('delete from providers where id = ?').run(id)
    }
  }
}
