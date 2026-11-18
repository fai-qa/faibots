// Tools grouped by where they run, each with Always / Ask / Never.
// Used per bot (overrides) and in Settings (global defaults).

import { RotateCcw } from 'lucide-react'
import type { Id, PermissionMode, ToolInfo } from '@shared/domain'
import { invoke } from '../../lib/bridge'
import { useData } from '../../store/data'
import { reportError } from '../../store/actions'
import { useAsync } from '../../lib/hooks'
import { PERMISSION_LABELS, TOOL_GROUP_LABELS, parseMcpName, toolIcon } from '../../lib/tools'
import { Spinner } from '../ui/Badge'
import { Segmented } from '../ui/Toggle'

const MODES: { value: PermissionMode; label: string }[] = (['always', 'ask', 'never'] as const).map((m) => ({ value: m, label: PERMISSION_LABELS[m] }))

export function ToolPermissionList({ botId, overrides }: { botId?: Id; overrides: Record<string, PermissionMode> }) {
  const mcpVersion = useData((s) => s.versions.mcp)
  const settingsPerms = useData((s) => s.settings?.toolPermissions)
  const tools = useAsync(() => invoke('tools:list', { botId }), [botId, mcpVersion, JSON.stringify(overrides), JSON.stringify(settingsPerms)])

  const set = async (tool: ToolInfo, mode: PermissionMode | null) => {
    // Show the change at once; the reload confirms it.
    if (tools.data) {
      tools.setData(tools.data.map((t) => (t.name === tool.name ? { ...t, effectivePermission: mode ?? t.defaultPermission } : t)))
    }
    try {
      await invoke('tools:set-permission', { toolName: tool.name, botId, mode })
    } catch (err) {
      reportError(err, "Couldn't change the permission.")
    }
    tools.reload()
  }

  if (!tools.data) {
    return (
      <div className="flex justify-center py-8 text-fg-3">
        {tools.error ? <span className="text-[12.5px] text-danger-fg">{tools.error}</span> : <Spinner />}
      </div>
    )
  }

  const groups = (['builtin', 'faibots', 'mcp'] as const)
    .map((source) => ({ source, items: tools.data!.filter((t) => t.source === source) }))
    .filter((g) => g.items.length)

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.source}>
          <h4 className="mb-1.5 text-[12px] font-semibold text-fg-3">{TOOL_GROUP_LABELS[g.source]}</h4>
          <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
            {g.items.map((t) => {
              const Icon = toolIcon(t.name)
              const overridden = t.name in overrides
              const mcp = parseMcpName(t.name)
              return (
                <li key={t.name} className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Icon size={14} className="shrink-0 text-fg-3" />
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-fg" title={t.name}>
                      {mcp ? (
                        <>
                          <span className="text-fg-3">{mcp.server}/</span>
                          {mcp.tool}
                        </>
                      ) : (
                        t.name
                      )}
                    </span>
                    {overridden && (
                      <button
                        type="button"
                        onClick={() => void set(t, null)}
                        title={botId ? 'Use the default from Settings' : 'Use the built-in default'}
                        aria-label={`Reset ${t.name} to default`}
                        className="rounded p-1 text-fg-4 hover:bg-hover hover:text-fg"
                      >
                        <RotateCcw size={12} />
                      </button>
                    )}
                    <Segmented<PermissionMode> label={`${t.name} permission`} size="sm" value={t.effectivePermission} options={MODES} onChange={(m) => void set(t, m)} />
                  </div>
                  <p className="mt-1 pl-[22px] text-[12px] leading-snug text-fg-3">
                    {t.description}
                    {t.autoAllowedInWorkspace && <span className="text-fg-2"> Always inside its workspace.</span>}
                    {!overridden && <span className="text-fg-4"> Default: {PERMISSION_LABELS[t.defaultPermission]}.</span>}
                  </p>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
