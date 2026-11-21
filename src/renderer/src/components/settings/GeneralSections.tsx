import { Copy, FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/domain'
import { invoke, isMockBridge } from '../../lib/bridge'
import { useData } from '../../store/data'
import { toast } from '../../store/ui'
import { reportError, saveSettings } from '../../store/actions'
import { Button } from '../ui/Button'
import { Badge } from '../ui/Badge'
import { Field, Select, TextInput } from '../ui/Field'
import { Segmented, SettingRow, Toggle } from '../ui/Toggle'
import { ToolPermissionList } from '../details/ToolPermissionList'

function useSettings(): AppSettings | null {
  return useData((s) => s.settings)
}

/** Text setting that saves when you leave the field. */
function SettingText({
  value,
  onSave,
  ...rest
}: { value: string; onSave: (v: string) => void; mono?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <TextInput
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      {...rest}
    />
  )
}

export function GeneralSection() {
  const s = useSettings()
  const providers = useData((st) => st.providers)
  if (!s) return null
  const route = s.defaultModel
  return (
    <div className="max-w-[620px] space-y-6">
      <Field label="Your name" hint="Bots use it when they talk about you, and in group chats.">
        <SettingText value={s.userName} onSave={(userName) => void saveSettings({ userName })} placeholder="Enter your name" />
      </Field>

      <div className="divide-y divide-line-soft rounded-xl border border-line-soft px-4">
        <SettingRow title="Notifications" description="Show a desktop notification when a bot finishes or is waiting for you. Each bot can turn this off.">
          <Toggle label="Notifications" checked={s.notifications.enabled} onChange={(enabled) => void saveSettings({ notifications: { ...s.notifications, enabled } })} />
        </SettingRow>
        <SettingRow title="Play sound for notifications" description="A short sound when a notification shows up.">
          <Toggle
            label="Play sound for notifications"
            checked={s.notifications.sound}
            disabled={!s.notifications.enabled}
            onChange={(sound) => void saveSettings({ notifications: { ...s.notifications, sound } })}
          />
        </SettingRow>
      </div>

      <div>
        <div className="mb-1 text-ui font-medium text-fg">Default model</div>
        <p className="mb-3 text-[12.5px] text-fg-3">New bots start with this model. It also routes group messages and writes summaries when a bot has no model.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Provider">
            <Select
              value={route?.providerId ?? ''}
              onChange={(e) => {
                const p = providers.find((x) => x.id === e.target.value)
                void saveSettings({ defaultModel: p ? { providerId: p.id, modelId: p.defaultModelId } : null })
              }}
            >
              <option value="">None</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model id">
            <SettingText
              value={route?.modelId ?? ''}
              disabled={!route}
              mono
              placeholder="Provider default"
              onSave={(modelId) => route && void saveSettings({ defaultModel: { ...route, modelId: modelId.trim() } })}
            />
          </Field>
        </div>
      </div>
    </div>
  )
}

export function PermissionsSection() {
  const s = useSettings()
  if (!s) return null
  return (
    <div className="max-w-[680px]">
      <p className="mb-4 text-[12.5px] text-fg-3">
        <span className="font-medium text-fg-2">Ask</span> posts an approval card in the chat. <span className="font-medium text-fg-2">Always allow</span> and{' '}
        <span className="font-medium text-fg-2">Never allow</span> on a card are saved for that bot only.
      </p>
      <ToolPermissionList overrides={s.toolPermissions} />
    </div>
  )
}

export function AppearanceSection() {
  const s = useSettings()
  if (!s) return null
  return (
    <div className="max-w-[620px] divide-y divide-line-soft rounded-xl border border-line-soft px-4">
      <SettingRow title="Theme" description="Pick the light or dark look for faibots, or follow your system.">
        <Segmented
          label="Theme"
          value={s.theme}
          onChange={(theme) => void saveSettings({ theme })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' }
          ]}
        />
      </SettingRow>
      <SettingRow title="Accent" description="Colour your messages in 1:1 chats with the bot's colour, or keep them black.">
        <Segmented
          label="Accent"
          value={s.botColorInChat ? 'bot' : 'black'}
          onChange={(v) => void saveSettings({ botColorInChat: v === 'bot' })}
          options={[
            { value: 'bot', label: 'Bot color' },
            { value: 'black', label: 'Black' }
          ]}
        />
      </SettingRow>
    </div>
  )
}

export function WorkspaceSection() {
  const s = useSettings()
  if (!s) return null
  const pct = Math.round(s.compactAt * 100)
  return (
    <div className="max-w-[620px] space-y-6">
      <Field label="Workspace folder" hint="Each bot works in its own subfolder here, named after its handle. File tools run without asking inside it.">
        <span className="flex gap-2">
          <SettingText value={s.workspaceRoot} onSave={(workspaceRoot) => workspaceRoot.trim() && void saveSettings({ workspaceRoot: workspaceRoot.trim() })} mono />
          <Button
            icon={FolderOpen}
            onClick={() =>
              void invoke('dialog:open-files', { title: 'Choose the workspace folder', directories: true }).then(
                (paths) => paths[0] && void saveSettings({ workspaceRoot: paths[0] }),
                (err: unknown) => reportError(err)
              )
            }
          >
            Choose…
          </Button>
        </span>
      </Field>
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-ui font-medium text-fg">Summarise long chats at</span>
          <span className="text-ui font-semibold tabular-nums text-fg">{pct}%</span>
        </div>
        <p className="mb-3 text-[12.5px] text-fg-3">
          When a chat fills this much of a model's context window, older messages are summarised so the bot keeps the thread. Claude Code and Codex manage this themselves.
        </p>
        <input
          type="range"
          min={50}
          max={90}
          step={5}
          value={pct}
          onChange={(e) => useData.setState({ settings: { ...s, compactAt: Number(e.target.value) / 100 } })}
          onPointerUp={(e) => void saveSettings({ compactAt: Number((e.target as HTMLInputElement).value) / 100 })}
          onKeyUp={(e) => void saveSettings({ compactAt: Number((e.target as HTMLInputElement).value) / 100 })}
          aria-label="Summarise long chats at"
          className="w-full accent-[var(--c-ink)]"
        />
      </div>
    </div>
  )
}

export function AboutSection() {
  const info = useData((s) => s.appInfo)
  if (!info) return null
  const text = `${info.name} ${info.version}\nOS: ${info.platform}\nData: ${info.dataDir}`
  return (
    <div className="max-w-[620px] space-y-5">
      <div className="flex items-center gap-3">
        <div>
          <div className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            {info.name}
            {isMockBridge() && <Badge tone="warn">Preview with sample data</Badge>}
          </div>
          <div className="text-[12.5px] text-fg-3">Version {info.version}</div>
        </div>
      </div>
      <dl className="divide-y divide-line-soft rounded-xl border border-line-soft text-ui">
        <div className="flex gap-4 px-4 py-2.5">
          <dt className="w-24 shrink-0 text-fg-3">OS</dt>
          <dd className="selectable text-fg">{info.platform}</dd>
        </div>
        <div className="flex gap-4 px-4 py-2.5">
          <dt className="w-24 shrink-0 text-fg-3">Your data</dt>
          <dd className="selectable break-all font-mono text-[12px] text-fg">{info.dataDir}</dd>
        </div>
      </dl>
      <p className="text-[12.5px] text-fg-3">
        Everything stays on this computer. faibots only talks to the model providers and connectors you add.
      </p>
      <Button
        icon={Copy}
        onClick={() => void navigator.clipboard?.writeText(text).then(() => toast('Copied version info', 'success'))}
      >
        Copy version info
      </Button>
    </div>
  )
}
