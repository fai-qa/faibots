// Honest capability chips from the fai design checkpoint (fai-design references/website-sample.md):
// Built locally / Designed / Next. A screen or action that is not wired yet carries the chip
// that says so, instead of pretending the capability exists.

import clsx from 'clsx'

export type StatusTone = 'built' | 'designed' | 'next'

/** Light values are the checkpoint chip palette; dark values follow tokens.css dark. */
const TONES: Record<StatusTone, { label: string; className: string }> = {
  built: {
    label: 'Built locally',
    className: 'bg-[#e7f3ec] text-[#247045] dark:bg-[#1a3a29] dark:text-[#8ccea6]'
  },
  designed: {
    label: 'Designed',
    className: 'bg-[#e8eefc] text-[#245fcf] dark:bg-[#20304f] dark:text-[#8eb3ff]'
  },
  next: {
    label: 'Next',
    className: 'bg-[#f0f2f5] text-[#8a4b12] dark:bg-[#26282c] dark:text-[#edc18c]'
  }
}

export function StatusChip({ tone, title, className }: { tone: StatusTone; title?: string; className?: string }) {
  const t = TONES[tone]
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex h-fit shrink-0 select-none items-center whitespace-nowrap rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-[0.08em]',
        t.className,
        className
      )}
    >
      {t.label}
    </span>
  )
}
