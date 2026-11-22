import { useRef, useState } from 'react'
import type { ProjectAddress, ProjectAnswer, ProjectSession, ProjectSessionView } from '@shared/project-sessions'
import { errorMessage, invoke } from '../../lib/bridge'
import { useAsync } from '../../lib/hooks'
import { useData } from '../../store/data'
import { navigate, useUi } from '../../store/ui'
import { TurnContext } from '../details/TurnContext'
import { Button } from '../ui/Button'
import { Field, Select, TextArea, TextInput } from '../ui/Field'

const small = 'text-[12px] text-fg-3'

function AskFai({ scope, sessionId, answerId }: { scope: ProjectAddress; sessionId: string; answerId: string }) {
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
      const result = await invoke('session:ask-fai', {
        ...scope, sessionId, answerId, requestId: lastRequest.current.id, instruction: text
      })
      const route = useUi.getState().route
      if (route.kind === 'project' && route.id === scope.projectId) navigate({ kind: 'conversation', id: result.conversationId })
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
      <Field label="What should fai do with this result?" hint="The cited evidence will be available to fai in your main chat.">
        <TextArea
          autoFocus
          aria-label="What should fai do with this result?"
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

function Answer({ answer, scope, sessionId }: { answer: ProjectAnswer; scope: ProjectAddress; sessionId: string }) {
  return (
    <article className="space-y-2 border-t border-line-soft pt-3" aria-label="Saved answer">
      <h4 className="text-ui font-medium">{answer.query}</h4>
      {answer.status === 'unavailable' && (
        <p>No verified matching text was available in the selected revisions.</p>
      )}
      {answer.conflicts.map((conflict) => (
        <p key={conflict} role="status" className="text-warn">
          {conflict}
        </p>
      ))}
      {answer.modelReply && <p className="selectable whitespace-pre-wrap">{answer.modelReply}</p>}
      {answer.citations.map(({ source, line, excerpt }) => (
        <blockquote className="selectable border-l border-line-soft pl-2" key={source.sourceId + ':' + line}>
          {excerpt}
          <footer className={small} title={source.sha256}>
            {source.name} · r{source.revision} · line {line} · {source.sha256.slice(0, 12)}
          </footer>
        </blockquote>
      ))}
      {answer.omissions.map((note) => (
        <p className={small} key={note}>
          {note}
        </p>
      ))}
      <details className={small}>
        <summary>Result provenance</summary>
        <p className="selectable break-all">
          Project {answer.projectId} · Session {answer.sessionId} · Owner {answer.ownerId} · Result {answer.id}
        </p>
      </details>
      {answer.status !== 'unavailable' && answer.citations.length > 0 && (
        <AskFai scope={scope} sessionId={sessionId} answerId={answer.id} />
      )}
    </article>
  )
}

function ForkChoice({
  target,
  source,
  parent,
  onOpen
}: {
  target: ProjectAddress
  source: ProjectAddress
  parent: ProjectSession
  onOpen: (v: ProjectSessionView) => void
}) {
  const choices = useAsync(() => invoke('session:history', { ...source, sessionId: parent.id }), [parent.id])
  const [ids, setIds] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fork = async () => {
    setBusy(true)
    try {
      const v = await invoke('session:open', {
        ...target,
        mode: 'fork',
        parentProjectId: source.projectId,
        parentId: parent.id,
        answerIds: ids,
        label: 'Fork of ' + parent.label
      })
      onOpen(v)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      {choices.error && <p role="alert">{choices.error}</p>}
      {choices.data?.history.map((answer) => (
        <label key={answer.id} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={ids.includes(answer.id)}
            onChange={(e) => setIds(e.target.checked ? [...ids, answer.id] : ids.filter((id) => id !== answer.id))}
          />
          {answer.query}
        </label>
      ))}
      {choices.data && !choices.data.history.length && <p>No accessible results to carry.</p>}
      {choices.data && choices.data.omittedHistory > 0 && (
        <p className={small}>Some previous results now have unavailable sources.</p>
      )}
      <Button size="sm" disabled={busy || !ids.length} onClick={() => void fork()}>
        Fork selected results
      </Button>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

function ForkSession({
  target,
  sourceProjectId,
  onOpen
}: {
  target: ProjectAddress
  sourceProjectId: string
  onOpen: (v: ProjectSessionView) => void
}) {
  const source = useAsync(() => invoke('session:project', { projectId: sourceProjectId }), [sourceProjectId])
  const [id, setId] = useState('')
  const parent = source.data?.sessions.find((s) => s.id === id)
  return (
    <div className="space-y-2">
      <Select aria-label="Parent session" value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Choose a parent session</option>
        {source.data?.sessions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </Select>
      {source.error && <p role="alert">{source.error}</p>}
      {source.data && parent && (
        <ForkChoice key={parent.id} source={source.data.address} target={target} parent={parent} onOpen={onOpen} />
      )}
    </div>
  )
}

function OpenSession({ view, scope }: { view: ProjectSessionView; scope: ProjectAddress }) {
  const [history, setHistory] = useState(view.history)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [useModel, setUseModel] = useState(false)
  const provider = useData((s) =>
    s.providers.find((p) => p.id === s.botMap.get(view.session.ownerId)?.model.providerId)
  )
  const search = async () => {
    if (!query.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const answer = await invoke('session:lookup', {
        ...scope,
        sessionId: view.session.id,
        query: query.trim(),
        requestId: crypto.randomUUID(),
        useModel
      })
      setHistory((h) => [...h, answer])
      setQuery('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3 rounded-inner border border-line-soft p-3">
      <h3 className="text-ui font-medium">{view.session.label}</h3>
      <details className={small}>
        <summary>Session scope · {view.session.sources.length} selected sources</summary>
        <p className="selectable break-all">
          Host {scope.hostId} · Environment {scope.environmentId}
        </p>
        {view.session.sources.map((s) => (
          <p key={s.sourceId} title={s.sha256}>
            Read · {s.name} · r{s.revision} · {s.sha256.slice(0, 12)}
          </p>
        ))}
      </details>
      <TurnContext revision={history.length} scope={{ ...scope, kind: 'project', sessionId: view.session.id }} />
      <p className={small}>Searching verified local sources. The graph is disconnected.</p>
      {view.omittedHistory > 0 && (
        <p role="status">Some results are hidden because their sources are unavailable.</p>
      )}
      {history.map((answer) => (
        <Answer key={answer.id} answer={answer} scope={scope} sessionId={view.session.id} />
      ))}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <TextInput
          aria-label="Search selected evidence"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={2000}
          placeholder="Search selected evidence"
        />
        {provider?.enabled && !['codex', 'claude-code'].includes(provider.kind) && (
          <label className={'flex items-center gap-2 ' + small}>
            <input type="checkbox" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} />
            Send selected results and session history to {provider.label} for a written answer
          </label>
        )}
        <Button type="submit" size="sm" disabled={busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search evidence'}
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </div>
  )
}

export function ProjectSessions({ projectId }: { projectId: string }) {
  const project = useAsync(() => invoke('session:project', { projectId }), [projectId])
  const projects = useData((s) => s.projects)
  const [selected, setSelected] = useState('')
  const [source, setSource] = useState(projectId)
  const [forkOpen, setForkOpen] = useState(false)
  const [view, setView] = useState<ProjectSessionView>()
  const [label, setLabel] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const opened = (v: ProjectSessionView) => {
    setView(v)
    setSelected(v.session.id)
    setForkOpen(false)
    setError('')
    project.reload()
  }
  const open = async (mode: 'continue' | 'fresh') => {
    if (!project.data) return
    setBusy(true)
    setView(undefined)
    try {
      const scope = project.data.address
      opened(
        await invoke(
          'session:open',
          mode === 'fresh' ? { ...scope, mode, label } : { ...scope, mode, sessionId: selected }
        )
      )
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-label="Project sessions" className="space-y-3 text-[13px]">
      <h2 className="font-semibold">Project sessions</h2>
      {project.error && <p role="alert">{project.error}</p>}
      {project.data && (
        <>
          <div className="flex flex-wrap gap-2">
            <TextInput
              aria-label="New session name"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Session name (optional)"
              maxLength={100}
            />
            <Button size="sm" disabled={busy} onClick={() => void open('fresh')}>
              Start fresh
            </Button>
          </div>
          {project.data.sessions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              <Select
                aria-label="Saved session"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value)
                  setView(undefined)
                }}
              >
                <option value="">Choose a saved session</option>
                {project.data.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
              <Button size="sm" disabled={busy || !selected} onClick={() => void open('continue')}>
                Continue
              </Button>
            </div>
          )}
          <details className="space-y-2" open={forkOpen} onToggle={(e) => setForkOpen(e.currentTarget.open)}>
            <summary>Fork selected history</summary>
            <Select aria-label="Parent project" value={source} onChange={(e) => setSource(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {forkOpen && (
              <ForkSession key={source} sourceProjectId={source} target={project.data.address} onOpen={opened} />
            )}
          </details>
          {view && <OpenSession key={view.session.id} view={view} scope={project.data.address} />}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
