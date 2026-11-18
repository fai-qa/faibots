import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { z } from 'zod'
import type { SecretVault } from '../../contracts'
import { defineTool, errorResult, textResult } from '../define'
import { resolveToolPath } from '../paths'

const DEFAULT_TIMEOUT_SEC = 120
const MAX_TIMEOUT_SEC = 1800
/** Per stream; the registry cuts results to 30k characters anyway. */
const CAPTURE_CHARS = 200_000

/**
 * How a command is run. Windows: Windows PowerShell with UTF-8 output and no progress bars (they
 * arrive as noise on stderr). Elsewhere: a login bash so the user's PATH is set up.
 */
export function shellInvocation(command: string, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform === 'win32') {
    const prelude =
      "$ProgressPreference = 'SilentlyContinue'; " +
      'try { $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}; '
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prelude + command] }
  }
  return { file: 'bash', args: ['-lc', command] }
}

/** Keeps the first and the last part of a long stream. */
class Capture {
  private head = ''
  private tail = ''
  private dropped = 0
  private readonly decoder = new StringDecoder('utf8')

  push(chunk: Buffer): void {
    this.add(this.decoder.write(chunk))
  }

  text(): string {
    this.add(this.decoder.end())
    return this.dropped > 0 ? `${this.head}\n[… ${this.dropped} characters omitted …]\n${this.tail}` : this.head + this.tail
  }

  private add(text: string): void {
    if (!text) return
    const room = CAPTURE_CHARS - this.head.length
    if (room > 0) {
      this.head += text.slice(0, room)
      text = text.slice(room)
    }
    if (!text) return
    this.tail += text
    if (this.tail.length > CAPTURE_CHARS) {
      this.dropped += this.tail.length - CAPTURE_CHARS
      this.tail = this.tail.slice(-CAPTURE_CHARS)
    }
  }
}

/** Stop a command and everything it started. */
function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {})
    return
  }
  try {
    process.kill(-pid, 'SIGTERM') // the child leads its own process group (detached)
    setTimeout(() => {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }, 2000).unref()
  } catch {
    // already gone
  }
}

export interface ShellRun {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
}

export function runShell(opts: {
  command: string
  cwd: string
  env: Record<string, string | undefined>
  timeoutMs: number
  signal: AbortSignal
}): Promise<ShellRun> {
  const { file, args } = shellInvocation(opts.command)
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    })
    const stdout = new Capture()
    const stderr = new Capture()
    let timedOut = false
    let cancelled = false
    child.stdout.on('data', (c: Buffer) => stdout.push(c))
    child.stderr.on('data', (c: Buffer) => stderr.push(c))

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, opts.timeoutMs)
    const onAbort = () => {
      cancelled = true
      killTree(child.pid)
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    const done = () => {
      clearTimeout(timer)
      opts.signal.removeEventListener('abort', onAbort)
    }
    child.on('error', (err) => {
      done()
      reject(err)
    })
    child.on('close', (code) => {
      done()
      resolve({ exitCode: code, stdout: stdout.text(), stderr: stderr.text(), timedOut, cancelled })
    })
  })
}

export function formatShellRun(run: ShellRun, timeoutSec: number): string {
  const parts: string[] = []
  if (run.cancelled) parts.push('Cancelled; the command was stopped.')
  else if (run.timedOut) parts.push(`Timed out after ${timeoutSec} s; the command was stopped.`)
  parts.push(`Exit code: ${run.exitCode ?? 'none'}`)
  if (run.stdout.trim()) parts.push(run.stdout.trimEnd())
  if (run.stderr.trim()) parts.push(`--- stderr ---\n${run.stderr.trimEnd()}`)
  if (!run.stdout.trim() && !run.stderr.trim()) parts.push('(no output)')
  return parts.join('\n')
}

export function shellTool(deps: { secrets: Pick<SecretVault, 'envForBot'>; homeDir: string }) {
  const shellName = process.platform === 'win32' ? 'Windows PowerShell' : 'bash'
  return defineTool({
    name: 'shell',
    description:
      `Run a command in ${shellName} on the user's computer and get its exit code and output. ` +
      'It starts in your workspace folder unless you pass cwd. Commands cannot read from stdin. ' +
      "Your secrets are available as environment variables. Prefer read_file/list_dir for looking at files.",
    schema: z.object({
      command: z.string().min(1).describe(`The ${shellName} command to run`),
      cwd: z.string().optional().describe('Working folder; relative paths start at your workspace'),
      timeoutSec: z.number().int().min(1).max(MAX_TIMEOUT_SEC).optional()
        .describe(`Stop the command after this many seconds (default ${DEFAULT_TIMEOUT_SEC})`)
    }),
    source: 'builtin',
    defaultPermission: 'ask',
    activityLabel: 'Running a command',
    summarize: (input, ctx) => {
      const cwd = input.cwd ? resolveToolPath(input.cwd, ctx.workspaceDir, deps.homeDir) : ctx.workspaceDir
      const command = input.command.length > 2000 ? `${input.command.slice(0, 2000)}…` : input.command
      return `Run \`${command}\` in ${cwd}`
    },
    async execute(input, ctx) {
      const cwd = input.cwd ? resolveToolPath(input.cwd, ctx.workspaceDir, deps.homeDir) : ctx.workspaceDir
      if (cwd === ctx.workspaceDir) mkdirSync(cwd, { recursive: true })
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return errorResult(`The folder ${cwd} does not exist.`)
      const timeoutSec = input.timeoutSec ?? DEFAULT_TIMEOUT_SEC
      const run = await runShell({
        command: input.command,
        cwd,
        env: { ...process.env, ...deps.secrets.envForBot(ctx.bot.id) },
        timeoutMs: timeoutSec * 1000,
        signal: ctx.signal
      })
      const result = textResult(formatShellRun(run, timeoutSec))
      return run.exitCode === 0 && !run.timedOut && !run.cancelled ? result : { ...result, isError: true }
    }
  })
}
