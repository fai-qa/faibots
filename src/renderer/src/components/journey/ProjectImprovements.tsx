import { useState } from 'react'
import type { ImprovementCandidate, Improvements, TrialCase } from '@shared/project-improvements'
import { invoke } from '../../lib/bridge'
import { useAsync } from '../../lib/hooks'
import { Button } from '../ui/Button'

const field = 'w-full rounded border border-line-soft bg-panel px-2 py-1.5 text-ui'
const lanes: { id: TrialCase; title: string }[] = [{ id: 'matched', title: 'Matched' }, { id: 'heldout', title: 'Held-out' }]
type Act = (operation: () => Promise<unknown>) => Promise<void>

function Correction({ projectId, candidate, data, act, busy }: {
  projectId: string; candidate: ImprovementCandidate; data: Improvements; act: Act; busy: boolean
}) {
  const req = { projectId, candidateId: candidate.id }
  const trials = data.trials.filter((t) => t.candidateId === candidate.id)
  const active = data.active?.id === candidate.id
  const ready = lanes.every((lane) => trials.find((t) => t.lane === lane.id)?.observed === 'passed')
  return <article className="space-y-2 border-t border-line-soft pt-3">
    <div className="text-ui font-semibold">Version {candidate.version} · {active ? 'Active' : candidate.decision}</div>
    <p className="text-ui">{candidate.instruction}</p>
    <p className="text-fg-2 text-xs">Required text · {candidate.requiredText}</p>
    {candidate.decision === 'proposed' && <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy} onClick={() => void act(() => invoke('improvement:review', { ...req, decision: 'approved' }))}>Approve for trials</Button>
      <Button size="sm" disabled={busy} onClick={() => void act(() => invoke('improvement:review', { ...req, decision: 'rejected' }))}>Reject</Button>
    </div>}
    {candidate.decision === 'approved' && <div className="space-y-2">
      {lanes.map((lane) => {
        const t = trials.find((trial) => trial.lane === lane.id)
        return <div key={lane.id}>
          <div className="flex flex-wrap items-center gap-2"><Button size="sm" disabled={busy || trials.some((trial) => trial.observed === 'pending')}
            onClick={() => void act(() => invoke('improvement:trial', { ...req, lane: lane.id }))}>Run {lane.title.toLowerCase()} trial</Button>
            <span className="text-xs text-fg-2">{t?.observed ?? 'Awaiting trial'}</span></div>
          {t && <p className="mt-1 text-xs text-fg-2">Run {t.runId.slice(0,8)} · {t.reason || 'Waiting for the draft and review.'}{t.sha256 ? ` Output SHA-256 ${t.sha256.slice(0,12)}.` : ''}</p>}
        </div>
      })}
      {active ? <Button size="sm" disabled={busy} onClick={() => void act(() => invoke('improvement:rollback',req))}>Roll back version {candidate.version}</Button>
        : <Button size="sm" disabled={busy || !ready || (data.active?.id ?? null) !== candidate.base}
          onClick={() => void act(() => invoke('improvement:publish',req))}>Publish to this project</Button>}
    </div>}
  </article>
}

export function ProjectImprovements({ projectId, version }: { projectId: string; version: number }) {
  const [refresh, setRefresh] = useState(0)
  const [error,setError] = useState(''), [busy,setBusy] = useState(false)
  const [instruction,setInstruction] = useState(''), [requiredText,setRequired] = useState('')
  const [matched,setMatched] = useState(''), [heldout,setHeldout] = useState('')
  const state = useAsync(() => invoke('improvement:list',{ projectId }),[projectId,version,refresh])
  const data = state.data
  const act: Act = async (operation) => {
    setBusy(true); setError('')
    try { await operation(); setRefresh((n) => n + 1) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <details className="rounded-card border border-line-soft bg-sidebar p-4">
    <summary className="cursor-pointer text-sm font-semibold">Project instructions{data?.active ? ` · Version ${data.active.version}` : ''}</summary>
    <div className="mt-3 space-y-3">
      {(error || state.error) && <p role="alert" className="text-xs text-fg">{error || state.error}</p>}
      {data && <>
        <p className="text-xs text-fg-2">{data.active?.instruction || 'Propose a correction for future proposals. Each trial runs a new draft and review using this project’s configured models.'}</p>
        {data.cases.length < 2 ? <p className="text-xs text-fg-2">Two reviewed runs with different source notes are needed to test a correction.</p> :
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void act(async () => {
            await invoke('improvement:propose',{ projectId,instruction,requiredText,matched,heldout })
            setInstruction(''); setRequired('')
          }) }}>
            <label className="block text-xs">Project correction<textarea className={field} required minLength={3} maxLength={2000} value={instruction} onChange={(e) => setInstruction(e.target.value)} /></label>
            <label className="block text-xs">Exact text a passing output must include<input className={field} required maxLength={400} value={requiredText} onChange={(e) => setRequired(e.target.value)} /></label>
            {lanes.map((lane) => <label key={lane.id} className="block text-xs">{lane.title} baseline
              <select className={field} required value={lane.id === 'matched' ? matched : heldout} onChange={(e) => lane.id === 'matched' ? setMatched(e.target.value) : setHeldout(e.target.value)}>
                <option value="">Select a reviewed run</option>{data.cases.map((c) => <option key={c.runId} value={c.runId}>{c.name}</option>)}
              </select></label>)}
            <Button size="sm" type="submit" disabled={busy || !matched || matched === heldout}>Propose correction</Button>
          </form>}
        {data.candidates.map((c) => <Correction key={c.id} projectId={projectId} candidate={c} data={data} act={act} busy={busy} />)}
        {data.production.length > 0 && <details><summary className="cursor-pointer text-xs">Recent proposal checks</summary><ul className="mt-2 space-y-1 text-xs text-fg-2">
          {data.production.map((r) => <li key={r.runId}>Version {r.version} · {r.observed} · {r.reason || 'Run in progress.'}</li>)}
        </ul></details>}
        {data.history.length > 0 && <details><summary className="cursor-pointer text-xs">Release history</summary><ul className="mt-2 space-y-1 text-xs text-fg-2">
          {data.history.map((h,i) => <li key={i}>{new Date(h.at).toLocaleString()} · {h.action === 'publish' ? 'Published' : 'Rolled back to'} {h.version ? `version ${h.version}` : 'the project default'}</li>)}
        </ul></details>}
      </>}
    </div>
  </details>
}
