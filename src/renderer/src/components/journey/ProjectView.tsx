// The project screen (M1b + M1c journey slices): attach note files, run the mission (the
// primary bot drafts the deliverable, the host snapshots it, one bot reviews it), and watch
// the honest run states. Nothing here invents a state: every chip comes from recorded rows.

import { FileCheck2, FileText, Paperclip, ChevronDown, Rocket } from 'lucide-react'
import { useState } from 'react'
import type { ArtifactWithRevisions } from '@shared/ipc'
import type { JourneyRun, ProjectSource, ReviewDecision } from '@shared/domain'
import { invoke } from '../../lib/bridge'
import { useAsync } from '../../lib/hooks'
import { formatBytes, formatFull, plural } from '../../lib/format'
import { useData } from '../../store/data'
import { toast } from '../../store/ui'
import { attachProjectNotes, pickNoteFiles, startMission } from '../../store/actions'
import { Markdown } from '../chat/Markdown'
import { Badge, EmptyState, Spinner } from '../ui/Badge'
import { Button } from '../ui/Button'
import { StatusChip } from './StatusChip'
import { RunDetails } from './RunDetails'
import { AgentTrail, type TrailStep } from '../ui/agent-trail-clean'

const SHA_PREFIX = 12
const REVIEW_PRESENTATION = {
  accepted: { label: 'Accepted by bot', tone: 'success' },
  repair: { label: 'Changes requested', tone: 'warn' },
  rejected: { label: 'Rejected by bot', tone: 'danger' },
  partial: { label: 'Review incomplete', tone: 'neutral' }
} as const

export function ProjectView({ projectId }: { projectId: string }) {
  const project = useData((s) => s.projects.find((p) => p.id === projectId))
  // The journey version bumps on every push from the main process, so panels refetch honestly.
  const journeyVersion = useData((s) => s.versions.journey[projectId] ?? 0)
  const sources = useAsync(() => invoke('projects:list-sources', { projectId }), [projectId, journeyVersion])
  const artifacts = useAsync(() => invoke('artifacts:list', { projectId }), [projectId, journeyVersion])
  const runs = useAsync(() => invoke('projects:list-runs', { projectId, limit: 10 }), [projectId, journeyVersion])
  const [attaching, setAttaching] = useState(false)
  const [starting, setStarting] = useState(false)

  if (!project) {
    return (
      <section className="flex flex-1 flex-col bg-pane">
        <div className="drag h-[52px] shrink-0 border-b border-line-soft" />
        <EmptyState icon={FileText} title="Project not found">
          It may have been removed. Pick another project from the sidebar.
        </EmptyState>
      </section>
    )
  }

  const sourceCount = sources.data?.length ?? 0
  const ready = sourceCount > 0
  const runList = runs.data ?? []
  const activeRun = runList.find((r) => r.status === 'working' || r.status === 'waiting_review')
  const latestRun = runList[0]
  const currentRun = activeRun ?? latestRun
  const artifactRows = [...(artifacts.data ?? [])].reverse()
  const currentArtifact = artifactRows.find((row) => row.artifact.id === currentRun?.artifactId)
  const firstSavedArtifact = artifactRows.find((row) => row.revisions.length > 0)
  const otherArtifacts = artifactRows.filter((row) => row !== firstSavedArtifact)

  const attach = async () => {
    const paths = await pickNoteFiles()
    if (paths.length === 0) return
    setAttaching(true)
    try {
      const added = await attachProjectNotes(projectId, paths)
      if (added && added.length > 0) {
        toast(`Attached ${plural(added.length, 'note')} to ${project.name}.`, 'success')
        sources.reload()
      }
    } finally {
      setAttaching(false)
    }
  }

  const mission = async () => {
    setStarting(true)
    try {
      if (await startMission(projectId)) {
        toast(`The mission for ${project.name} started. It runs in the background.`, 'success')
        runs.reload()
        artifacts.reload()
      }
    } finally {
      setStarting(false)
    }
  }

  return (
    <section className="flex flex-1 flex-col bg-pane">
      <div className="drag h-[52px] shrink-0 border-b border-line-soft" />
      <div className="scroll-y min-h-0 flex-1">
        <div className="mx-auto flex max-w-[720px] flex-col gap-7 p-8">
          <header>
            <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-fg">{project.name}</h1>
            {project.description && <p className="mt-1 text-[13px] text-fg-3 selectable">{project.description}</p>}
            <p className="mt-1.5 text-[12px] text-fg-4">
              Created {formatFull(project.createdAt)} · {plural(sourceCount, 'note')} attached
            </p>
          </header>

          {/* Notes ------------------------------------------------------------------ */}
          <section aria-label="Notes">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold text-fg">Notes</h2>
              <StatusChip tone="built" title="Attaching notes works locally: the files are copied into this app's attachment store." />
            </div>
            {ready ? (
              <>
                <ul className="overflow-hidden rounded-inner border border-line-soft bg-elevated">
                  {sources.data!.map((source) => (
                    <SourceRow key={source.id} source={source} />
                  ))}
                </ul>
                <div className="mt-2">
                  <Button icon={Paperclip} onClick={() => void attach()} disabled={attaching} aria-busy={attaching}>
                    {attaching ? 'Attaching…' : 'Attach notes'}
                  </Button>
                </div>
              </>
            ) : (
              <EmptyState
                icon={Paperclip}
                title="No notes attached"
                action={
                  <Button variant="primary" icon={Paperclip} onClick={() => void attach()} disabled={attaching}>
                    {attaching ? 'Attaching…' : 'Attach notes'}
                  </Button>
                }
              >
                Use Markdown (.md) or plain text (.txt) notes up to 10 MB each. fai reads what you
                attach here.
              </EmptyState>
            )}
          </section>

          {/* Mission ----------------------------------------------------------------- */}
          <section aria-label="Mission">
            <div className="rounded-card border border-line-soft bg-sidebar p-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-fg">
                  <Rocket size={14} className="text-fg-3" />
                  Mission
                </h2>
                {(!currentRun || !activeRun) && <RunStatusChip run={currentRun} ready={ready} />}
              </div>
              {!currentRun && <p className="mt-1.5 text-[12.5px] text-fg-3">Draft a proposal from the notes and have a second bot review it.</p>}
              {currentRun && <MissionTrail run={currentRun} artifact={currentArtifact} />}
              <div className="mt-3">
                <Button
                  variant="primary"
                  icon={Rocket}
                  onClick={() => void mission()}
                  disabled={!ready || !!activeRun || starting}
                  aria-busy={starting}
                  title={
                    activeRun
                      ? 'A mission is already running.'
                      : !ready
                        ? 'Attach notes first.'
                        : 'Start the mission for the attached notes.'
                  }
                >
                  {starting ? 'Starting…' : activeRun ? 'Mission running' : 'Start the mission'}
                </Button>
              </div>
              {runList.length > 0 && (
                <details className="mt-3 border-t border-line-soft pt-3">
                  <summary className="cursor-pointer text-[12.5px] font-medium text-fg-2">
                    Run history <span className="text-fg-4">({runList.length})</span>
                  </summary>
                  <ul className="mt-2 divide-y divide-line-soft">
                    {runList.map((run) => <RunRow key={run.id} run={run} />)}
                  </ul>
                </details>
              )}
            </div>
          </section>

          {/* Artifacts & review ------------------------------------------------------- */}
          <section aria-label="Artifacts and review">
            <h2 className="mb-2 text-[13px] font-semibold text-fg">Artifacts & review</h2>
            {artifactRows.length ? (
              <div className="flex flex-col gap-3">
                {firstSavedArtifact && <ArtifactCard key={firstSavedArtifact.artifact.id} row={firstSavedArtifact} />}
                {otherArtifacts.length > 0 && (
                  <details className="rounded-inner border border-line-soft px-3 py-2">
                    <summary className="cursor-pointer text-[12.5px] font-medium text-fg-2">
                      {firstSavedArtifact ? 'Other artifacts' : 'Run artifacts'} <span className="text-fg-4">({otherArtifacts.length})</span>
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">
                      {otherArtifacts.map((row) => <ArtifactCard key={row.artifact.id} row={row} />)}
                    </div>
                  </details>
                )}
              </div>
            ) : (
              <EmptyState icon={FileCheck2} title="No artifacts yet">
                The mission run writes the deliverable here as snapshot revisions, each checked against the rubric.
                Review comes with the run.
              </EmptyState>
            )}
          </section>
        </div>
      </div>
    </section>
  )
}

function SourceRow({ source }: { source: ProjectSource }) {
  return (
    <li className="flex items-center gap-2.5 px-3 py-2.5">
      <FileText size={15} className="shrink-0 text-fg-3" />
      <span className="min-w-0 flex-1 truncate text-ui font-medium text-fg">{source.name}</span>
      <Badge tone="neutral">{source.kind}</Badge>
      <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-fg-3">{formatBytes(source.sizeBytes)}</span>
      <span className="hidden selectable font-mono text-[12px] text-fg-4 sm:inline" title={source.sha256}>
        {source.sha256.slice(0, SHA_PREFIX)}…
      </span>
    </li>
  )
}

function MissionTrail({ run, artifact }: { run: JourneyRun; artifact?: ArtifactWithRevisions }) {
  const revision = artifact?.revisions.at(-1)
  const review = revision?.reviews.at(-1)
  const draftState: TrailStep['state'] = revision ? 'done' : run.status === 'working' ? 'running' : run.status === 'failed' ? 'failed' : 'pending'
  const reviewState: TrailStep['state'] = review
    ? review.decision === 'partial' ? 'failed' : 'done'
    : run.status === 'waiting_review' ? 'running' : revision && run.status === 'failed' ? 'failed' : 'pending'
  const steps: TrailStep[] = [
    {
      id: `${run.id}-draft`,
      title: 'Draft from selected notes',
      state: draftState,
      ...(draftState === 'running' ? { startedAt: run.startedAt, status: 'Drafting' } : {})
    },
    {
      id: `${run.id}-review`,
      title: 'Review the saved proposal',
      state: reviewState,
      ...(reviewState === 'running' ? { status: 'Reviewing' } : {}),
      ...(review?.decision === 'repair' ? { duration: 'Changes requested' } : {}),
      ...(review?.decision === 'rejected' ? { duration: 'Rejected by reviewer' } : {})
    }
  ]
  return <AgentTrail className="mt-3" steps={steps} labels={{ title: 'Proposal progress', done: 'Recorded' }} />
}

function RunStatusChip({ run, ready }: { run?: JourneyRun; ready: boolean }) {
  if (!run) {
    return (
      <StatusChip
        tone={ready ? 'built' : 'next'}
        title={
          ready
            ? 'A mission can start with the attached notes.'
            : 'Next: the mission starts after notes are attached.'
        }
      />
    )
  }
  switch (run.status) {
    case 'working':
      return (
        <span role="status" className="inline-flex items-center gap-2 text-sm text-fg-2">
          <Spinner size={14} />
          Drafting the proposal
        </span>
      )
    case 'waiting_review':
      return (
        <span role="status" className="inline-flex items-center gap-2 text-sm text-fg-2">
          <Spinner size={14} />
          Waiting for the reviewer
        </span>
      )
    case 'complete':
      return <span className="text-sm font-medium text-fg">Complete</span>
    case 'partial':
      return <Badge tone="warn">Partial</Badge>
    case 'failed':
      return <Badge tone="danger">Failed</Badge>
  }
  return null
}

function RunRow({ run }: { run: JourneyRun }) {
  const finished = run.status === 'complete' || run.status === 'partial' || run.status === 'failed'
  const [open, setOpen] = useState(false)
  return (
    <li className="py-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!finished}
          aria-expanded={finished ? open : undefined}
          aria-label={finished ? (open ? 'Hide run details' : 'Show run details') : undefined}
          title={finished ? 'Recorded budgets for this run' : 'Details appear when the run finishes'}
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-3 ${finished ? 'hover:bg-hover hover:text-fg' : 'opacity-40'}`}
        >
          <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-3" title={run.error}>
          {formatFull(run.startedAt)} · {run.endedAt ? `took ${Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s` : 'in progress'}
          {run.error ? ` — ${run.error}` : ''}
        </span>
        <RunStatusChip run={run} ready />
      </div>
      {open && finished && <RunDetails run={run} />}
    </li>
  )
}

function ReviewChip({ reviews }: { reviews: ReviewDecision[] }) {
  const botMap = useData((s) => s.botMap)
  const last = reviews[reviews.length - 1]
  if (!last) {
    return <StatusChip tone="next" title="Next: no review decision has been recorded for this revision yet." />
  }
  const reviewer = botMap.get(last.reviewer)?.name ?? 'a reviewer'
  const { label, tone } = REVIEW_PRESENTATION[last.decision]
  return (
    <Badge tone={tone} title={`${reviewer} reviewed this revision: ${last.explanation || 'no explanation recorded'}`}>
      {label} · {reviewer}
    </Badge>
  )
}

function LatestBotReview({ review, revisionNo }: { review: ReviewDecision; revisionNo: number }) {
  const reviewer = useData((s) => s.botMap.get(review.reviewer)?.name)
  const { label, tone } = REVIEW_PRESENTATION[review.decision]
  const explanation = review.explanation.trim()

  return (
    <section aria-label={`Bot review for revision ${revisionNo}`} className="mt-3 rounded-inner border border-line-soft bg-pane px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-fg">
          Bot review <span className="font-normal text-fg-3">· r{revisionNo}{reviewer ? ` · ${reviewer}` : ''}</span>
        </h4>
        <Badge tone={tone}>{label}</Badge>
      </div>
      {explanation && <p className="selectable mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg-2">{explanation}</p>}
    </section>
  )
}

function ArtifactCard({ row }: { row: ArtifactWithRevisions }) {
  const latestRevision = row.revisions.at(-1)
  const latestReview = latestRevision?.reviews.at(-1)

  return (
    <div className="rounded-card border border-line-soft bg-elevated p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-ui font-semibold text-fg">
          <FileCheck2 size={14} className="text-fg-3" />
          {row.artifact.name}
        </h3>
        <span className="flex items-center gap-2 text-[12px] text-fg-3">
          {row.artifact.status === 'reviewed' ? (
            <StatusChip tone="built" title="A review decision was recorded against the latest revision." />
          ) : (
            <StatusChip tone="next" title="Next: review comes with the mission run." />
          )}
          {plural(row.revisions.length, 'revision')}
        </span>
      </div>
      {row.revisions.length > 0 ? (
        <ul className="mt-2 divide-y divide-line-soft">
          {row.revisions.map((revision) => (
            <li key={revision.id} className="flex flex-wrap items-center gap-2 py-1.5">
              <span className="shrink-0 rounded-pill bg-active px-1.5 py-px font-mono text-2xs font-medium text-fg-2">
                r{revision.revisionNo}
              </span>
              <span className="shrink-0 selectable font-mono text-[12px] text-fg-3" title={revision.sha256}>
                {revision.sha256.slice(0, SHA_PREFIX)}…
              </span>
              <StatusChip tone="built" title="The snapshot record exists in the local database." />
              {(!latestReview || revision.id !== latestRevision?.id) && (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[12px] text-fg-3">
                  Review
                  <ReviewChip reviews={revision.reviews} />
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-3">
          No revisions yet.
          <StatusChip tone="next" title="Next: revisions appear when the mission runs." />
        </p>
      )}
      {latestRevision && latestReview && <LatestBotReview review={latestReview} revisionNo={latestRevision.revisionNo} />}
      {row.content && (
        <details className="mt-3 overflow-hidden rounded-inner border border-line-soft">
          <summary className="cursor-pointer select-none px-3 py-2 text-[12.5px] font-medium text-fg-2 hover:text-fg">
            Latest revision
          </summary>
          <div className="border-t border-line-soft bg-pane px-4 py-3">
            <Markdown text={row.content} />
          </div>
        </details>
      )}
    </div>
  )
}
