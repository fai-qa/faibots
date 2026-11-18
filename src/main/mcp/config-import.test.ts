import { describe, expect, it } from 'vitest'
import {
  expandEnv, normalizeServer, parseClaudeConfig, parseCodexConfig, parseCursorConfig, parseMcpJson
} from './config-import'

describe('MCP config import', () => {
  it('reads Claude Code config, including project servers, first name wins', () => {
    const servers = parseClaudeConfig(JSON.stringify({
      numStartups: 5,
      mcpServers: {
        github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
        linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } },
        old: { type: 'sse', url: 'https://old.example.com/sse' }
      },
      projects: {
        'C:\\work\\app': { mcpServers: { db: { command: 'uvx', args: ['mcp-db'] }, github: { command: 'other' } } },
        '/home/me/x': { allowedTools: [] }
      }
    }))
    expect(servers.map((s) => [s.name, s.transport])).toEqual([
      ['github', 'stdio'], ['linear', 'http'], ['old', 'sse'], ['db', 'stdio']
    ])
    expect(servers[0]).toEqual({
      name: 'github', transport: 'stdio', enabled: true, disabledTools: [], customInstructions: '',
      command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' }
    })
    expect(servers[1]).toMatchObject({ url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer x' } })
  })

  it('reads Cursor config: url without type, /sse means SSE, disabled servers stay disabled', () => {
    const servers = parseCursorConfig(JSON.stringify({
      mcpServers: {
        remote: { url: 'https://api.example.com/mcp' },
        legacy: { url: 'https://api.example.com/sse/' },
        local: { command: 'node', args: ['server.js'], disabled: true },
        broken: { args: ['no command'] }
      }
    }))
    expect(servers.map((s) => [s.name, s.transport, s.enabled])).toEqual([
      ['remote', 'http', true], ['legacy', 'sse', true], ['local', 'stdio', false]
    ])
  })

  it('reads Codex TOML: env, headers, bearer token env var, timeouts, enabled', () => {
    const servers = parseCodexConfig(`
model = "gpt-5"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
env = { API_KEY = "k", RETRIES = 3 }
env_vars = ["HOME_TOKEN"]
startup_timeout_sec = 20
disabled_tools = ["delete_all"]

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_TOKEN"
http_headers = { "X-Team" = "design" }

[mcp_servers.off]
command = "off-server"
enabled = false
`)
    expect(servers).toEqual([
      {
        name: 'docs', transport: 'stdio', enabled: true, disabledTools: ['delete_all'], customInstructions: '',
        command: 'npx', args: ['-y', 'docs-mcp'], env: { API_KEY: 'k', RETRIES: '3', HOME_TOKEN: '${HOME_TOKEN}' },
        startupTimeoutSec: 20
      },
      {
        name: 'figma', transport: 'http', enabled: true, disabledTools: [], customInstructions: '',
        url: 'https://mcp.figma.com/mcp', headers: { 'X-Team': 'design', Authorization: 'Bearer ${FIGMA_TOKEN}' }
      },
      { name: 'off', transport: 'stdio', enabled: false, disabledTools: [], customInstructions: '', command: 'off-server', args: [], env: {} }
    ])
    expect(() => parseCodexConfig('not = [valid')).toThrow(/TOML/)
    expect(parseCodexConfig('model = "x"')).toEqual([])
  })

  it('accepts pasted JSON in every common shape', () => {
    expect(parseMcpJson('{"mcpServers":{"a":{"command":"x"}}}').map((s) => s.name)).toEqual(['a'])
    expect(parseMcpJson('{"servers":{"vs":{"type":"http","url":"https://h/mcp"}}}').map((s) => s.name)).toEqual(['vs'])
    expect(parseMcpJson('{"one":{"command":"x"},"two":{"url":"https://h/mcp"}}').map((s) => s.name)).toEqual(['one', 'two'])
    expect(parseMcpJson('{"command":"npx","args":["-y","@acme/weather-mcp@1.2.0"]}')[0]!.name).toBe('weather-mcp')
    expect(parseMcpJson('{"url":"https://mcp.notion.com/mcp"}')[0]!.name).toBe('notion')
    expect(parseMcpJson('{"name":"mine","command":"x"}')[0]!.name).toBe('mine')
    expect(() => parseMcpJson('{oops')).toThrow(/not valid JSON/)
    expect(() => parseMcpJson('[]')).toThrow(/JSON object/)
    expect(() => parseMcpJson('{"mcpServers":{}}')).toThrow(/No MCP servers/)
  })

  it('normalizes values to strings and drops junk', () => {
    expect(normalizeServer('x', { command: 'c', args: ['a', 1, null], env: { N: 1, B: true, O: { no: 1 } } })).toMatchObject({
      args: ['a'], env: { N: '1', B: 'true' }
    })
    expect(normalizeServer('  ', { command: 'c' })).toBeUndefined()
    expect(normalizeServer('x', { type: 'http' })).toBeUndefined()
  })

  it('expands ${VAR}, ${VAR:-default} and ${env:VAR}', () => {
    const env = { TOKEN: 'abc', EMPTY: undefined }
    expect(expandEnv('Bearer ${TOKEN}', env)).toBe('Bearer abc')
    expect(expandEnv('${env:TOKEN}-${MISSING:-fallback}-${EMPTY}', env)).toBe('abc-fallback-')
    expect(expandEnv('no vars $HOME', env)).toBe('no vars $HOME')
  })
})
