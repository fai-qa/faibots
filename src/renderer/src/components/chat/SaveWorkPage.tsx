import { useEffect, useState } from 'react'
import type { WorkBrief } from '@shared/work-brief'
import type { ContentInvoke } from '@shared/project-content'
import { errorMessage, invoke, on } from '../../lib/bridge'
import { navigate } from '../../store/ui'
import { Button } from '../ui/Button'
import { Select } from '../ui/Field'

export function SaveWorkPage({ brief }: { brief: WorkBrief }) {
  const [choosing, setChoosing] = useState(false)
  const [view, setView] = useState<ContentInvoke['content:work-destinations']['res']>()
  const [project, setProject] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { conversationId, id: workId, revision } = brief
  useEffect(() => {
    let sequence = 0
    function load() {
      const request = ++sequence
      setView(undefined)
      setError('')
      void invoke('content:work-destinations', { conversationId, workId, revision })
        .then((next) => {
          if (request !== sequence) return
          setView(next)
          setProject((current) =>
            next.projects.some((p) => p.id === current)
              ? current
              : next.projects.length === 1
                ? next.projects[0]!.id
                : ''
          )
        })
        .catch((cause) => {
          if (request === sequence) setError(errorMessage(cause))
        })
    }
    const off = [on('journey:changed', load), on('bots:changed', load), on('settings:changed', load)]
    load()
    return () => {
      sequence++
      off.forEach((f) => f())
    }
  }, [conversationId, workId, revision])

  async function save() {
    if (!project || busy) return
    setBusy(true)
    setError('')
    try {
      const saved = await invoke('content:save-work', {
        conversationId,
        workId,
        revision,
        projectId: project
      })
      setView((previous) => ({ projects: previous?.projects ?? [], saved }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  if (view?.saved)
    return (
      <Button
        size="sm"
        onClick={() => navigate({ kind: 'project', id: view.saved!.projectId, pageId: view.saved!.id })}
      >
        Open saved Page in project
      </Button>
    )
  if (!choosing && !error)
    return (
      <Button size="sm" disabled={!view} onClick={() => setChoosing(true)}>
        Save to project
      </Button>
    )
  return (
    <div className="space-y-1">
      {view?.projects.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Destination project"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">Choose a project</option>
            {view.projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Button size="sm" disabled={!project || busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save accepted result'}
          </Button>
        </div>
      ) : (
        <p>{error ? '' : view ? 'Create a project to save this result.' : 'Checking available projects…'}</p>
      )}
      {error && <p role="alert">{error}</p>}
      <Button size="sm" variant="ghost" onClick={() => setChoosing(false)}>
        Close
      </Button>
    </div>
  )
}
