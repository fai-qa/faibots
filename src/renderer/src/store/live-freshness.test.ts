import { afterEach, expect, it, vi } from 'vitest'
import { botStatus, lastActivityLabel, LIVE_STATUS_MAX_AGE_MS, refreshLiveFreshness, setLiveState, useData } from './data'

afterEach(() => {
  useData.setState({ live: {} })
  vi.useRealTimers()
})

it('expires silent telemetry without completing a job, and accepts fresh observations', () => {
  vi.useFakeTimers()
  const start = new Date('2026-11-21T12:00:00Z').valueOf()
  vi.setSystemTime(start)
  const sample = { botId: 'fai', conversationId: 'main', phase: 'tool' as const, activity: 'Checking a file', updatedAt: start }
  setLiveState(sample)
  const current = () => botStatus(useData.getState().live, 'fai')
  refreshLiveFreshness(start + LIVE_STATUS_MAX_AGE_MS - 1)
  expect(current()?.stale).toBeUndefined()
  vi.setSystemTime(start + LIVE_STATUS_MAX_AGE_MS)
  refreshLiveFreshness()
  expect(current()).toMatchObject({ ...sample, stale: true })
  expect(lastActivityLabel(current()!)).toContain('Checking a file')
  setLiveState({ ...sample, updatedAt: Date.now(), activity: 'Read complete' })
  expect(current()?.stale).toBeUndefined()
  setLiveState({ ...sample, phase: 'idle', updatedAt: start })
  expect(current()?.activity).toBe('Read complete')
  setLiveState({ ...sample, phase: 'idle', updatedAt: Date.now() })
  expect(current()).toBeUndefined()
})
