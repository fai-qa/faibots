import { KeyRound, Plus, Trash } from 'lucide-react'
import { useState } from 'react'
import type { Bot } from '@shared/domain'
import { errorMessage, invoke } from '../../lib/bridge'
import { confirmDialog } from '../../store/ui'
import { run } from '../../store/actions'
import { useAsync } from '../../lib/hooks'
import { relative } from '../../lib/format'
import { Button, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextInput } from '../ui/Field'
import { ToolPermissionList } from './ToolPermissionList'

export const TOOLS_TAB_STANDING_LINE = 'Choose Always allow or Never allow here. It applies to this bot only.'

export function ToolsTab({ bot }: { bot: Bot }) {
  return (
    <div className="space-y-6 p-4">
      <div className="space-y-2">
        <p className="text-[12.5px] text-fg-3">
          Choose what {bot.name} may do without asking. <span className="text-fg-2">Ask</span> shows you an approval card first.
        </p>
        <p className="text-[12.5px] text-fg-3">{TOOLS_TAB_STANDING_LINE}</p>
      </div>
      <ToolPermissionList botId={bot.id} overrides={bot.toolPermissions} />
      <Secrets bot={bot} />
    </div>
  )
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/

function Secrets({ bot }: { bot: Bot }) {
  const secrets = useAsync(() => invoke('secrets:list', { botId: bot.id }), [bot.id])
  const [adding, setAdding] = useState<{ name?: string } | null>(null)

  const remove = async (id: string, name: string) => {
    const ok = await confirmDialog({ title: `Remove ${name}?`, body: `${bot.name} can no longer use this secret.`, confirmLabel: 'Remove', danger: true })
    if (ok && (await run('secrets:delete', { id }, "Couldn't remove the secret."))) secrets.reload()
  }

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-fg">Secrets</h3>
        <Button size="sm" icon={Plus} onClick={() => setAdding({})}>
          Add secret
        </Button>
      </div>
      <p className="mb-2 text-[12px] text-fg-3">Credentials {bot.name} can use in shell commands as environment variables. Values are write-only.</p>
      {secrets.error && !secrets.data ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-fg-3">
          Couldn't load secrets: {secrets.error}{' '}
          <button type="button" className="underline" onClick={secrets.reload}>
            Try again
          </button>
        </p>
      ) : secrets.loading && !secrets.data ? (
        <p className="px-3 py-4 text-center text-[12.5px] text-fg-3">Loading…</p>
      ) : (secrets.data ?? []).length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-fg-3">No secrets yet</p>
      ) : (
        <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
          {secrets.data!.map((s) => (
            <li key={s.id} className="group flex items-center gap-2.5 px-3 py-2">
              <KeyRound size={13} className="shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[12px] font-medium text-fg">{s.name}</span>
                <span className="block truncate text-[12px] text-fg-3">{s.description || `Updated ${relative(s.updatedAt)}`}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setAdding({ name: s.name })}>
                Replace
              </Button>
              <IconButton size="sm" icon={Trash} label={`Remove ${s.name}`} tone="danger" onClick={() => void remove(s.id, s.name)} />
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <SecretDialog
          botId={bot.id}
          botName={bot.name}
          fixedName={adding.name}
          description={secrets.data?.find((s) => s.name === adding.name)?.description}
          onClose={(saved) => {
            setAdding(null)
            if (saved) secrets.reload()
          }}
        />
      )}
    </section>
  )
}

function SecretDialog({
  botId,
  botName,
  fixedName,
  description: initialDescription,
  onClose
}: {
  botId: string
  botName: string
  fixedName?: string
  description?: string
  onClose: (saved: boolean) => void
}) {
  const [name, setName] = useState(fixedName ?? '')
  const [description, setDescription] = useState(initialDescription ?? '')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!name) return setError('Enter an environment variable name')
    if (!SECRET_NAME.test(name)) return setError('Use an uppercase environment variable name (A-Z, 0-9, _) that starts with a letter')
    if (!value) return setError('Paste the secret value')
    try {
      await invoke('secrets:set', { botId, name, description, value })
      onClose(true)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <Dialog
      title={fixedName ? `Replace ${fixedName}` : 'Add new secret'}
      description={`Stored encrypted on this computer. ${botName} can use it, but nobody can read it back.`}
      onClose={() => onClose(false)}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save secret
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="Environment variable name">
          <TextInput value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="e.g. CRM_API_TOKEN" mono disabled={!!fixedName} data-autofocus={!fixedName || undefined} />
        </Field>
        <Field label="What it is for (shown to the Bot)">
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Read deals from the CRM" />
        </Field>
        <Field label="Secret value">
          <TextInput type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste the secret" autoComplete="off" data-autofocus={fixedName ? true : undefined} />
        </Field>
        {error && <p className="text-[12.5px] text-danger-fg">{error}</p>}
      </div>
    </Dialog>
  )
}
