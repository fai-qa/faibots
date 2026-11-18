import { describe, expect, it } from 'vitest'
import type { RoutineSchedule } from './domain'
import { describeSchedule, nextRunAfter, normalizeSchedule } from './routines'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

describe('routine schedules', () => {
  it('validates and cleans schedules', () => {
    expect(normalizeSchedule({ kind: 'daily', time: '8:05', days: [5, 1, 1] })).toEqual({ kind: 'daily', time: '08:05', days: [1, 5] })
    expect(() => normalizeSchedule({ kind: 'daily', time: '25:00', days: [1] })).toThrow('24-hour')
    expect(() => normalizeSchedule({ kind: 'daily', time: '08:00', days: [] })).toThrow('at least one day')
    expect(() => normalizeSchedule({ kind: 'interval', everyMinutes: 1 })).toThrow('every 5 minutes')
    expect(normalizeSchedule({ kind: 'interval', everyMinutes: 59.6 })).toEqual({ kind: 'interval', everyMinutes: 60 })
  })

  it('finds the next weekday time', () => {
    const weekdays8: RoutineSchedule = { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }
    // Friday 2026-10-16 09:00 -> Monday 08:00.
    expect(nextRunAfter(weekdays8, at(2026, 10, 16, 9))).toBe(at(2026, 10, 19, 8))
    // Monday 07:59 -> the same morning.
    expect(nextRunAfter(weekdays8, at(2026, 10, 19, 7, 59))).toBe(at(2026, 10, 19, 8))
    // Exactly 08:00 counts as done: strictly after.
    expect(nextRunAfter(weekdays8, at(2026, 10, 19, 8))).toBe(at(2026, 10, 20, 8))
  })

  it('keeps intervals on their grid', () => {
    const hourly: RoutineSchedule = { kind: 'interval', everyMinutes: 60 }
    const anchor = at(2026, 10, 19, 10)
    expect(nextRunAfter(hourly, at(2026, 10, 19, 9, 30))).toBe(at(2026, 10, 19, 10, 30))
    // A run that started late does not shift the grid.
    expect(nextRunAfter(hourly, at(2026, 10, 19, 10, 7), anchor)).toBe(at(2026, 10, 19, 11))
    // After a long gap, the next slot on the grid.
    expect(nextRunAfter(hourly, at(2026, 10, 19, 14, 59), anchor)).toBe(at(2026, 10, 19, 15))
    expect(nextRunAfter({ kind: 'manual' }, anchor)).toBeUndefined()
  })

  it('describes schedules in plain words', () => {
    expect(describeSchedule({ kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] })).toBe('Weekdays at 08:00')
    expect(describeSchedule({ kind: 'daily', time: '18:30', days: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every day at 18:30')
    expect(describeSchedule({ kind: 'daily', time: '09:00', days: [1, 3] })).toBe('Mon, Wed at 09:00')
    expect(describeSchedule({ kind: 'interval', everyMinutes: 120 })).toBe('Every 2 hours')
    expect(describeSchedule({ kind: 'interval', everyMinutes: 45 })).toBe('Every 45 minutes')
    expect(describeSchedule({ kind: 'manual' })).toBe('Only when started')
  })
})
