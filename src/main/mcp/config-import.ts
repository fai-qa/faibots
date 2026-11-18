// Parse other clients' MCP configs into our server shape. Pure functions over file text, so
// they are easy to test with fixtures. Shapes:
//   Claude Code  ~/.claude.json         { mcpServers: {…}, projects: { <path>: { mcpServers: {…} } } }
//   Cursor       ~/.cursor/mcp.json     { mcpServers: {…} }
//   Codex        ~/.codex/config.toml   [mcp_servers.<name>] command/args/env/url/http_headers/…
//   pasted JSON  { mcpServers: {…} }, { servers: {…} } (VS Code), a bare name→server map, or one server

import { parse as parseToml } from 'smol-toml'
import type { McpServerConfig, McpTransport } from '@shared/domain'

export type McpServerInput = Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const stringMap = (v: unknown): Record<string, string> =>
  isObject(v)
    ? Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => ['string', 'number', 'boolean'].includes(typeof x))
          .map(([k, x]) => [k, String(x)])
      )
    : {}
const optString = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const optNumber = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined)

const looksLikeServer = (v: unknown): v is Raw => isObject(v) && (typeof v['command'] === 'string' || typeof v['url'] === 'string')

function transportOf(raw: Raw): McpTransport | undefined {
  const type = typeof raw['type'] === 'string' ? raw['type'].toLowerCase() : ''
  if (type === 'stdio' || (!type && typeof raw['command'] === 'string')) return typeof raw['command'] === 'string' ? 'stdio' : undefined
  if (typeof raw['url'] !== 'string') return undefined
  if (type === 'sse') return 'sse'
  if (['http', 'streamable-http', 'streamablehttp', 'streamable_http'].includes(type)) return 'http'
  // No type: Cursor-style. A path ending in /sse is the old SSE transport; anything else tries
  // Streamable HTTP first (the host falls back to SSE if that fails).
  try {
    return /\/sse\/?$/i.test(new URL(raw['url']).pathname) ? 'sse' : 'http'
  } catch {
    return 'http'
  }
}

/** One server from the common mcpServers shape. Undefined when it has no usable transport. */
export function normalizeServer(name: string, raw: Raw): McpServerInput | undefined {
  const transport = transportOf(raw)
  const cleanName = name.trim()
  if (!transport || !cleanName) return undefined
  const base = {
    name: cleanName,
    transport,
    enabled: raw['disabled'] !== true && raw['enabled'] !== false,
    disabledTools: strings(raw['disabledTools'] ?? raw['disabled_tools']),
    customInstructions: ''
  }
  if (transport === 'stdio') {
    const cwd = optString(raw['cwd'])
    const startupTimeoutSec = optNumber(raw['startupTimeoutSec'] ?? raw['startup_timeout_sec'])
    return {
      ...base,
      command: String(raw['command']).trim(),
      args: strings(raw['args']),
      env: stringMap(raw['env']),
      ...(cwd && { cwd }),
      ...(startupTimeoutSec && { startupTimeoutSec })
    }
  }
  return { ...base, url: String(raw['url']).trim(), headers: stringMap(raw['headers']) }
}

function fromServerMap(map: unknown): McpServerInput[] {
  if (!isObject(map)) return []
  return Object.entries(map)
    .map(([name, raw]) => (isObject(raw) ? normalizeServer(name, raw) : undefined))
    .filter((s): s is McpServerInput => !!s)
}

/** A name for a pasted server that has none: the package (npx foo-mcp) or the URL host. */
function guessName(raw: Raw): string {
  if (typeof raw['url'] === 'string') {
    try {
      return new URL(raw['url']).hostname.replace(/^(www|mcp)\./, '').split('.')[0] || 'server'
    } catch {
      return 'server'
    }
  }
  const pkg = strings(raw['args']).find((a) => !a.startsWith('-')) ?? String(raw['command'])
  return pkg.replace(/@[^@/]*$/, '').split(/[\\/]/).pop()?.replace(/\.(m?js|py|exe)$/, '') || 'server'
}

function parseJsonText(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function parseMcpJson(text: string): McpServerInput[] {
  const data = parseJsonText(text, 'The pasted config')
  if (!isObject(data)) throw new Error('Paste a JSON object, e.g. {"mcpServers": {"name": {"command": "…"}}}')
  let servers: McpServerInput[]
  if (isObject(data['mcpServers'])) servers = fromServerMap(data['mcpServers'])
  else if (isObject(data['servers'])) servers = fromServerMap(data['servers'])
  else if (looksLikeServer(data)) {
    const one = normalizeServer(optString(data['name']) ?? guessName(data), data)
    servers = one ? [one] : []
  } else servers = fromServerMap(data)
  if (servers.length === 0) throw new Error('No MCP servers found: each needs a "command" (stdio) or a "url" (HTTP/SSE)')
  return servers
}

export function parseClaudeConfig(text: string): McpServerInput[] {
  const data = parseJsonText(text, '~/.claude.json')
  if (!isObject(data)) return []
  const servers = fromServerMap(data['mcpServers'])
  // Project-scoped servers too; the first definition of a name wins.
  if (isObject(data['projects'])) {
    for (const project of Object.values(data['projects'])) {
      if (isObject(project)) servers.push(...fromServerMap(project['mcpServers']))
    }
  }
  return dedupe(servers)
}

export function parseCursorConfig(text: string): McpServerInput[] {
  const data = parseJsonText(text, '~/.cursor/mcp.json')
  return isObject(data) ? fromServerMap(data['mcpServers']) : []
}

export function parseCodexConfig(text: string): McpServerInput[] {
  let data: Raw
  try {
    data = parseToml(text) as Raw
  } catch (err) {
    throw new Error(`~/.codex/config.toml is not valid TOML: ${err instanceof Error ? err.message : String(err)}`)
  }
  const table = data['mcp_servers']
  if (!isObject(table)) return []
  const out: McpServerInput[] = []
  for (const [name, raw] of Object.entries(table)) {
    if (!isObject(raw)) continue
    const env = stringMap(raw['env'])
    // env_vars lists variables to pass through from the user's environment.
    for (const v of strings(raw['env_vars'])) env[v] ??= `\${${v}}`
    const headers = stringMap(raw['http_headers'])
    for (const [header, envVar] of Object.entries(stringMap(raw['env_http_headers']))) headers[header] = `\${${envVar}}`
    const bearer = optString(raw['bearer_token_env_var'])
    if (bearer) headers['Authorization'] = `Bearer \${${bearer}}`
    const sec = raw['startup_timeout_sec']
    const ms = raw['startup_timeout_ms']
    const server = normalizeServer(name, {
      ...raw,
      env,
      headers,
      type: typeof raw['url'] === 'string' ? 'http' : 'stdio',
      startupTimeoutSec: typeof sec === 'number' ? sec : typeof ms === 'number' ? ms / 1000 : undefined
    })
    if (server) out.push(server)
  }
  return out
}

function dedupe(servers: McpServerInput[]): McpServerInput[] {
  const seen = new Set<string>()
  return servers.filter((s) => {
    const key = s.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Expand ${VAR}, ${VAR:-default} and ${env:VAR} (Claude Code / Cursor syntax) from the given
 * environment, so tokens can stay in the user's environment instead of our config.
 */
export function expandEnv(value: string, env: Record<string, string | undefined> = process.env): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) =>
    env[name] ?? fallback ?? '')
}
