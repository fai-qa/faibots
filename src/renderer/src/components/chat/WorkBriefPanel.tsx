import { useEffect, useState } from 'react'
import type { WorkBrief, WorkDecision } from '@shared/work-brief'
import { errorMessage, invoke, on } from '../../lib/bridge'

const stateLabels = {
  waiting: 'Waiting for specialists', active: 'In progress', needs_input: 'Needs your answer', review: 'Ready for review',
  accepted: 'Accepted', cancelled: 'Cancelled'
} as const

export function WorkBriefPanel({ conversationId }: { conversationId: string }) {
  const [briefs, setBriefs] = useState<WorkBrief[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let sequence = 0
    function refresh() {
      const request = ++sequence
      void invoke('work:list', { conversationId }).then((rows) => {
        if (sequence === request) { setBriefs(rows); setError('') }
      }).catch((cause) => { if (sequence === request) setError(errorMessage(cause)) })
    }
    const unsubscribe = on('work:changed', (event) => { if (event.conversationId === conversationId) refresh() })
    refresh()
    return () => { sequence++; unsubscribe() }
  }, [conversationId])

  if (!briefs.length && !error) return null
  return (
    <aside aria-label="Work in this chat" className="max-h-[38%] overflow-y-auto border-b border-line-soft px-4 py-1 text-[12.5px] text-fg">
      {error && <p role="alert">{error}</p>}
      {briefs.map((brief) => <BriefCard key={brief.id} brief={brief} />)}
    </aside>
  )
}

function BriefCard({ brief }: { brief: WorkBrief }) {
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const canSteer = brief.state === 'active' || brief.state === 'waiting'
  const needsOwner = brief.state === 'needs_input' || brief.state === 'review'
  useEffect(() => { setDetailsOpen(needsOwner); setNote(''); setError('') }, [needsOwner, brief.revision])
  async function decide(decision: WorkDecision) {
    setPending(true)
    setError('')
    try {
      await invoke('work:decide', { id: brief.id, conversationId: brief.conversationId, revision: brief.revision, decision,
        note: ['answer','request_changes','steer'].includes(decision) ? note : '' })
    } catch (cause) {
      setError(errorMessage(cause))
    } finally { setPending(false) }
  }
  const button = 'rounded-md border border-line px-2 py-1 font-medium hover:bg-hover disabled:opacity-50'
  return (
    <details open={detailsOpen} onToggle={(e) => setDetailsOpen(e.currentTarget.open)} className="py-1">
      <summary className="cursor-pointer font-medium">{brief.objective} <span className="font-normal text-fg-3">· {stateLabels[brief.state]}</span></summary>
      <div className="space-y-2 py-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-fg-3">Deliverable</dt><dd>{brief.deliverable}</dd>
          <dt className="text-fg-3">Checks</dt><dd>{brief.checks}</dd>
          {brief.lastInstruction && <><dt className="text-fg-3">Your instruction</dt><dd>{brief.lastInstruction}</dd></>}
        </dl>
        {brief.state === 'needs_input' && <p className="whitespace-pre-wrap">{brief.question}</p>}
        {brief.result && <div><strong>{brief.partial ? 'Partial result' : 'Result'}</strong><p className="whitespace-pre-wrap">{brief.result}</p></div>}
        {(needsOwner || canSteer) && <textarea aria-label={canSteer ? 'Update this job' : brief.state === 'review' ? 'Requested changes' : 'Your answer'} placeholder={canSteer ? 'Change the instructions for this job' : brief.state === 'review' ? 'What needs to change?' : 'Your answer'} value={note} onChange={(e) => setNote(e.target.value)} maxLength={8000} className="w-full rounded-md border border-line bg-pane px-2 py-1" />}
        <div className="flex flex-wrap gap-2">
          {canSteer && <button className={button} disabled={pending || !note.trim()} onClick={() => void decide('steer')}>Update this job</button>}
          {brief.state === 'needs_input' && <button className={button} disabled={pending || !note.trim()} onClick={() => void decide('answer')}>Send answer</button>}
          {brief.state === 'review' && <>
            <button className={button} disabled={pending} onClick={() => void decide('accept')}>{brief.partial ? 'Accept partial result' : 'Accept result'}</button>
            <button className={button} disabled={pending || !note.trim()} onClick={() => void decide('request_changes')}>Request changes</button>
          </>}
          {(brief.state === 'active' || brief.state === 'waiting' || needsOwner) && <button className={button} disabled={pending} onClick={() => void decide('cancel')}>Cancel work</button>}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    </details>
  )
}
