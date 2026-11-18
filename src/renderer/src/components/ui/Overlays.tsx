import { CircleAlert, CircleCheck, X } from 'lucide-react'
import { dismissToast, useUi } from '../../store/ui'
import { Button } from './Button'
import { Dialog } from './Dialog'

export function Toasts() {
  const toasts = useUi((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed left-1/2 top-[60px] z-[70] flex w-[min(440px,90vw)] -translate-x-1/2 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="pop-in pointer-events-auto flex items-start gap-2.5 rounded-xl border border-line bg-elevated px-3.5 py-2.5 text-ui text-fg shadow-pop"
        >
          {t.tone === 'error' ? (
            <CircleAlert size={16} className="mt-px shrink-0 text-danger-fg" />
          ) : t.tone === 'success' ? (
            <CircleCheck size={16} className="mt-px shrink-0 text-success-fg" />
          ) : null}
          <span className="selectable min-w-0 flex-1">{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="text-fg-3 hover:text-fg">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function ConfirmHost() {
  const req = useUi((s) => s.confirm)
  if (!req) return null
  return (
    <Dialog
      title={req.title}
      onClose={() => req.resolve(false)}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={() => req.resolve(false)}>
            Cancel
          </Button>
          <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => req.resolve(true)} data-autofocus>
            {req.confirmLabel}
          </Button>
        </>
      }
    >
      {req.body && <p className="pb-1 text-ui text-fg-2">{req.body}</p>}
    </Dialog>
  )
}
