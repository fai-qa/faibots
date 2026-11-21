import { describe, expect, it, vi } from 'vitest'
import { LiveStates } from './live-state'
import type { BotLiveState } from '@shared/domain'

describe('live activity delivery', () => {
  it('coalesces a burst per chat, sends the newest observation and never replays progress after idle', () => {
    vi.useFakeTimers()
    const events: BotLiveState[] = []
    const states = new LiveStates({
      emit: (_channel: string, payload: { state: BotLiveState }) => events.push(payload.state)
    } as never)
    try {
      states.set('fai', 'one', 'reading')
      for (let i = 0; i < 250; i++) states.set('fai', 'one', 'tool', 'Step ' + i)
      states.set('fai', 'two', 'thinking')
      expect(events.map((e) => e.phase)).toEqual(['reading', 'tool', 'thinking'])
      expect(states.get('fai', 'one')?.activity).toBe('Step 249')
      vi.advanceTimersByTime(100)
      expect(events.at(-1)?.activity).toBe('Step 249')
      states.set('fai', 'one', 'tool', 'Cancelled update')
      states.idle('fai', 'one')
      vi.runAllTimers()
      expect(events.filter((e) => e.conversationId === 'one').map((e) => e.phase)).toEqual([
        'reading',
        'tool',
        'tool',
        'idle'
      ])
      expect(states.list().map((e) => e.conversationId)).toEqual(['two'])
      states.set('fai', 'two', 'reading')
      states.clear()
      const count = events.length
      vi.runAllTimers()
      expect(events).toHaveLength(count)
    } finally {
      states.clear()
      vi.useRealTimers()
    }
  })
})
