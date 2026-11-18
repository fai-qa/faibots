import clsx from 'clsx'
import { useState } from 'react'
import type { ProviderConfig, ProviderKind } from '@shared/domain'
import { errorMessage, invoke } from '../../lib/bridge'
import { refreshProviders } from '../../store/actions'
import { toast } from '../../store/ui'
import { PROVIDER_KINDS, billingFor, kindInfo } from '../../lib/providers'
import { BillingBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextInput } from '../ui/Field'
import { Toggle } from '../ui/Toggle'

export function ProviderEditor({ provider, onClose }: { provider: ProviderConfig | null; onClose: () => void }) {
  const [kind, setKind] = useState<ProviderKind | null>(provider?.kind ?? null)
  const info = kind ? kindInfo(kind) : undefined
  const [label, setLabel] = useState(provider?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [defaultModelId, setDefaultModelId] = useState(provider?.defaultModelId ?? '')
  const [enabled, setEnabled] = useState(provider?.enabled ?? true)
  const [apiKey, setApiKey] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const pickKind = (k: ProviderKind) => {
    const i = kindInfo(k)
    setKind(k)
    setLabel(i.defaultLabel)
    setDefaultModelId(i.defaultModel)
    setBaseUrl(k === 'openai-compatible' ? (i.baseUrlPlaceholder ?? '') : '')
  }

  const save = async () => {
    if (!kind || !info) return
    setError(null)
    if (!label.trim()) return setError('Give the provider a name')
    if (info.needsBaseUrl && !baseUrl.trim()) return setError('Enter the server address (base URL)')
    setSaving(true)
    try {
      const saved = await invoke('providers:save', {
        id: provider?.id,
        kind,
        label: label.trim(),
        baseUrl: baseUrl.trim() || undefined,
        defaultModelId: defaultModelId.trim(),
        enabled,
        // Write-only: omit to keep the stored key, '' to remove it.
        ...(apiKey ? { apiKey } : removeKey ? { apiKey: '' } : {})
      })
      await refreshProviders()
      toast(provider ? `Saved ${saved.label}` : `Added ${saved.label}`, 'success')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  if (!kind || !info) {
    return (
      <Dialog title="Add provider" description="Where should this model route come from?" onClose={onClose} width={640}>
        <div className="grid grid-cols-2 gap-2 pb-2">
          {PROVIDER_KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              onClick={() => pickKind(k.kind)}
              className="flex flex-col items-start gap-1 rounded-xl border border-line px-3.5 py-3 text-left hover:border-line-strong hover:bg-hover"
            >
              <span className="flex w-full items-center gap-2">
                <span className="flex-1 text-ui font-semibold text-fg">{k.label}</span>
                <BillingBadge route={billingFor({ kind: k.kind, baseUrl: k.baseUrlPlaceholder } as ProviderConfig)} />
              </span>
              <span className="text-[12px] leading-snug text-fg-3">{k.description}</span>
            </button>
          ))}
        </div>
      </Dialog>
    )
  }

  const keyOptional = !info.needsKey
  return (
    <Dialog
      title={provider ? `Edit ${provider.label}` : `Add ${info.label}`}
      description={info.description}
      onClose={onClose}
      width={520}
      footer={
        <>
          {!provider && (
            <Button variant="ghost" onClick={() => setKind(null)}>
              Back
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : provider ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="Name">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} data-autofocus />
        </Field>
        {(info.needsBaseUrl || kind === 'openai' || kind === 'anthropic') && (
          <Field label={info.needsBaseUrl ? 'Server address' : 'Base URL (optional)'} hint={info.needsBaseUrl ? 'The OpenAI-style endpoint, usually ending in /v1.' : 'Leave empty for the official API.'}>
            <TextInput value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={info.baseUrlPlaceholder ?? 'https://…'} mono />
          </Field>
        )}
        {(info.needsKey || kind === 'openai-compatible' || kind === 'codex') && (
          <Field
            label={keyOptional ? 'API key (optional)' : 'API key'}
            hint={
              provider?.hasApiKey && !removeKey
                ? 'A key is saved. It is never shown again; paste a new one to replace it.'
                : kind === 'codex'
                  ? 'Leave empty to use your `codex login` (ChatGPT plan).'
                  : 'Stored encrypted on this computer. It never leaves the main process.'
            }
            aside={
              provider?.hasApiKey ? (
                <button type="button" onClick={() => setRemoveKey((v) => !v)} className={clsx('text-[12px] font-medium', removeKey ? 'text-fg-2' : 'text-danger-fg')}>
                  {removeKey ? 'Keep saved key' : 'Remove saved key'}
                </button>
              ) : null
            }
          >
            <TextInput
              type="password"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value)
                setRemoveKey(false)
              }}
              placeholder={provider?.hasApiKey ? (removeKey ? 'The saved key will be removed' : '••••••••••••  (saved)') : 'Paste your API key'}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        )}
        <Field label="Default model" hint="Used by bots that pick this provider without choosing a model. Leave empty to let the provider decide.">
          <TextInput value={defaultModelId} onChange={(e) => setDefaultModelId(e.target.value)} placeholder={info.defaultModel || 'Model id'} mono />
        </Field>
        <label className="flex items-center justify-between gap-4 rounded-lg border border-line-soft px-3 py-2.5">
          <span className="text-ui font-medium text-fg">Turned on</span>
          <Toggle label="Turned on" checked={enabled} onChange={setEnabled} />
        </label>
        {error && <p className="text-[12.5px] text-danger-fg">{error}</p>}
      </div>
    </Dialog>
  )
}
