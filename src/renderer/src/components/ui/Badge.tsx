import clsx from 'clsx'
import { CreditCard, HardDrive, HelpCircle, KeyRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BillingRoute } from '@shared/domain'
import { BILLING_LABELS } from '../../lib/providers'

type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'bot'

const TONES: Record<Tone, string> = {
  neutral: 'bg-hover text-fg-2',
  accent: 'bg-accent/12 text-accent-fg',
  success: 'bg-success/12 text-success-fg',
  warn: 'bg-warn/14 text-warn-fg',
  danger: 'bg-danger/12 text-danger-fg',
  bot: 'bg-bot-soft text-bot-fg'
}

export function Badge({ tone = 'neutral', children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={clsx('inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-pill px-1.5 text-2xs font-medium', TONES[tone], className)}
    >
      {children}
    </span>
  )
}

const BILLING_ICONS = { subscription: CreditCard, 'api-key': KeyRound, local: HardDrive, unknown: HelpCircle }
const BILLING_TONES: Record<BillingRoute, Tone> = { subscription: 'accent', 'api-key': 'warn', local: 'success', unknown: 'neutral' }

/** Shows how a model route is paid for: subscription, API key or local. */
export function BillingBadge({ route, className }: { route: BillingRoute; className?: string }) {
  const Icon = BILLING_ICONS[route]
  const info = BILLING_LABELS[route]
  return (
    <Badge tone={BILLING_TONES[route]} title={info.hint} className={className}>
      <Icon size={11} strokeWidth={2.2} />
      {info.label}
    </Badge>
  )
}

export function StatusDot({ tone, pulse, className }: { tone: 'success' | 'warn' | 'danger' | 'neutral' | 'accent'; pulse?: boolean; className?: string }) {
  const color = {
    success: 'bg-success',
    warn: 'bg-warn',
    danger: 'bg-danger',
    neutral: 'bg-fg-4',
    accent: 'bg-accent'
  }[tone]
  return <span className={clsx('inline-block size-2 shrink-0 rounded-full', color, pulse && 'animate-pulse', className)} />
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-pane px-1 font-sans text-2xs font-medium text-fg-3">
      {children}
    </kbd>
  )
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={clsx('spin shrink-0', className)} aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: React.ComponentType<{ size?: number; className?: string }>; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-8 text-center">
      {Icon && <Icon size={22} className="mb-2.5 text-fg-4" />}
      <div className="text-ui font-medium text-fg-2">{title}</div>
      {children && <div className="mt-1 max-w-[280px] text-[12.5px] text-fg-3">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
