// Helpers for the two subscription engines: Claude Code (the user's Claude Code login, through the
// Claude Agent SDK) and Codex (the user's ChatGPT login, through the Codex SDK).
//
// Billing safety: these child processes would otherwise inherit ANTHROPIC_API_KEY / OPENAI_API_KEY
// from the environment and quietly bill an API account instead of the subscription the UI shows.
// We remove those variables; Codex only gets a key when the user stored one for that provider.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import type { AccountInfo, ModelInfo as ClaudeCodeModel, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BillingRoute, ModelInfo } from '@shared/domain'

const CLAUDE_CODE_DROPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
const CODEX_DROPPED_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY']

function copyEnv(drop: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  const dropped = new Set(drop.map((k) => k.toUpperCase()))
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || dropped.has(key.toUpperCase())) continue
    env[key] = value
  }
  return env
}

/**
 * Environment for a Claude Code process: inherited, minus Anthropic API credentials, and with
 * Claude Code's non-essential traffic (telemetry, error reports, update checks) switched off, so
 * a bot's turn talks to the model and the user's connectors only.
 */
export function claudeCodeEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...copyEnv(CLAUDE_CODE_DROPPED_ENV),
    CLAUDE_AGENT_SDK_CLIENT_APP: 'faibots/0.1.0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...extra
  }
}

/** Environment for a Codex process: inherited, minus OpenAI/Codex API keys (the SDK adds a stored one). */
export function codexEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { ...copyEnv(CODEX_DROPPED_ENV), ...extra }
}

export interface ClaudeCodeStatus {
  ok: boolean
  billing: BillingRoute
  message: string
  models: ClaudeCodeModel[]
}

/** How a Claude Code login is billed. */
export function claudeCodeBilling(account: AccountInfo): { billing: BillingRoute; signedIn: boolean; plan?: string } {
  if (account.apiProvider && account.apiProvider !== 'firstParty') {
    return { billing: 'api-key', signedIn: true, plan: account.apiProvider }
  }
  if (account.apiKeySource && account.apiKeySource !== 'none') return { billing: 'api-key', signedIn: true }
  if (account.subscriptionType) return { billing: 'subscription', signedIn: true, plan: account.subscriptionType }
  if (account.email || account.tokenSource) return { billing: 'subscription', signedIn: true }
  return { billing: 'unknown', signedIn: false }
}

/**
 * Start Claude Code without sending a prompt and ask it who is signed in and which models it
 * offers. No model call is made, so this costs nothing.
 */
export async function probeClaudeCode(opts: { cwd: string; timeoutMs?: number }): Promise<ClaudeCodeStatus> {
  // Loaded on demand: the Agent SDK is large and most sessions never test Claude Code.
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const abortController = new AbortController()
  let release: () => void = () => {}
  const idle = new Promise<void>((resolve) => {
    release = resolve
  })
  // A prompt stream that never yields keeps the session open for control requests only.
  async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
    await idle
  }
  const q = query({
    prompt: noPrompt(),
    options: {
      cwd: opts.cwd,
      env: claudeCodeEnv(),
      settingSources: [],
      persistSession: false,
      abortController,
      ...claudeCodePathOption()
    }
  })
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? 30_000)
  try {
    const account = await q.accountInfo()
    const models = await q.supportedModels().catch(() => [] as ClaudeCodeModel[])
    const { billing, signedIn, plan } = claudeCodeBilling(account)
    if (!signedIn) {
      return { ok: false, billing, models, message: 'Claude Code is not signed in. Run `claude` in a terminal, log in, then test again.' }
    }
    const who = account.email ? ` as ${account.email}` : ''
    const route =
      billing === 'subscription'
        ? `uses your ${plan ? `${plan} ` : ''}subscription`
        : `bills ${plan ?? 'an API key'} (not a subscription)`
    return { ok: true, billing, models, message: `Claude Code is signed in${who} and ${route}.` }
  } catch (err) {
    const reason = abortController.signal.aborted ? 'it did not answer in time' : err instanceof Error ? err.message : String(err)
    return { ok: false, billing: 'unknown', models: [], message: `Could not start Claude Code: ${reason}` }
  } finally {
    clearTimeout(timer)
    release()
    try {
      q.close()
    } catch {
      // already closed
    }
  }
}

/**
 * In the installed app, node_modules live inside `app.asar`, an archive that Electron can read
 * from but Windows cannot start programs from. The installer keeps the engine binaries beside it
 * in `app.asar.unpacked` (see electron-builder.yml), so programs we spawn must use that path.
 * Running from source there is no archive and the path comes back unchanged.
 */
export function unpackedPath(path: string): string {
  return path.replace(/([\\/])app\.asar(?=[\\/])/, '$1app.asar.unpacked')
}

/**
 * Claude Code's native binary, for the installed app only. The Agent SDK finds it by itself, but
 * inside `app.asar`; this returns the unpacked copy. From source it returns undefined and the SDK
 * keeps its own lookup.
 */
export function claudeCodeExecutable(): string | undefined {
  const exe = `claude${process.platform === 'win32' ? '.exe' : ''}`
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  try {
    const sdkRequire = createRequire(createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'))
    for (const pkg of process.platform === 'linux' ? [base, `${base}-musl`] : [base]) {
      let bin: string
      try {
        bin = sdkRequire.resolve(`${pkg}/${exe}`)
      } catch {
        continue
      }
      const unpacked = unpackedPath(bin)
      if (unpacked !== bin && isFile(unpacked)) return unpacked
    }
  } catch {
    return undefined
  }
  return undefined
}

/** `pathToClaudeCodeExecutable` for the Agent SDK's options when the binary is unpacked; else nothing. */
export function claudeCodePathOption(): { pathToClaudeCodeExecutable?: string } {
  const path = claudeCodeExecutable()
  return path ? { pathToClaudeCodeExecutable: path } : {}
}

// Same lookup the Codex SDK does, so `codex login status` runs the binary the SDK will use.
const CODEX_PACKAGES: Record<string, string> = {
  'linux-x64': '@openai/codex-linux-x64',
  'linux-arm64': '@openai/codex-linux-arm64',
  'darwin-x64': '@openai/codex-darwin-x64',
  'darwin-arm64': '@openai/codex-darwin-arm64',
  'win32-x64': '@openai/codex-win32-x64',
  'win32-arm64': '@openai/codex-win32-arm64'
}
const CODEX_TRIPLES: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc'
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function findCodexBinary(): { path: string; pathDirs: string[] } | undefined {
  const localBinary = process.env['FAIBOTS_CODEX_BINARY']
  if (localBinary && isAbsolute(localBinary) && isFile(localBinary)) {
    const helpers = join(dirname(dirname(localBinary)), 'codex-path')
    return { path: localBinary, pathDirs: existsSync(helpers) ? [helpers] : [] }
  }
  const key = `${process.platform}-${process.arch}`
  const pkg = CODEX_PACKAGES[key]
  const triple = CODEX_TRIPLES[key]
  if (!pkg || !triple) return undefined
  try {
    const require = createRequire(import.meta.url)
    const codexRequire = createRequire(require.resolve('@openai/codex/package.json'))
    const root = join(dirname(codexRequire.resolve(`${pkg}/package.json`)), 'vendor', triple)
    const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
    for (const [bin, pathDir] of [[join(root, 'bin', exe), join(root, 'codex-path')], [join(root, 'codex', exe), join(root, 'path')]] as const) {
      if (isFile(bin)) return { path: unpackedPath(bin), pathDirs: existsSync(pathDir) ? [unpackedPath(pathDir)] : [] }
    }
  } catch {
    return undefined
  }
  return undefined
}

export interface CodexStatus {
  ok: boolean
  billing: BillingRoute
  message: string
}

/** Read `codex login status` output without echoing it (it can show a masked key). */
export function parseCodexLoginStatus(exitCode: number | null, output: string, hasStoredKey: boolean): CodexStatus {
  if (hasStoredKey) {
    return { ok: true, billing: 'api-key', message: 'Codex will use the API key stored for this provider (billed per token).' }
  }
  if (exitCode === 0 && /chatgpt/i.test(output)) {
    return { ok: true, billing: 'subscription', message: 'Codex is signed in with ChatGPT and uses your ChatGPT plan.' }
  }
  if (exitCode === 0 && /api key/i.test(output)) {
    return { ok: true, billing: 'api-key', message: 'Codex is signed in with an API key (billed per token), not a ChatGPT plan.' }
  }
  if (exitCode === 0 && /logged in/i.test(output) && !/not logged in/i.test(output)) {
    return { ok: true, billing: 'unknown', message: 'Codex is signed in.' }
  }
  return { ok: false, billing: 'unknown', message: 'Codex is not signed in. Run `codex login` in a terminal, then test again.' }
}

/** Put Codex's helper folder (it holds `rg`) first on PATH, as the SDK does when it finds Codex itself. */
export function withPathDirs(env: Record<string, string>, pathDirs: string[]): Record<string, string> {
  if (!pathDirs.length) return env
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
  env[pathKey] = [...pathDirs, env[pathKey] ?? ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
  return env
}

export async function probeCodex(opts: { hasStoredKey: boolean; timeoutMs?: number }): Promise<CodexStatus> {
  const bin = findCodexBinary()
  if (!bin) return { ok: false, billing: 'unknown', message: 'The Codex CLI that ships with faibots was not found for this computer.' }
  const env = withPathDirs(codexEnv(), bin.pathDirs)
  return new Promise<CodexStatus>((resolve) => {
    let output = ''
    const child = spawn(bin.path, ['login', 'status'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15_000)
    child.stdout.on('data', (d: Buffer) => (output += d.toString()))
    child.stderr.on('data', (d: Buffer) => (output += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, billing: 'unknown', message: `Could not run Codex: ${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(parseCodexLoginStatus(code, output, opts.hasStoredKey))
    })
  })
}

/** Read only selectable model identities from the bundled CLI's account catalog. */
export async function listCodexModels(): Promise<ModelInfo[]> {
  const bin = findCodexBinary()
  if (!bin) return []
  try {
    const { stdout } = await promisify(execFile)(bin.path, ['debug', 'models'], {
      env: withPathDirs(codexEnv(), bin.pathDirs), windowsHide: true, timeout: 12_000, maxBuffer: 6 * 1024 * 1024,
      encoding: 'utf8'
    })
    const data = JSON.parse(stdout) as { models?: { slug?: string; display_name?: string; visibility?: string }[] }
    return (data.models ?? []).flatMap((model) => model.visibility === 'list' && typeof model.slug === 'string' && model.slug
      ? [{ id: model.slug, label: typeof model.display_name === 'string' ? model.display_name : model.slug, supportsTools: true }] : [])
  } catch {
    // Older or offline CLIs can still use a manually selected model or their configured default.
    return []
  }
}
