import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'

export type Anchor = DOMRect | { x: number; y: number }
export type Placement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start'

function rectOf(anchor: Anchor) {
  if ('width' in anchor) return anchor
  return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y }
}

/** A floating layer pinned next to an anchor, kept inside the window. */
export function Floating({
  anchor,
  placement = 'bottom-start',
  offset = 6,
  onClose,
  children,
  className,
  onMouseEnter,
  onMouseLeave
}: {
  anchor: Anchor
  placement?: Placement
  offset?: number
  onClose?: () => void
  children: ReactNode
  className?: string
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const r = rectOf(anchor)
    let left = placement.endsWith('end') ? r.right - w : r.left
    let top = placement.startsWith('top') ? r.top - h - offset : r.bottom + offset
    if (placement === 'right-start') {
      left = r.right + offset
      top = r.top
    }
    if (placement.startsWith('bottom') && top + h > window.innerHeight - 8) top = r.top - h - offset
    if (placement.startsWith('top') && top < 8) top = r.bottom + offset
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8))
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8))
    setPos({ left, top })
  }, [anchor, placement, offset])

  useEffect(() => {
    if (!onClose) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    const onBlur = () => onClose()
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className={clsx('fixed z-[60]', pos ? 'pop-in' : 'invisible', className)}
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>,
    document.body
  )
}

export interface MenuItem {
  label: string
  icon?: LucideIcon
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  hint?: string
}

export type MenuEntry = MenuItem | 'separator'

/** A dropdown or context menu with keyboard support. */
export function Menu({ anchor, items, onClose, placement }: { anchor: Anchor; items: MenuEntry[]; onClose: () => void; placement?: Placement }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
  }, [])
  const move = (dir: 1 | -1) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[(i + dir + buttons.length) % buttons.length]?.focus()
  }
  return (
    <Floating anchor={anchor} onClose={onClose} placement={placement}>
      <div
        ref={ref}
        role="menu"
        className="min-w-[200px] rounded-xl border border-line bg-elevated p-1 shadow-pop"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            move(1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            move(-1)
          }
        }}
      >
        {items.map((item, i) =>
          item === 'separator' ? (
            <div key={`sep-${i}`} className="mx-2 my-1 h-px bg-line-soft" />
          ) : (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose()
                item.onSelect()
              }}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-ui outline-none disabled:opacity-40',
                item.danger ? 'text-danger-fg hover:bg-danger/10 focus:bg-danger/10' : 'text-fg hover:bg-hover focus:bg-hover'
              )}
            >
              {item.icon && <item.icon size={15} strokeWidth={1.9} className={item.danger ? '' : 'text-fg-3'} />}
              <span className="flex-1">{item.label}</span>
              {item.hint && <span className="text-2xs text-fg-4">{item.hint}</span>}
            </button>
          )
        )}
      </div>
    </Floating>
  )
}
