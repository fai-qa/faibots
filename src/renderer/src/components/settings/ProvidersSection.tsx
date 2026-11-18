// Model providers: add, edit, test, list models. API keys are write-only.

import clsx from 'clsx'
import { Check, ChevronDown, ChevronRight, CircleX, Cpu, KeyRound, Pencil, Plus, Trash, Zap } from 'lucide-react'
import { useState } from 'react'
import type { ProviderConfig } from '@shared/domain'
import { invoke } from '../../lib/bridge'
import { useData } from '../../store/data'
import { confirmDialog } from '../../store/ui'
import { attempt, refreshProviders, reportError, run } from '../../store/actions'
import { useAsync } from '../../lib/hooks'
import { billingFor, kindInfo } from '../../lib/providers'
import { BillingBadge, EmptyState, Spinner } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { ProviderEditor } from './ProviderEditor'

export function ProvidersSection() {
  const providers = useData((s) => s.providers)
  const [editing, setEditing] = useState<ProviderConfig | 'new' | null>(null)
  return (
    <div className="max-w-[720px]">
      <div className="mb-4 flex items-center gap-3">
        <p className="flex-1 text-[12.5px] text-fg-3">Each bot picks one of these in its profile. FaiBots never switches a bot to a different route on its own.</p>
        <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
          Add provider
        </Button>
      </div>
      {providers.length === 0 ? (
        <EmptyState icon={Cpu} title="No providers yet" action={<Button onClick={() => setEditing('new')}>Add provider</Button>}>
          Add an API key, your Claude Code or Codex login, or a local server like Ollama.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {providers.map((p) => (
            <ProviderRow key={p.id} provider={p} onEdit={() => setEditing(p)} />
          ))}
        </ul>
      )}
      {editing && <ProviderEditor provider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ProviderRow({ provider, onEdit }: { provider: ProviderConfig; onEdit: () => void }) {
  const test = useData((s) => s.providerTests[provider.id])
  const [testing, setTesting] = useState(false)
  const [showModels, setShowModels] = useState(false)
  const info = kindInfo(provider.kind)

  const runTest = async () => {
    setTesting(true)
    try {
      const result = await invoke('providers:test', { id: provider.id })
      useData.setState((s) => ({ providerTests: { ...s.providerTests, [provider.id]: result } }))
    } catch (err) {
      reportError(err, 'Test failed.')
    } finally {
      setTesting(false)
    }
  }

  const toggle = async (enabled: boolean) => {
    await attempt('providers:save', { id: provider.id, kind: provider.kind, label: provider.label, baseUrl: provider.baseUrl, defaultModelId: provider.defaultModelId, enabled }, "Couldn't save.")
    void refreshProviders()
  }

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete ${provider.label}?`,
      body: 'Bots that use it will have no model until you pick another. Its saved key is deleted too.',
      confirmLabel: 'Delete provider',
      danger: true
    })
    if (ok && (await run('providers:delete', { id: provider.id }, "Couldn't delete."))) void refreshProviders()
  }

  return (
    <li className={clsx('rounded-xl border border-line-soft', !provider.enabled && 'opacity-70')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-hover text-fg-2">
          <Cpu size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-ui font-semibold text-fg">{provider.label}</span>
            <BillingBadge route={billingFor(provider, test?.billing)} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-fg-3">
            <span>{info.label}</span>
            {provider.defaultModelId && <span className="font-mono text-[11.5px]">{provider.defaultModelId}</span>}
            {provider.baseUrl && <span className="truncate font-mono text-[11.5px]">{provider.baseUrl}</span>}
            {(info.needsKey || provider.hasApiKey) && (
              <span className={clsx('flex items-center gap-1', !provider.hasApiKey && 'text-warn-fg')}>
                <KeyRound size={11} />
                {provider.hasApiKey ? 'Key saved' : 'No key'}
              </span>
            )}
          </div>
        </div>
        <Toggle label={provider.enabled ? 'Turn off' : 'Turn on'} checked={provider.enabled} onChange={(v) => void toggle(v)} />
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-line-soft px-3 py-1.5">
        <Button size="sm" variant="ghost" icon={Zap} onClick={() => void runTest()} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </Button>
        <Button size="sm" variant="ghost" icon={showModels ? ChevronDown : ChevronRight} onClick={() => setShowModels((v) => !v)}>
          Models
        </Button>
        <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit}>
          Edit
        </Button>
        <span className="flex-1" />
        <IconButton size="sm" icon={Trash} label={`Delete ${provider.label}`} tone="danger" onClick={() => void remove()} />
      </div>
      {(testing || test) && (
        <div className="flex items-center gap-2 border-t border-line-soft px-4 py-2 text-[12.5px]">
          {testing ? (
            <Spinner size={13} className="text-fg-3" />
          ) : test?.ok ? (
            <Check size={14} className="text-success-fg" />
          ) : (
            <CircleX size={14} className="text-danger-fg" />
          )}
          <span className={clsx('selectable', test?.ok ? 'text-fg-2' : 'text-danger-fg')}>{testing ? 'Testing the connection…' : test?.message}</span>
        </div>
      )}
      {showModels && <ModelList providerId={provider.id} />}
    </li>
  )
}

function ModelList({ providerId }: { providerId: string }) {
  const models = useAsync(() => invoke('providers:models', { id: providerId }), [providerId])
  return (
    <div className="border-t border-line-soft px-4 py-2.5">
      {models.loading && !models.data ? (
        <Spinner size={13} className="text-fg-3" />
      ) : models.error ? (
        <p className="text-[12.5px] text-danger-fg">{models.error}</p>
      ) : (models.data ?? []).length === 0 ? (
        <p className="text-[12.5px] text-fg-3">This provider has no model list. Type the model id in a bot's profile.</p>
      ) : (
        <table className="w-full text-left text-[12.5px]">
          <thead>
            <tr className="text-2xs text-fg-4">
              <th className="pb-1 font-medium">Model</th>
              <th className="pb-1 font-medium">Context</th>
              <th className="pb-1 font-medium">Tools</th>
            </tr>
          </thead>
          <tbody>
            {models.data!.map((m) => (
              <tr key={m.id} className="border-t border-line-soft">
                <td className="py-1.5 pr-3">
                  <span className="text-fg">{m.label}</span> {m.label !== m.id && <span className="font-mono text-[11.5px] text-fg-3">{m.id}</span>}
                </td>
                <td className="py-1.5 pr-3 tabular-nums text-fg-3">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '—'}</td>
                <td className="py-1.5 text-fg-3">{m.supportsTools ? 'Yes' : 'No'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
