// Human-in-the-loop card: Allow once / Always allow / Deny / Never allow.

import clsx from 'clsx'
import { Ban, Check, ChevronDown, ChevronRight, Clock, ShieldQuestion } from 'lucide-react'
import { useState } from 'react'
import type { ApprovalDecision, Entry } from '@shared/domain'
import { useData } from '../../store/data'
import { resolveApproval } from '../../store/actions'
import { approvalOutcome, approvalQuestion, prettyJson } from '../../lib/tools'
import { plainPreview } from '../../lib/format'
import { Button } from '../ui/Button'
import { Markdown } from './Markdown'

export function ApprovalCard({ entry, conversationBotIds }: { entry: Entry; conversationBotIds: string[] }) {
  const approval = entry.approval
  const bot = useData((s) => (entry.author.kind === 'bot' ? s.botMap.get(entry.author.botId) : undefined))
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState<ApprovalDecision | null>(null)
  if (!approval) return null

  const name = bot?.name ?? 'This bot'
  const fromElsewhere = bot && !conversationBotIds.includes(bot.id)

  if (approval.status !== 'pending') {
    const result = approvalOutcome(approval)
    const Icon = approval.status === 'expired' ? Clock : result.allowed ? Check : Ban
    return (
      <div className="flex max-w-[min(100%,620px)] items-center gap-2 rounded-[10px] border border-line-soft px-2.5 py-1.5 text-[12.5px]">
        <Icon size={14} className={clsx('shrink-0', result.allowed ? 'text-success-fg' : 'text-fg-3')} />
        <span className="shrink-0 font-medium text-fg-2">{result.label}</span>
        <span className="min-w-0 flex-1 truncate text-fg-3" title={approval.summary}>{plainPreview(approval.summary, 200)}</span>
      </div>
    )
  }

  const decide = async (decision: ApprovalDecision) => {
    setBusy(decision)
    await resolveApproval(approval.approvalId, decision)
    setBusy(null)
  }

  return (
    <div
      role="group"
      aria-label="Review an action"
      className="max-w-[min(100%,620px)] rounded-xl border border-warn/35 bg-elevated shadow-pop"
    >
      <div className="flex gap-2.5 px-3.5 pb-2 pt-3">
        <ShieldQuestion size={18} className="mt-px shrink-0 text-warn-fg" />
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold text-fg">{approvalQuestion(name, approval.toolName)}</div>
          {fromElsewhere && <div className="mt-0.5 text-[12px] text-fg-3">Asked while {name} was helping another bot</div>}
          <Markdown text={approval.summary} className="mt-1.5 !text-[13px] text-fg-2" />
          <button
            type="button"
            onClick={() => setDetails((v) => !v)}
            className="mt-1.5 flex items-center gap-1 text-[12px] font-medium text-fg-3 hover:text-fg-2"
            aria-expanded={details}
          >
            {details ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            View the full request
          </button>
          {details && (
            <pre className="selectable mt-1.5 max-h-56 overflow-auto rounded-lg border border-line-soft bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">
              <span className="text-fg-4">{approval.toolName}</span>
              {'\n'}
              {prettyJson(approval.input)}
            </pre>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-3.5 py-2.5">
        <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void decide('allow_once')}>
          Allow once
        </Button>
        <Button size="sm" disabled={!!busy} onClick={() => void decide('always')} title={`Never ask again for ${approval.toolName} from ${name}`}>
          Always allow
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void decide('deny')}>
          Deny
        </Button>
        <Button size="sm" variant="danger-ghost" disabled={!!busy} onClick={() => void decide('never')} title={`Always deny ${approval.toolName} for ${name}`}>
          Never allow
        </Button>
      </div>
    </div>
  )
}
