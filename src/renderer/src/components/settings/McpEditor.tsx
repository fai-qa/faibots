// Add or edit an MCP server, by form or by pasting mcpServers JSON.

import { useState } from 'react'
import type { McpServerConfig, McpTransport } from '@shared/domain'
import { errorMessage, invoke } from '../../lib/bridge'
import { refreshMcp } from '../../store/actions'
import { toast } from '../../store/ui'
import { plural } from '../../lib/format'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextArea, TextInput } from '../ui/Field'
import { Segmented } from '../ui/Toggle'

const JSON_EXAMPLE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\you\\\\Documents"]
    }
  }
}`

function toLines(map: Record<string, string> | undefined, sep: string): string {
  return Object.entries(map ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')
}

function fromLines(text: string, sep: RegExp): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = sep.exec(line)
    if (!m || m.index === 0) continue
    out[line.slice(0, m.index).trim()] = line.slice(m.index + m[0].length).trim()
  }
  return Object.keys(out).length ? out : undefined
}

export function McpEditor({ server, onClose }: { server: McpServerConfig | null; onClose: () => void }) {
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'stdio')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState((server?.args ?? []).join('\n'))
  const [env, setEnv] = useState(toLines(server?.env, '='))
  const [cwd, setCwd] = useState(server?.cwd ?? '')
  const [url, setUrl] = useState(server?.url ?? '')
  const [headers, setHeaders] = useState(toLines(server?.headers, ': '))
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      if (mode === 'json') {
        if (!json.trim()) throw new Error('Enter valid JSON')
        const added = await invoke('mcp:import', { source: 'json', json })
        toast(`Added ${plural(added.length, 'connector')}`, 'success')
      } else {
        if (!name.trim()) throw new Error('The server name cannot be blank')
        if (transport === 'stdio' ? !command.trim() : !url.trim()) throw new Error('The server needs a URL or a command')
        await invoke('mcp:save', {
          id: server?.id,
          name: name.trim(),
          transport,
          ...(transport === 'stdio'
            ? {
                command: command.trim(),
                args: args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean),
                env: fromLines(env, /=/),
                cwd: cwd.trim() || undefined
              }
            : { url: url.trim(), headers: fromLines(headers, /:\s?/) }),
          enabled: server?.enabled ?? true,
          disabledTools: server?.disabledTools ?? [],
          customInstructions: server?.customInstructions ?? '',
          startupTimeoutSec: server?.startupTimeoutSec
        })
        toast(server ? `Saved ${name.trim()}` : `Added ${name.trim()}`, 'success')
      }
      await refreshMcp()
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={server ? `Edit ${server.name}` : 'Add a connector'}
      description="Any MCP server: a command that runs on this computer, or a remote HTTP server."
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : server ? 'Save' : 'Add connector'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!server && (
          <Segmented
            label="Editor"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'form', label: 'Form' },
              { value: 'json', label: 'JSON' }
            ]}
          />
        )}
        {mode === 'json' ? (
          <Field label="MCP server JSON" hint='Paste an "mcpServers" object from Claude, Cursor or another client.'>
            <TextArea value={json} onChange={(e) => setJson(e.target.value)} mono rows={12} placeholder={JSON_EXAMPLE} data-autofocus />
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Name">
                <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="github" mono data-autofocus />
              </Field>
              <Segmented<McpTransport>
                label="Type"
                value={transport}
                onChange={setTransport}
                options={[
                  { value: 'stdio', label: 'Command' },
                  { value: 'http', label: 'Remote HTTP' },
                  { value: 'sse', label: 'SSE' }
                ]}
              />
            </div>
            {transport === 'stdio' ? (
              <>
                <Field label="Command">
                  <TextInput value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" mono />
                </Field>
                <Field label="Arguments" hint="One per line.">
                  <TextArea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} mono placeholder={'-y\n@modelcontextprotocol/server-filesystem'} />
                </Field>
                <Field label="Variables" hint="One KEY=value per line. ${NAME} is read from your environment when the server starts.">
                  <TextArea value={env} onChange={(e) => setEnv(e.target.value)} rows={2} mono placeholder="API_TOKEN=${MY_TOKEN}" />
                </Field>
                <Field label="Working folder (optional)">
                  <TextInput value={cwd} onChange={(e) => setCwd(e.target.value)} mono />
                </Field>
              </>
            ) : (
              <>
                <Field label="Server URL">
                  <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" mono />
                </Field>
                <Field label="HTTP headers" hint="One Key: value per line. ${NAME} is read from your environment.">
                  <TextArea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} mono placeholder="Authorization: Bearer ${GITHUB_TOKEN}" />
                </Field>
              </>
            )}
          </>
        )}
        {error && <p className="text-[12.5px] text-danger-fg">{error}</p>}
      </div>
    </Dialog>
  )
}
