import clsx from 'clsx'
import type { ReactNode } from 'react'

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  size = 'md'
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  size?: 'sm' | 'md'
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={clsx(
        'relative inline-flex shrink-0 items-center rounded-pill transition-[background-color] duration-150 disabled:opacity-40 before:absolute before:-inset-1.5 before:rounded-full before:content-[\'\']',
        size === 'md' ? 'h-[18px] w-8' : 'h-4 w-7',
        checked ? 'bg-ink hover:bg-ink/90' : 'bg-line-strong hover:bg-line-strong/80'
      )}
    >
      <span
        className={clsx(
          'absolute rounded-full bg-pane shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150',
          size === 'md' ? 'left-[2px] size-[14px]' : 'left-[2px] size-3',
          checked && (size === 'md' ? 'translate-x-[14px]' : 'translate-x-3')
        )}
      />
    </button>
  )
}

/** A row with a title, a description and a control on the right (settings style). */
export function SettingRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <div className="text-ui font-medium text-fg">{title}</div>
        {description && <div className="mt-0.5 text-[12.5px] text-fg-3">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: string
  title?: string
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md'
}: {
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg bg-hover p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md font-medium transition-colors',
            size === 'md' ? 'h-7 px-3 text-[12.5px]' : 'h-6 px-2 text-[12px]',
            o.value === value ? 'bg-pane text-fg shadow-[0_1px_2px_rgb(0_0_0/0.1)]' : 'text-fg-3 hover:text-fg'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
