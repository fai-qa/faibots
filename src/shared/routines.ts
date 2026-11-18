// Routine schedules: validation, the next run time and a plain-words description.
// Pure functions shared by the main process (scheduler) and the renderer (editor, list).
// Times are local wall-clock times, so "08:00" stays 08:00 across daylight-saving changes.

import { MIN_ROUTINE_INTERVAL_MINUTES, type RoutineSchedule } from './domain'

export const WEEKDAYS = [1, 2, 3, 4, 5]
export const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/
/** A week in minutes: the longest interval that still makes sense as "every N minutes". */
const MAX_INTERVAL_MINUTES = 7 * 24 * 60

export function parseTime(time: string): { hours: number; minutes: number } | undefined {
  const m = TIME.exec(time.trim())
  return m ? { hours: Number(m[1]), minutes: Number(m[2]) } : undefined
}

/** Throws a message fit for the user when the schedule cannot run. Returns a cleaned copy. */
export function normalizeSchedule(schedule: RoutineSchedule): RoutineSchedule {
  switch (schedule?.kind) {
    case 'manual':
      return { kind: 'manual' }
    case 'interval': {
      const every = Math.round(Number(schedule.everyMinutes))
      if (!Number.isFinite(every) || every < MIN_ROUTINE_INTERVAL_MINUTES) {
        throw new Error(`Routines run at most every ${MIN_ROUTINE_INTERVAL_MINUTES} minutes.`)
      }
      if (every > MAX_INTERVAL_MINUTES) throw new Error('Pick an interval of a week or less, or use a daily time.')
      return { kind: 'interval', everyMinutes: every }
    }
    case 'daily': {
      const t = parseTime(schedule.time ?? '')
      if (!t) throw new Error('Use a time like 08:00 (24-hour clock).')
      const days = [...new Set((schedule.days ?? []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
      if (days.length === 0) throw new Error('Pick at least one day.')
      return { kind: 'daily', time: `${String(t.hours).padStart(2, '0')}:${String(t.minutes).padStart(2, '0')}`, days }
    }
    default:
      throw new Error('Unknown schedule.')
  }
}

/**
 * The first planned run strictly after `after` (epoch ms). For intervals, `anchor` is the previous
 * planned run: runs stay on its grid instead of drifting by however late a run started.
 */
export function nextRunAfter(schedule: RoutineSchedule, after: number, anchor?: number): number | undefined {
  if (schedule.kind === 'manual') return undefined
  if (schedule.kind === 'interval') {
    const step = schedule.everyMinutes * 60_000
    if (anchor === undefined || anchor > after + step) return after + step
    if (anchor > after) return anchor
    return anchor + Math.floor((after - anchor) / step + 1) * step
  }
  const t = parseTime(schedule.time)
  if (!t || schedule.days.length === 0) return undefined
  const start = new Date(after)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, t.hours, t.minutes, 0, 0)
    if (candidate.getTime() > after && schedule.days.includes(candidate.getDay())) return candidate.getTime()
  }
  return undefined
}

function sameDays(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i])
}

export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === 'manual') return 'Only when started'
  if (schedule.kind === 'interval') {
    const m = schedule.everyMinutes
    if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`
    if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`
    return `Every ${m} minutes`
  }
  const days = [...schedule.days].sort()
  const when = sameDays(days, EVERY_DAY)
    ? 'Every day'
    : sameDays(days, WEEKDAYS)
      ? 'Weekdays'
      : sameDays(days, [0, 6])
        ? 'Weekends'
        : days.map((d) => DAY_SHORT[d]).join(', ')
  return `${when} at ${schedule.time}`
}
