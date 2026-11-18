// Small formatting helpers for times, sizes and names.

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayMonth = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function formatTime(ms: number): string {
  return time.format(ms)
}

export function formatFull(ms: number): string {
  return fullDate.format(ms)
}

/** "Today", "Yesterday", or "Monday, October 13". */
export function dayLabel(ms: number, now = Date.now()): string {
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return dayMonth.format(ms)
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

/** Compact time for sidebar rows: "10:42", "Yesterday", "Oct 12". */
export function shortWhen(ms: number, now = Date.now()): string {
  if (!ms) return ''
  if (sameDay(ms, now)) return formatTime(ms)
  const diff = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000)
  if (diff === 1) return 'Yesterday'
  return shortDate.format(ms)
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function relative(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return shortDate.format(ms)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** "Atlas", "Atlas and Iris", "Atlas, Iris and Juno", "Atlas, Iris and 2 others". */
export function joinNames(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const rest = names.length - (max - 1)
  return `${names.slice(0, max - 1).join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
}

/** One-line preview of Markdown text for sidebar rows and cards. */
export function plainPreview(markdown: string, max = 120): string {
  const flat = markdown
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** An upcoming time: "today at 08:00", "tomorrow at 08:00", "Fri at 16:00", "Oct 30 at 09:00". */
export function upcoming(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000)
  const at = formatTime(ms)
  if (days <= 0) return `today at ${at}`
  if (days === 1) return `tomorrow at ${at}`
  if (days < 7) return `${weekday.format(ms)} at ${at}`
  return `${shortDate.format(ms)} at ${at}`
}

/** "48s", "3m 05s", "1h 12m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** 1234 -> "1.2K", 5600000 -> "5.6M". */
export function compactNumber(n: number): string {
  return compact.format(n)
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function nonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
export const modKey = isMac ? '⌘' : 'Ctrl'
