import clsx from 'clsx'
import { ChevronDown } from 'lucide-react'
import { useLayoutEffect, useRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

export function Field({
  label,
  hint,
  error,
  aside,
  children,
  className
}: {
  label?: ReactNode
  hint?: ReactNode
  error?: string | null
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <label className={clsx('block', className)}>
      {(label || aside) && (
        <span className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[12.5px] font-medium text-fg-2">{label}</span>
          {aside}
        </span>
      )}
      {children}
      {error ? (
        <span className="mt-1.5 block text-[12px] text-danger-fg">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[12px] text-fg-3">{hint}</span>
      ) : null}
    </label>
  )
}

const inputBase =
  'w-full rounded-control border border-line-strong bg-pane text-ui text-fg placeholder:text-fg-4 transition-[border-color,box-shadow] duration-150 focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-focus/15 disabled:opacity-60'

export function TextInput({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={clsx(inputBase, 'h-8 px-2.5', mono && 'font-mono text-[12.5px]', className)} spellCheck={false} {...rest} />
}

export function TextArea({
  className,
  mono,
  autoGrow,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean; autoGrow?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!autoGrow || !el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [autoGrow, rest.value])
  return (
    <textarea
      ref={ref}
      className={clsx(inputBase, 'block resize-y px-2.5 py-2 leading-[1.5]', mono && 'font-mono text-[12.5px]', className)}
      {...rest}
    />
  )
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={clsx('relative block', className)}>
      <select className={clsx(inputBase, 'h-8 appearance-none pl-2.5 pr-8')} {...rest}>
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-3" />
    </span>
  )
}

export function SectionTitle({ children, aside, className }: { children: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={clsx('mb-2 flex items-center justify-between gap-2', className)}>
      <h3 className="text-[13px] font-semibold text-fg">{children}</h3>
      {aside}
    </div>
  )
}
