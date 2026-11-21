// Which provider and model a bot thinks with, and how that route is billed.

import { useState } from 'react'
import type { Bot, ModelRoute } from '@shared/domain'
import { invoke } from '../../lib/bridge'
import { useData } from '../../store/data'
import { useUi } from '../../store/ui'
import { updateBot } from '../../store/actions'
import { useAsync, useDraftValue } from '../../lib/hooks'
import { billingFor, kindInfo, type ModelSetupIssue } from '../../lib/providers'
import { BillingBadge, Spinner } from '../ui/Badge'
import { Field, Select, TextInput } from '../ui/Field'
import { Segmented } from '../ui/Toggle'

type Effort = NonNullable<ModelRoute['effort']> | 'default'

const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' }
]

export function ModelSetupPrompt({ bot, issue }: { bot: Bot; issue: ModelSetupIssue }) {
  const [picking, setPicking] = useState(false)
  return (
    <div className="space-y-2 text-[12.5px] text-fg-2">
      <p>
        {issue.message}{' '}
        <button type="button" className="font-medium text-accent-fg underline underline-offset-2" onClick={() => {
          if (issue.target === 'providers') useUi.setState({ settingsSection: 'providers' })
          else setPicking(true)
        }}>
          {issue.action}
        </button>
      </p>
      {picking && issue.target === 'profile' && <ModelPicker bot={bot} />}
    </div>
  )
}

export function ModelPicker({ bot }: { bot: Bot }) {
  const providers = useData((s) => s.providers)
  const tests = useData((s) => s.providerTests)
  const route = bot.model
  const provider = providers.find((p) => p.id === route.providerId)
  const info = provider ? kindInfo(provider.kind) : undefined
  const models = useAsync(() => (provider ? invoke('providers:models', { id: provider.id }) : Promise.resolve([])), [provider?.id])
  const [customModel, setCustomModel] = useDraftValue(route.modelId, `${bot.id}:${route.providerId}`)

  const setRoute = (patch: Partial<ModelRoute>) => void updateBot(bot.id, { model: { ...route, ...patch } })
  const enabled = providers.filter((p) => p.enabled || p.id === route.providerId)
  const list = models.data ?? []
  const listed = list.some((m) => m.id === route.modelId)

  return (
    <div className="space-y-3 rounded-xl border border-line-soft p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-fg-2">Model</span>
        {provider ? <BillingBadge route={billingFor(provider, tests[provider.id]?.billing)} /> : null}
      </div>

      {providers.length === 0 ? (
        <p className="text-[12.5px] text-fg-3">
          No model providers yet.{' '}
          <button type="button" className="font-medium text-accent-fg hover:underline" onClick={() => useUi.setState({ settingsSection: 'providers' })}>
            Add one in Settings
          </button>
        </p>
      ) : (
        <>
          <Field label="Provider">
            <Select
              value={route.providerId}
              onChange={(e) => setRoute({ providerId: e.target.value, modelId: '', effort: undefined })}
              aria-label="Provider"
            >
              <option value="">No model yet</option>
              {route.providerId && !provider && <option value={route.providerId}>Missing provider: pick another</option>}
              {enabled.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.enabled ? '' : ' (turned off)'}
                </option>
              ))}
            </Select>
          </Field>

          {provider && (
            <Field
              label="Model"
              aside={models.loading ? <Spinner size={12} className="text-fg-4" /> : null}
              hint={models.error ? `Couldn't list models: ${models.error}` : undefined}
            >
              {list.length > 0 ? (
                <Select value={listed ? route.modelId : route.modelId ? '__custom' : ''} onChange={(e) => e.target.value !== '__custom' && setRoute({ modelId: e.target.value })} aria-label="Model">
                  <option value="">Provider default{provider.defaultModelId ? ` (${provider.defaultModelId})` : ''}</option>
                  {list.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label === m.id ? m.id : `${m.label} (${m.id})`}
                    </option>
                  ))}
                  {!listed && route.modelId && <option value="__custom">{route.modelId}</option>}
                </Select>
              ) : (
                <TextInput
                  mono
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  onBlur={() => customModel.trim() !== route.modelId && setRoute({ modelId: customModel.trim() })}
                  placeholder={provider.defaultModelId ? `Provider default (${provider.defaultModelId})` : 'Model id'}
                  aria-label="Model id"
                />
              )}
            </Field>
          )}

          {info?.supportsEffort && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-fg-2">Effort</span>
              <Segmented<Effort>
                label="Reasoning effort"
                size="sm"
                value={route.effort ?? 'default'}
                options={EFFORTS}
                onChange={(v) => setRoute({ effort: v === 'default' ? undefined : v })}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
