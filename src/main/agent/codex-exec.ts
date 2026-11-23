import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { CodexOptions, Input, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { CodexLike, ThreadLike } from './codex-engine'

// The locked SDK does not expose exec's --ignore-user-config switch. Use the published
// JSONL interface so the CLI owns login, sandboxing, managed policy and thread storage.
export function createScopedCodex(options: CodexOptions): CodexLike {
  const thread = (settings: ThreadOptions = {}, id?: string): ThreadLike => ({
    runStreamed: async (input, turn) => ({ events: run(options, settings, input, id, turn?.signal) })
  })
  return { startThread: (settings) => thread(settings), resumeThread: (id, settings) => thread(settings, id) }
}

async function* run(options: CodexOptions, settings: ThreadOptions, input: Input, id?: string, signal?: AbortSignal): AsyncGenerator<ThreadEvent> {
  if (!options.codexPathOverride) throw new Error('The bundled Codex CLI is missing. Reinstall faibots and test the Codex connection.')
  const args = ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check']
  for (const setting of options.configOverrides ?? []) args.push('--config', setting)
  if (options.baseUrl) args.push('--config', `openai_base_url=${JSON.stringify(options.baseUrl)}`)
  if (settings.workingDirectory) args.push('--cd', settings.workingDirectory)
  if (settings.model) args.push('--model', settings.model)
  if (settings.sandboxMode) args.push('--sandbox', settings.sandboxMode)
  if (settings.modelReasoningEffort) args.push('--config', `model_reasoning_effort=${JSON.stringify(settings.modelReasoningEffort)}`)
  if (settings.approvalPolicy) args.push('--config', `approval_policy=${JSON.stringify(settings.approvalPolicy)}`)
  if (id) args.push('resume', id)
  const parts = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : input
  for (const part of parts) if (part.type === 'local_image') args.push('--image', part.path)
  const prompt = parts.filter(part => part.type === 'text').map(part => part.text).join('\n\n')

  const env = { ...options.env }
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE ??= 'codex_sdk_ts'
  if (options.apiKey) env.CODEX_API_KEY = options.apiKey
  // A child launched inside a desktop coding client is a separate app session.
  delete env.CODEX_APP_TOOLS_PIPE_PATH
  delete env.CODEX_APP_RUNTIME_CLI_PATH
  const child = spawn(options.codexPathOverride, args, { env, signal, windowsHide: true, stdio: 'pipe' })
  let diagnostic = ''
  child.stderr.setEncoding('utf8').on('data', (text: string) => { diagnostic = (diagnostic + text).slice(-4096) })
  let spawnError: Error | undefined
  child.once('error', error => { spawnError = error })
  const closed = new Promise<number | null>(resolve => child.once('close', resolve))
  // An early CLI exit can close stdin while Node is still writing. Its actual exit is checked below.
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      let event: ThreadEvent
      try { event = JSON.parse(line) as ThreadEvent } catch { throw new Error('The Codex CLI sent an unreadable event.') }
      if (event && typeof event.type === 'string') yield event
    }
    const code = await closed
    if (spawnError) throw spawnError
    if (code !== 0) {
      if (diagnostic.includes('unexpected argument') && diagnostic.includes('--ignore-user-config'))
        throw new Error('This Codex CLI cannot isolate faibots from other tools. Use the CLI included with faibots.')
      if (isCodexSignInError(diagnostic)) throw new Error(CODEX_SIGN_IN_MESSAGE)
      throw new Error(`Codex exited before finishing (exit ${code ?? 'interrupted'}).`)
    }
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
}

export const CODEX_SIGN_IN_MESSAGE = 'Codex could not use a sign-in for this faibots session. Test Codex in Settings. If your login requires a custom credential store, choose another configured provider or ask your administrator about a compatible Codex sign-in.'

export function isCodexSignInError(message: string): boolean {
  return /\b401\b|unauthorized|not (?:logged|signed) in|missing (?:api key|authentication)|authentication (?:required|failed)|no authentication|sign.in for this faibots session/i.test(message)
}
