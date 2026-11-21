import { useState } from 'react'
import type { LibrarySource } from '@shared/project-content'
import { invoke } from '../../lib/bridge'
import { useAsync } from '../../lib/hooks'
import { useData } from '../../store/data'
import { confirmDialog } from '../../store/ui'
import { attempt, run } from '../../store/actions'
import { Button } from '../ui/Button'
import { Select } from '../ui/Field'
import { Markdown } from '../chat/Markdown'

function SourcePreview({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const state = useAsync(() => invoke('content:read-source', { projectId, sourceId }), [projectId, sourceId])
  if (state.error) return <p role="alert">{state.error}</p>
  return state.data ? <pre className="selectable max-h-64 overflow-auto whitespace-pre-wrap">{state.data.text}</pre> : null
}

function LibraryRow({ projectId, item }: { projectId: string; item: LibrarySource }) {
  const projects = useData((s) => s.projects)
  const [target, setTarget] = useState('')
  const [sourceId, setSourceId] = useState('')
  const input = { projectId, itemId: item.itemId }
  const owns = item.ownerProjectId === projectId
  const revise = async () => {
    const paths = await attempt('dialog:open-files', {
      title: 'Choose the next source revision',
      filters: [{ name: 'Notes', extensions: ['md', 'txt', 'pdf'] }]
    })
    if (paths?.length === 1) await run('content:revise', { ...input, path: paths[0]! }, 'Could not update the source.')
  }
  const revoke = async () => {
    if (
      await confirmDialog({
        title: 'Revoke access to this source?',
        body: owns
          ? 'This also removes access for projects you shared it with. Pages that depend on this source will stop opening.'
          : 'This project will lose access to the source and Pages that depend on it.',
        confirmLabel: 'Revoke access',
        danger: true
      })
    )
      await run('content:revoke', input, 'Could not revoke access.')
  }
  return (
    <li className="space-y-2 border-t border-line-soft py-2">
      <label className="flex items-center gap-2 text-ui">
        <input
          type="checkbox"
          checked={item.selected && item.readable}
          disabled={!item.readable}
          aria-label={`Use ${item.source.name} in missions`}
          onChange={(e) => void run('content:select', { ...input, selected: e.target.checked })}
        />
        <span>{item.source.name}</span>
        <span className="text-[12px] text-fg-3">
          Revision {item.revision}
          {!item.readable && ' · Access revoked'}
        </span>
      </label>
      {!item.readable && owns && (
        <Button size="sm" onClick={() => void run('content:restore', input)}>
          Restore this project’s access
        </Button>
      )}
      {item.readable && (
        <details>
          <summary className="cursor-pointer text-[12px] text-fg-3">Source details</summary>
          <div className="mt-2 space-y-2 text-[12px] text-fg-3">
            <p>From {projects.find((p) => p.id === item.ownerProjectId)?.name || 'the owning project'}</p>
            <p className="selectable break-all font-mono" title="SHA-256">
              {item.source.sha256}
            </p>
            <Select
              aria-label={`Open revision of ${item.source.name}`}
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">Open a source revision</option>
              {item.versions.map((v) => (
                <option key={v.sourceId} value={v.sourceId}>
                  Revision {v.revision} · {v.name}
                </option>
              ))}
            </Select>
            {sourceId && <SourcePreview key={sourceId} projectId={projectId} sourceId={sourceId} />}
            <div className="flex flex-wrap items-center gap-2">
              {owns && (
                <Button size="sm" onClick={() => void revise()}>
                  Add revision
                </Button>
              )}
              <Button size="sm" onClick={() => void revoke()}>
                Revoke access
              </Button>
              {owns && projects.length > 1 && (
                <>
                  <Select
                    aria-label={`Share ${item.source.name} with project`}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">Choose a project</option>
                    {projects
                      .filter((p) => p.id !== projectId)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </Select>
                  <Button
                    size="sm"
                    disabled={!target}
                    onClick={() =>
                      void run('content:share', { ...input, targetProjectId: target }).then((ok) => {
                        if (ok) setTarget('')
                      })
                    }
                  >
                    Share source
                  </Button>
                  {item.sharedWith.includes(target) && (
                    <Button size="sm" onClick={() => void run('content:revoke', { ...input, targetProjectId: target })}>
                      Revoke this share
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </details>
      )}
    </li>
  )
}

function PublishedPage({ projectId, pageId }: { projectId: string; pageId: string }) {
  const page = useAsync(() => invoke('content:read-page', { projectId, pageId }), [projectId, pageId])
  if (page.error)
    return (
      <p role="alert" className="text-[12px] text-danger-fg">
        {page.error}
      </p>
    )
  if (!page.data) return <p className="text-[12px] text-fg-3">Opening Page…</p>
  return (
    <article className="space-y-2 rounded-card border border-line-soft p-3">
      <Markdown text={page.data.body} />
      <details>
        <summary className="cursor-pointer text-[12px] text-fg-3">Source revisions</summary>
        {page.data.sources.map((source, index) => (
          <p key={index} className="selectable break-all text-[12px]">
            {source.name} · {source.sha256}
          </p>
        ))}
      </details>
    </article>
  )
}

export function ProjectSpace({
  projectId,
  version,
  attaching,
  onAttach
}: {
  projectId: string
  version: number
  attaching: boolean
  onAttach: () => void
}) {
  const state = useAsync(() => invoke('content:project', { projectId }), [projectId, version])
  const [pageId, setPageId] = useState('')
  if (state.error) return <p role="alert">{state.error}</p>
  if (!state.data) return null
  const { space, library, pages, evaluations } = state.data
  return (
    <>
      <section aria-label="Library" className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-semibold text-fg">Library</h2>
          <Button size="sm" onClick={onAttach} disabled={attaching}>
            {attaching ? 'Attaching…' : 'Attach notes'}
          </Button>
        </div>
        {library.length ? (
          <>
            <p className="text-[12px] text-fg-3">Choose the sources to include in the next mission.</p>
            <ul>
              {library.map((item) => (
                <LibraryRow key={item.itemId + ':' + version} projectId={projectId} item={item} />
              ))}
            </ul>
          </>
        ) : (
          <p className="text-[12px] text-fg-3">Attach notes or share a source from another project.</p>
        )}
      </section>
      <section aria-label="Project space" className="space-y-2">
        <h2 className="text-[13px] font-semibold text-fg">{space.name}</h2>
        {pages.length ? (
          pages.map((page) => (
            <div key={page.id} className="space-y-2">
              <Button size="sm" onClick={() => setPageId(pageId === page.id ? '' : page.id)}>
                {page.name}
              </Button>
              {pageId === page.id && <PublishedPage key={page.id + ':' + version} projectId={projectId} pageId={page.id} />}
            </div>
          ))
        ) : (
          <p className="text-[12px] text-fg-3">A reviewed and accepted result appears here as a Page.</p>
        )}
      </section>
      {evaluations.length > 0 && (
        <details aria-label="Review evaluations">
          <summary className="cursor-pointer text-[13px] font-semibold">Review evaluations ({evaluations.length})</summary>
          {evaluations.map((e) => (
            <div key={e.runId} className="mt-2 space-y-1 rounded-card border border-line-soft p-3 text-[12px]">
              <p className="font-semibold">
                {e.status} · {e.turns} recorded coordinator turns
              </p>
              <p>{e.reason}</p>
              <p>Rubric · {e.rubric}</p>
              {e.status !== 'complete' && (
                <Button
                  size="sm"
                  onClick={() => void attempt('content:rerun', { projectId, runId: e.runId }, 'Could not rerun this case.')}
                >
                  Rerun with the same sources and rubric
                </Button>
              )}
              <Button
                size="sm"
                onClick={() =>
                  void attempt('content:evaluate', { projectId, runId: e.runId }, 'Could not check the evidence.')
                }
              >
                Recheck evidence
              </Button>
              {e.report && (
                <p>
                  Status {e.report.status} · Integrity {e.report.integrity} · Contract {e.report.contract}. {e.report.reason}
                </p>
              )}
            </div>
          ))}
        </details>
      )}
    </>
  )
}
