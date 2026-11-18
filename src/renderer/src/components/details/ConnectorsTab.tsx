// Which MCP connectors a bot may use.

import { Plug, Settings2 } from 'lucide-react'
import type { Bot, McpServerStatus } from '@shared/domain'
import { useData } from '../../store/data'
import { useUi } from '../../store/ui'
import { updateBot } from '../../store/actions'
import { EmptyState, StatusDot } from '../ui/Badge'
import { Button } from '../ui/Button'
import { SettingRow, Toggle } from '../ui/Toggle'

export function statusInfo(status: McpServerStatus, enabled: boolean): { tone: 'success' | 'warn' | 'danger' | 'neutral'; text: string } {
  if (!enabled) return { tone: 'neutral', text: 'Turned off' }
  switch (status.state) {
    case 'ready':
      return { tone: 'success', text: `Connected, ${status.toolCount} ${status.toolCount === 1 ? 'tool' : 'tools'}` }
    case 'starting':
      return { tone: 'warn', text: 'Connecting…' }
    case 'error':
      return { tone: 'danger', text: status.message }
    case 'stopped':
      return { tone: 'neutral', text: 'Starts when a bot needs it' }
  }
}

export function ConnectorsTab({ bot }: { bot: Bot }) {
  const rows = useData((s) => s.mcp)
  const all = bot.mcpServerIds === 'all'
  const chosen = new Set(all ? rows.map((r) => r.server.id) : bot.mcpServerIds)
  const openSettings = () => useUi.setState({ settingsSection: 'connectors' })

  const toggle = (id: string, on: boolean) => {
    const current = all ? rows.map((r) => r.server.id) : (bot.mcpServerIds as string[])
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id)
    void updateBot(bot.id, { mcpServerIds: next })
  }

  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState icon={Plug} title="No connectors yet" action={<Button onClick={openSettings}>Add a connector</Button>}>
          Connectors (MCP servers) give bots tools like GitHub, Notion or your file system.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div className="rounded-xl border border-line-soft px-3">
        <SettingRow title="Every enabled connector" description={`${bot.name} also gets connectors you add later.`}>
          <Toggle label="Every enabled connector" checked={all} onChange={(v) => void updateBot(bot.id, { mcpServerIds: v ? 'all' : rows.map((r) => r.server.id) })} />
        </SettingRow>
      </div>
      <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
        {rows.map(({ server, status }) => {
          const info = statusInfo(status, server.enabled)
          return (
            <li key={server.id} className="flex items-center gap-3 px-3 py-2.5">
              <StatusDot tone={info.tone} pulse={status.state === 'starting'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui font-medium text-fg">{server.name}</span>
                <span className="block truncate text-[12px] text-fg-3" title={info.text}>
                  {info.text}
                </span>
              </span>
              <Toggle label={`Let ${bot.name} use ${server.name}`} checked={chosen.has(server.id)} disabled={all} onChange={(v) => toggle(server.id, v)} />
            </li>
          )
        })}
      </ul>
      <Button size="sm" icon={Settings2} onClick={openSettings}>
        Manage connectors
      </Button>
    </div>
  )
}
