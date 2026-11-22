import { useRef, useState } from 'react'
import type { HandoffScope } from '@shared/escalations'
import { errorMessage, invoke } from '../../lib/bridge'
import { useAsync } from '../../lib/hooks'
import { useData } from '../../store/data'
import { loadOlder } from '../../store/actions'
import { navigate } from '../../store/ui'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, Select, TextArea } from '../ui/Field'

function ProjectChoice({
  projectId,
  onChange
}: {
  projectId: string
  onChange: (scope: HandoffScope | undefined) => void
}) {
  const project = useAsync(() => invoke('session:project', { projectId }), [projectId])
  const [selected, setSelected] = useState('')
  return (
    <Field label="Project session">
      <Select
        aria-label="Handoff project session"
        value={selected}
        onChange={(e) => {
          const id = e.target.value
          setSelected(id)
          onChange(id && project.data ? { ...project.data.address, sessionId: id } : undefined)
        }}
      >
        <option value="">Choose a session</option>
        {project.data?.sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>
      {project.error && <p role="alert">{project.error}</p>}
      {project.data && !project.data.sessions.length && (
        <p>Start a session in the project to attach its selected revisions.</p>
      )}
    </Field>
  )
}

export function SpecialistHandoff({ conversationId }: { conversationId: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="px-4 py-1">
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Handoff to fai
      </Button>
      {open && <HandoffDialog conversationId={conversationId} close={() => setOpen(false)} />}
    </div>
  )
}

function HandoffDialog({ conversationId, close }: { conversationId: string; close: () => void }) {
  const entries = useData((s) => s.entries[conversationId]) ?? []
  const hasMore = useData((s) => s.hasMore[conversationId])
  const projects = useData((s) => s.projects)
  const options = useAsync(() => invoke('handoff:options', { sourceChatId: conversationId }), [conversationId])
  const [snippets, setSnippets] = useState<Record<string, string>>({})
  const [question, setQuestion] = useState('')
  const [projectId, setProjectId] = useState('')
  const [scope, setScope] = useState<HandoffScope>()
  const [workId, setWorkId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const pending = useRef({ signature: '', id: '' })
  const messages = entries.filter(
    (e) => e.kind === 'message' && !e.isStreaming && !e.trigger && e.author.kind !== 'system' && e.text.trim()
  )
  const selected = Object.entries(snippets)
  const send = async () => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const selections = selected.map(([entryId, text]) => {
        const entry = messages.find((e) => e.id === entryId),
          start = entry?.text.indexOf(text) ?? -1
        if (start < 0 || !text.trim()) throw new Error('Keep the exact words from the original message.')
        return { entryId, start, end: start + text.length, expectedText: text }
      })
      const work = options.data?.work.find((w) => w.id === workId)
      if ((projectId && scope?.projectId !== projectId) || (workId && !work))
        throw new Error('Review the project session and work selection.')
      const request = {
        sourceChatId: conversationId,
        question: question.trim(),
        selections,
        ...(scope && { scope }),
        ...(work && { work: { id: work.id, revision: work.revision } })
      }
      const signature = JSON.stringify(request)
      if (pending.current.signature !== signature) pending.current = { signature, id: crypto.randomUUID() }
      const receipt = await invoke('handoff:send', { id: pending.current.id, ...request })
      close()
      navigate({ kind: 'conversation', id: receipt.chiefChatId })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
      submitting.current = false
    }
  }
  return (
    <Dialog
      title="Handoff to fai"
      description="Choose the exact words fai may read from this private chat."
      onClose={close}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Close
          </Button>
          <Button
            variant="primary"
            disabled={busy || !question.trim() || !selected.length || (!!projectId && !scope)}
            onClick={() => void send()}
          >
            Send handoff
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset className="max-h-60 space-y-2 overflow-y-auto">
          <legend className="text-ui font-medium">Messages to share</legend>
          {hasMore && (
            <Button size="sm" variant="ghost" onClick={() => void loadOlder(conversationId)}>
              Load earlier messages
            </Button>
          )}
          {messages.map((e) => (
            <div key={e.id} className="space-y-1">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={e.id in snippets}
                  disabled={!(e.id in snippets) && selected.length >= 8}
                  onChange={(ev) =>
                    setSnippets((old) => {
                      const next = { ...old }
                      if (ev.target.checked) next[e.id] = e.text.slice(0, 4000)
                      else delete next[e.id]
                      return next
                    })
                  }
                />
                <span>{e.text.slice(0, 140)}</span>
              </label>
              {e.id in snippets && (
                <TextArea
                  aria-label="Exact excerpt"
                  maxLength={4000}
                  rows={2}
                  value={snippets[e.id]}
                  onChange={(ev) => setSnippets({ ...snippets, [e.id]: ev.target.value })}
                />
              )}
            </div>
          ))}
          {!messages.length && <p>Messages appear here after you speak with this specialist.</p>}
        </fieldset>
        <Field label="Question for fai">
          <TextArea
            aria-label="Question for fai"
            maxLength={2000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </Field>
        <Field label="Project">
          <Select
            aria-label="Handoff project"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value)
              setScope(undefined)
            }}
          >
            <option value="">Personal chat</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        {projectId && <ProjectChoice key={projectId} projectId={projectId} onChange={setScope} />}
        {options.data?.work.length ? (
          <Field label="Work to continue">
            <Select aria-label="Handoff work" value={workId} onChange={(e) => setWorkId(e.target.value)}>
              <option value="">Separate request</option>
              {options.data.work.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.objective}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {options.data?.receipts.some((r) => r.destinationEntryId) && (
          <details>
            <summary>Previously sent</summary>
            {options.data.receipts
              .filter((r) => r.destinationEntryId)
              .map((r) => (
                <p key={r.id}>
                  {new Date(r.createdAt).toLocaleString()} · {r.id.slice(0, 8)}
                </p>
              ))}
          </details>
        )}
        {options.data?.receipts
          .filter((r) => !r.destinationEntryId)
          .map((r) => (
            <Button
              key={r.id}
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError('')
                try {
                  const receipt = await invoke('handoff:resume', { sourceChatId: conversationId, id: r.id })
                  close()
                  navigate({ kind: 'conversation', id: receipt.chiefChatId })
                } catch (err) {
                  setError(errorMessage(err))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Retry pending handoff · {r.id.slice(0, 8)}
            </Button>
          ))}
        {(error || options.error) && <p role="alert">{error || options.error}</p>}
      </div>
    </Dialog>
  )
}
