import clsx from 'clsx'
import { X } from 'lucide-react'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from './Button'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside `root`, closes on Escape and gives focus back when it unmounts. */
export function useFocusTrap(root: React.RefObject<HTMLElement | null>, onEscape?: () => void): void {
  useEffect(() => {
    const el = root.current
    if (!el) return
    const before = document.activeElement as HTMLElement | null
    const first = el.querySelector<HTMLElement>('[data-autofocus]') ?? el.querySelector<HTMLElement>('input, textarea, select') ?? el
    first.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        e.stopPropagation()
        e.preventDefault()
        onEscape()
        return
      }
      if (e.key !== 'Tab') return
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
      if (items.length === 0) return
      const head = items[0]!
      const tail = items[items.length - 1]!
      if (e.shiftKey && document.activeElement === head) {
        e.preventDefault()
        tail.focus()
      } else if (!e.shiftKey && document.activeElement === tail) {
        e.preventDefault()
        head.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      before?.focus?.({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  width = 520,
  className,
  bodyClassName
}: {
  title: ReactNode
  description?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
  bodyClassName?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descId = useId()
  useFocusTrap(ref, onClose)
  return createPortal(
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-scrim p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={clsx('pop-in flex max-h-[86vh] w-full flex-col rounded-card bg-elevated shadow-modal outline-none', className)}
        style={{ maxWidth: width }}
      >
        <header className="flex items-start gap-3 px-5 pb-2 pt-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold leading-snug text-fg">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-[12.5px] text-fg-3">
                {description}
              </p>
            )}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mr-1.5 -mt-0.5" />
        </header>
        <div className={clsx('scroll-y min-h-0 flex-1 px-5 py-3', bodyClassName)}>{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line-soft px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body
  )
}
