import { useRef, useState } from 'react'
import type { SessionInvoke } from '@shared/project-sessions'
import { errorMessage, invoke } from '../../lib/bridge'
import { navigate, useUi } from '../../store/ui'
import { Button } from '../ui/Button'
import { Field, TextArea } from '../ui/Field'

type Selection = Omit<SessionInvoke['session:ask-fai']['req'],'requestId'|'instruction'> | Omit<SessionInvoke['session:ask-page']['req'],'requestId'|'instruction'>

export function AskFai({ selection }: { selection: Selection }) {
  const page = 'pageId' in selection
  const label = page ? 'What should fai do with this Page?' : 'What should fai do with this result?'
  const [open, setOpen] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const lastRequest = useRef<{ instruction: string; id: string } | null>(null)

  async function send() {
    const text = instruction.trim()
    if (!text || sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    if (lastRequest.current?.instruction !== text) {
      lastRequest.current = { instruction: text, id: crypto.randomUUID() }
    }
    try {
      const request = { requestId:lastRequest.current.id, instruction:text }
      const result = 'pageId' in selection
        ? await invoke('session:ask-page', { ...selection,...request })
        : await invoke('session:ask-fai', { ...selection,...request })
      const route = useUi.getState().route
      if (route.kind === 'project' && route.id === selection.projectId) navigate({ kind: 'conversation', id: result.conversationId })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>Ask fai</Button>
  return (
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send() }}>
      <Field label={label} hint={page ? 'This Page revision will be available to fai in your main chat.' : 'The cited evidence will be available to fai in your main chat.'}>
        <TextArea
          autoFocus
          aria-label={label}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          rows={2}
          maxLength={2000}
          disabled={busy}
        />
      </Field>
      {error && <p role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={busy || !instruction.trim()}>
          {busy ? 'Sending…' : 'Send to fai'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
