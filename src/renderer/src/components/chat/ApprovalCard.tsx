// Approval in chat: Allow once and Deny. Standing allow and never rules stay in the bot's Tools tab.

import clsx from 'clsx'
import { Ban, Check, ChevronDown, ChevronRight, Clock } from 'lucide-react'
import { useState } from 'react'
import type { ApprovalDecision, Entry } from '@shared/domain'
import { useData } from '../../store/data'
import { resolveApproval } from '../../store/actions'
import { approvalOutcome, approvalQuestion, commandOf, prettyJson, visibleToolLabel } from '../../lib/tools'
import { plainPreview } from '../../lib/format'
import { ApprovalCard as UiApprovalCard } from '../ui/approval-card-clean'

export const APPROVAL_EMPTY_COMMAND = 'This request has no command.'

export function ApprovalCard({ entry, conversationBotIds }: { entry: Entry; conversationBotIds: string[] }) {
  const approval = entry.approval
  const bot = useData((s) => (entry.author.kind === 'bot' ? s.botMap.get(entry.author.botId) : undefined))
  const [details, setDetails] = useState(false)
  const [busy, setBusy] = useState<ApprovalDecision | null>(null)
  if (!approval) return null

  const name = bot?.name ?? 'This bot'
  const fromElsewhere = bot && !conversationBotIds.includes(bot.id)
  const command = commandOf(approval.input)

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

  const decide = async (decision: 'allow_once' | 'deny') => {
    setBusy(decision)
    await resolveApproval(approval.approvalId, decision)
    setBusy(null)
  }

  return (
    <div role="group" aria-label="Review an action" className="w-full max-w-[min(100%,620px)]">
      <UiApprovalCard
        title={approvalQuestion(name, approval.toolName)}
        description={approval.summary}
        label={visibleToolLabel(approval.toolName)}
        approveLabel="Allow once"
        denyLabel="Deny"
        allowAlways={false}
        shortcuts={false}
        actions="card"
        onApprove={() => decide('allow_once')}
        onDeny={() => decide('deny')}
      >
        <div className="space-y-2">
          {fromElsewhere && <p className="text-[12px] text-fg-3">Asked while {name} was helping another bot</p>}
          {command ? (
            <pre className="selectable overflow-x-auto rounded-lg bg-sunken px-3 py-2 font-mono text-[12px] leading-5 text-fg" aria-label="Command">{command}</pre>
          ) : (
            <p className="text-[13px] text-fg-3">{APPROVAL_EMPTY_COMMAND}</p>
          )}
          <button
            type="button"
            onClick={() => setDetails((open) => !open)}
            className="flex items-center gap-1 text-[12px] font-medium text-fg-3 hover:text-fg"
            aria-expanded={details}
            disabled={!!busy}
          >
            {details ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            View the full request
          </button>
          {details && (
            <pre className="selectable max-h-56 overflow-auto rounded-lg border border-line-soft bg-sunken px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-fg-2">
              {prettyJson(approval.input) || '(none)'}
            </pre>
          )}
        </div>
      </UiApprovalCard>
    </div>
  )
}
