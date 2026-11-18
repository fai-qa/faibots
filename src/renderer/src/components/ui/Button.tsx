import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  icon?: LucideIcon
  children?: ReactNode
}

/* One button pair: a filled action and a quiet outline. Every button steps up 1px on
   hover and presses back down on click; the md size meets the checkpoint control-min. */
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-ink text-on-ink hover:opacity-[0.9] active:opacity-80',
  secondary: 'border border-line-strong bg-pane text-fg hover:bg-hover active:bg-active',
  ghost: 'text-fg-2 hover:bg-hover hover:text-fg active:bg-active',
  danger: 'bg-danger text-on-danger hover:opacity-90',
  'danger-ghost': 'text-danger-fg hover:bg-danger/10 active:bg-danger/15'
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-[background-color,opacity,color,translate] duration-150 disabled:pointer-events-none disabled:opacity-45 hover:-translate-y-px active:translate-y-0',
        size === 'md' ? 'h-11 px-4 text-ui' : 'h-8 px-3 text-[12.5px]',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {Icon && <Icon size={size === 'md' ? 15 : 14} strokeWidth={2} className="-ml-0.5 shrink-0" />}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  size?: 'sm' | 'md'
  active?: boolean
  tone?: 'default' | 'danger'
}

export function IconButton({ icon: Icon, label, size = 'md', active, tone = 'default', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-control transition-[background-color,color,translate] duration-150 disabled:pointer-events-none disabled:opacity-40 hover:-translate-y-px active:translate-y-0',
        size === 'md' ? 'size-8' : 'size-7',
        tone === 'danger' ? 'text-fg-3 hover:bg-danger/10 hover:text-danger-fg' : 'text-fg-3 hover:bg-hover hover:text-fg',
        active && 'bg-active text-fg',
        className
      )}
      {...rest}
    >
      <Icon size={size === 'md' ? 16 : 14} strokeWidth={1.9} />
    </button>
  )
}
