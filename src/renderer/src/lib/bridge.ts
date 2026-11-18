// The one door to the main process. Uses the real preload bridge when it exists,
// otherwise an in-memory mock so the UI can run in a plain browser.

import type { EventChannel, EventMap, FaiBotsBridge, InvokeChannel, InvokeMap } from '@shared/ipc'

let current: FaiBotsBridge | null = null
let mock = false

export async function initBridge(): Promise<void> {
  const real = (window as { faibots?: FaiBotsBridge }).faibots
  if (real) {
    current = real
    return
  }
  // Loaded lazily so the mock never ships in the real app's main chunk.
  const { createMockBridge } = await import('./mock-bridge')
  current = createMockBridge()
  mock = true
}

export function isMockBridge(): boolean {
  return mock
}

function bridge(): FaiBotsBridge {
  if (!current) throw new Error('Bridge used before initBridge()')
  return current
}

export function invoke<C extends InvokeChannel>(channel: C, req: InvokeMap[C]['req']): Promise<InvokeMap[C]['res']> {
  return bridge().invoke(channel, req)
}

export function on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void {
  return bridge().on(channel, listener)
}

/** Readable message from an IPC rejection ("Error invoking remote method 'x': Error: msg" → "msg"). */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
