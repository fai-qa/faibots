// The measured totals for a recorded proposal run.

import type { JourneyRun, JourneyRunBudgets } from '@shared/domain'
import { formatBytes, formatFull, plural } from '../../lib/format'

const SEC = 1000
const MIN = 60 * SEC

/** 12s, 4m 30s, 1h 04m – a compact reading of a recorded duration. */
function took(ms: number): string {
  if (ms < SEC) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 10 * SEC) return `${(ms / SEC).toFixed(1)}s`
  const s = Math.round(ms / SEC)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** One line of the measured budgets, joined from the keys that are actually recorded. */
function describeBudgets(b: JourneyRunBudgets): string {
  const parts: string[] = []
  if (b.b1 !== undefined) parts.push(plural(b.b1, 'turn'))
  if (b.b2 !== undefined) parts.push(plural(b.b2.errors, 'error'))
  if (b.b3 !== undefined) parts.push(`${(b.b3.inputTokens + b.b3.outputTokens).toLocaleString()} tokens`)
  if (b.b4 !== undefined) parts.push(`${took(b.b4.wallMs)} wall time`)
  if (b.b5 !== undefined) parts.push(plural(b.b5, 'bot message'))
  if (b.b7 !== undefined) parts.push(plural(b.b7, 'send_to_agent'))
  if (b.b10 !== undefined) parts.push(`acceptance ${b.b10.checksPassed}/${b.b10.checksTotal}`)
  return parts.join(' · ')
}

export function RunDetails({ run }: { run: JourneyRun }) {
  const b = run.budgets
  const wallMs = b.b4?.wallMs ?? (run.endedAt !== undefined ? Math.max(0, run.endedAt - run.startedAt) : 0)
  return (
    <div className="mt-2 space-y-3 rounded-inner border border-line-soft bg-pane p-3">
      <div>
        <h3 className="text-sm font-medium text-fg-2">Mission run</h3>
        <p className="text-xs text-fg-3">{describeBudgets(b) || (wallMs > 0 ? took(wallMs) : 'No recorded totals')}</p>
      </div>
      <BudgetChips budgets={b} />
      <p className="text-[12px] leading-relaxed text-fg-3">
        Started {formatFull(run.startedAt)}{run.endedAt ? ` · Ended ${formatFull(run.endedAt)}` : ''}.
      </p>
    </div>
  )
}

/** Every measured budget as a chip; keys that were never measured stay absent, never zero. */
function BudgetChips({ budgets }: { budgets: JourneyRunBudgets }) {
  const b = budgets
  const chips: { key: string; value: string }[] = []
  if (b.b1 !== undefined) chips.push({ key: 'B1 · Turns', value: b.b1.toLocaleString() })
  if (b.b2 !== undefined)
    chips.push({ key: 'B2 · Errors', value: b.b2.errors > 0 ? `${b.b2.errors.toLocaleString()} (${Math.round(b.b2.rate * 100)}%)` : 'none' })
  if (b.b3 !== undefined)
    chips.push({
      key: 'B3 · Tokens',
      value: `${b.b3.inputTokens.toLocaleString()} in · ${b.b3.outputTokens.toLocaleString()} out${
        b.b3.zeroTokenTurns > 0 ? ` · ${b.b3.zeroTokenTurns} unreported` : ''
      }`
    })
  if (b.b4 !== undefined) chips.push({ key: 'B4 · Wall time', value: `${took(b.b4.wallMs)} (turns ${took(b.b4.totalMs)})` })
  if (b.b5 !== undefined) chips.push({ key: 'B5 · Bot messages', value: b.b5.toLocaleString() })
  if (b.b6 !== undefined) {
    const parts = (Object.entries(b.b6) as [keyof typeof b.b6, number][])
      .filter(([, n]) => n > 0)
      .map(([status, n]) => `${n} ${status}`)
    chips.push({ key: 'B6 · Tool calls', value: parts.length ? parts.join(' · ') : 'none' })
  }
  if (b.b7 !== undefined) chips.push({ key: 'B7 · send_to_agent', value: b.b7.toLocaleString() })
  if (b.b8 !== undefined) chips.push({ key: 'B8 · Bytes in', value: formatBytes(b.b8.total) })
  if (b.b9 !== undefined)
    chips.push({ key: 'B9 · Deliverable', value: `${formatBytes(b.b9.bytes)} · ${b.b9.sha256.slice(0, 12)}…` })
  if (b.b10 !== undefined)
    chips.push({ key: 'B10 · Acceptance', value: `${b.b10.checksPassed}/${b.b10.checksTotal}${b.b10.repairs > 0 ? ` · ${b.b10.repairs} repairs` : ''}` })
  if (b.b11 !== undefined) chips.push({ key: 'B11 · Admissions', value: b.b11.toLocaleString() })

  if (chips.length === 0) return <p className="text-[12px] text-fg-4">No budgets were recorded for this run.</p>
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
      {chips.map((c) => (
        <div key={c.key} className="min-w-0">
          <dt className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-fg-4">{c.key}</dt>
          <dd className="truncate text-[12px] tabular-nums text-fg-2" title={c.value}>
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
