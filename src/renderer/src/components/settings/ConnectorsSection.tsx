// MCP connectors: list with live status, per-tool toggles, custom instructions, import.

import clsx from 'clsx'
import { Check, ChevronDown, ChevronRight, Download, Globe, Pencil, Plug, Plus, RefreshCw, Trash } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { McpServerConfig } from '@shared/domain'
import type { McpImportSource } from '@shared/ipc'
import { invoke } from '../../lib/bridge'
import { CONNECTOR_PRESETS, type ConnectorPreset } from '../../lib/connector-presets'
import { useData, type McpRow } from '../../store/data'
import { confirmDialog, toast } from '../../store/ui'
import { attempt, refreshMcp, reportError, run } from '../../store/actions'
import { useAsync } from '../../lib/hooks'
import { plural } from '../../lib/format'
import { Badge, EmptyState, Spinner, StatusDot } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { TextArea } from '../ui/Field'
import { Toggle } from '../ui/Toggle'
import { statusInfo } from '../details/ConnectorsTab'
import { McpEditor } from './McpEditor'

const TRANSPORT_LABELS = { stdio: 'Command', http: 'HTTP', sse: 'SSE' } as const
const IMPORTS: { source: Exclude<McpImportSource, 'json'>; label: string }[] = [
  { source: 'claude', label: 'Claude' },
  { source: 'codex', label: 'Codex' },
  { source: 'cursor', label: 'Cursor' }
]

function Recommended({ rows }: { rows: McpRow[] }) {
  const [adding, setAdding] = useState<string | null>(null)
  const add = async (preset: ConnectorPreset) => {
    setAdding(preset.id)
    const saved = await attempt('mcp:save', preset.server, `Couldn't add ${preset.title}.`)
    setAdding(null)
    if (!saved) return
    toast(`Added ${preset.title}. Bots set to all connectors can use it now.`, 'success')
    await refreshMcp()
  }
  return (
    <section className="mb-5">
      <div className="mb-2 text-[12px] font-medium text-fg-3">Recommended</div>
      <ul className="space-y-2">
        {CONNECTOR_PRESETS.map((preset) => {
          const added = rows.some((r) => r.server.name === preset.server.name)
          return (
            <li key={preset.id} className="flex items-start gap-3 rounded-xl border border-line-soft px-3.5 py-3">
              <Globe size={16} className="mt-0.5 shrink-0 text-fg-3" />
              <div className="min-w-0 flex-1">
                <div className="text-ui font-medium text-fg">{preset.title}</div>
                <p className="mt-0.5 text-[12px] leading-snug text-fg-3">{preset.description}</p>
                <p className="mt-1 text-[11.5px] text-fg-4">Needs {preset.needs}. Runs <code className="font-mono">{[preset.server.command, ...(preset.server.args ?? [])].join(' ')}</code></p>
              </div>
              {added ? (
                <Badge tone="success">
                  <Check size={11} strokeWidth={2.4} />
                  Added
                </Badge>
              ) : (
                <Button size="sm" icon={Plus} onClick={() => void add(preset)} disabled={adding === preset.id}>
                  {adding === preset.id ? 'Adding…' : 'Add'}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

async function saveServer(server: McpServerConfig, patch: Partial<McpServerConfig>) {
  const { id, createdAt: _c, updatedAt: _u, ...rest } = server
  await attempt('mcp:save', { ...rest, ...patch, id }, "Couldn't save.")
  await refreshMcp()
}

export function ConnectorsSection() {
  const rows = useData((s) => s.mcp)
  const [editing, setEditing] = useState<McpServerConfig | 'new' | null>(null)
  const [importing, setImporting] = useState<string | null>(null)

  const importFrom = async (source: Exclude<McpImportSource, 'json'>, label: string) => {
    setImporting(source)
    try {
      const added = await invoke('mcp:import', { source })
      toast(added.length ? `Imported ${plural(added.length, 'connector')} from ${label}` : `Nothing new to import from ${label}`, added.length ? 'success' : 'info')
      await refreshMcp()
    } catch (err) {
      reportError(err, `Couldn't import from ${label}.`)
    } finally {
      setImporting(null)
    }
  }

  return (
    <div className="max-w-[720px]">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
          Add connector
        </Button>
        <span className="ml-2 text-[12.5px] text-fg-3">Import from</span>
        {IMPORTS.map((i) => (
          <Button key={i.source} size="sm" icon={Download} onClick={() => void importFrom(i.source, i.label)} disabled={!!importing}>
            {importing === i.source ? 'Importing…' : i.label}
          </Button>
        ))}
      </div>
      <Recommended rows={rows} />
      {rows.length === 0 ? (
        <EmptyState icon={Plug} title="No connectors yet">
          Add an MCP server by form or JSON, or import the ones you already use in Claude, Codex or Cursor.
        </EmptyState>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <ServerRow key={r.server.id} row={r} onEdit={() => setEditing(r.server)} />
          ))}
        </ul>
      )}
      {editing && <McpEditor server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function ServerRow({ row, onEdit }: { row: McpRow; onEdit: () => void }) {
  const { server, status } = row
  const [open, setOpen] = useState(false)
  const info = statusInfo(status, server.enabled)
  const target = server.transport === 'stdio' ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ') : server.url

  const remove = async () => {
    const ok = await confirmDialog({ title: `Remove ${server.name}?`, body: 'Bots lose its tools. You can add it again later.', confirmLabel: 'Remove', danger: true })
    if (ok && (await run('mcp:delete', { id: server.id }, "Couldn't remove."))) void refreshMcp()
  }

  return (
    <li className="rounded-xl border border-line-soft">
      <div className="flex items-center gap-3 px-4 py-3">
        <StatusDot tone={info.tone} pulse={status.state === 'starting'} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13px] font-semibold text-fg">{server.name}</span>
            <Badge>{TRANSPORT_LABELS[server.transport]}</Badge>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-3" title={target}>
            {target}
          </div>
          <div className={clsx('mt-0.5 truncate text-[12px]', info.tone === 'danger' ? 'text-danger-fg' : 'text-fg-3')} title={info.text}>
            {info.text}
          </div>
        </div>
        <Toggle label={server.enabled ? `Turn off ${server.name}` : `Turn on ${server.name}`} checked={server.enabled} onChange={(enabled) => void saveServer(server, { enabled })} />
      </div>
      <div className="flex items-center gap-1 border-t border-line-soft px-3 py-1.5">
        <Button size="sm" variant="ghost" icon={open ? ChevronDown : ChevronRight} onClick={() => setOpen((v) => !v)}>
          Tools and instructions
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={RefreshCw}
          disabled={!server.enabled}
          onClick={() => void attempt('mcp:restart', { id: server.id }, "Couldn't restart.").then(() => refreshMcp())}
        >
          Restart
        </Button>
        <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit}>
          Edit
        </Button>
        <span className="flex-1" />
        <IconButton size="sm" icon={Trash} label={`Remove ${server.name}`} tone="danger" onClick={() => void remove()} />
      </div>
      {open && <ServerDetails server={server} ready={status.state === 'ready'} />}
    </li>
  )
}

function ServerDetails({ server, ready }: { server: McpServerConfig; ready: boolean }) {
  const version = useData((s) => s.versions.mcp)
  const tools = useAsync(() => invoke('mcp:tools', { id: server.id }), [server.id, version])
  const [instructions, setInstructions] = useState(server.customInstructions)
  useEffect(() => setInstructions(server.customInstructions), [server.customInstructions])

  const toggleTool = (name: string, on: boolean) => {
    const disabled = on ? server.disabledTools.filter((t) => t !== name) : [...new Set([...server.disabledTools, name])]
    if (tools.data) tools.setData(tools.data.map((t) => (t.name === name ? { ...t, disabled: !on } : t)))
    void saveServer(server, { disabledTools: disabled })
  }

  const list = tools.data ?? []
  const enabledCount = list.filter((t) => !t.disabled).length
  return (
    <div className="space-y-4 border-t border-line-soft px-4 py-3">
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-fg-2">
          Tools {list.length > 0 && <span className="font-normal text-fg-4">{enabledCount} of {list.length} enabled</span>}
          {tools.loading && <Spinner size={12} className="text-fg-4" />}
        </div>
        {tools.error ? (
          <p className="text-[12.5px] text-danger-fg">Couldn't load this connector's tools: {tools.error}</p>
        ) : list.length === 0 && !tools.loading ? (
          <p className="text-[12.5px] text-fg-3">{ready ? 'This server has no tools.' : 'Tools show up once the server has started.'}</p>
        ) : (
          <ul className="divide-y divide-line-soft rounded-lg border border-line-soft">
            {list.map((t) => (
              <li key={t.name} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className={clsx('block font-mono text-[12px] font-medium', t.disabled ? 'text-fg-3' : 'text-fg')}>{t.name}</span>
                  {t.description && <span className="block truncate text-[12px] text-fg-3">{t.description}</span>}
                </span>
                <Toggle size="sm" label={t.disabled ? `Enable ${t.name}` : `Disable ${t.name}`} checked={!t.disabled} onChange={(v) => toggleTool(t.name, v)} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div className="mb-1.5 text-[12.5px] font-medium text-fg-2">Custom instructions</div>
        <TextArea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onBlur={() => instructions !== server.customInstructions && void saveServer(server, { customInstructions: instructions })}
          rows={3}
          autoGrow
          placeholder={`Added to a bot's instructions when it has ${server.name}'s tools. For example: "Always search before creating an issue."`}
          aria-label="Custom instructions"
        />
      </div>
    </div>
  )
}
