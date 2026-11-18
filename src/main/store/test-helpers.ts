// Fakes shared by platform tests. Not imported by app code.

import type { EventMap } from '@shared/ipc'
import type { Cipher, EventBus } from '../contracts'

/** Reversible stand-in for safeStorage; the prefix shows the stored file is not plaintext. */
export const fakeCipher: Cipher = {
  encrypt: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString('hex')}`),
  decrypt: (data) => {
    const text = data.toString()
    if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
    return Buffer.from(text.slice(4), 'hex').toString()
  }
}

export type BusEvent = { [C in keyof EventMap]: { channel: C; payload: EventMap[C] } }[keyof EventMap]

/** EventBus that records what was emitted. */
export function fakeBus(): EventBus & { events: BusEvent[]; of<C extends keyof EventMap>(channel: C): EventMap[C][] } {
  const events: BusEvent[] = []
  return {
    events,
    emit(channel, payload) {
      events.push({ channel, payload } as BusEvent)
    },
    of(channel) {
      return events.filter((e) => e.channel === channel).map((e) => e.payload) as never
    }
  }
}
