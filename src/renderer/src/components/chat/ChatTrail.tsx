// The affectUI trail on a bot turn. Steps come from the turn's real tool calls and
// approvals. The file src/components/ui/agent-trail-clean.tsx is reused, not copied.

import type { Bot, Entry, ToolCallInfo } from '@shared/domain'
import { approvalQuestion, commandOf, visibleToolLabel } from '../../lib/tools'
import { BotAvatar } from '../avatar/BotAvatar'
import { AgentTrail, type TrailStep, type TrailStepState, type TrailSubstep } from '../ui/agent-trail-clean'

function stepState(call: ToolCallInfo): TrailStepState {
  switch (call.status) {
    case 'done':
      return 'done'
    case 'running':
      return 'running'
    case 'denied':
    case 'cancelled':
      return 'declined'
    default:
      return 'failed'
  }
}

function facts(call: ToolCallInfo): TrailSubstep[] {
  const input = call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>) : {}
  const subs: TrailSubstep[] = []
  const command = commandOf(call.input)
  if (command) subs.push({ id: `${call.callId}-command`, title: command })
  if (typeof input.path === 'string' && input.path.trim()) subs.push({ id: `${call.callId}-path`, title: input.path })
  if (call.toolName === 'send_to_agent' && typeof input.to === 'string' && input.to !== call.toolName && !input.to.startsWith('mcp__')) {
    subs.push({ id: `${call.callId}-to`, title: `To ${input.to.replace(/^@/, '')}` })
  }
  if (call.resultText?.trim()) subs.push({ id: `${call.callId}-result`, title: call.resultText.trim() })
  return subs
}

function runningWord(call: ToolCallInfo, activity?: string): string {
  const plain = visibleToolLabel(call.toolName, call.title)
  if (activity && !activity.includes(call.toolName) && !activity.includes('mcp__')) return activity
  return plain
}

/** Steps for one bot turn. Titles are plain words. Nothing here is a raw tool id or a model id. */
export function trailSteps(entries: Entry[], botName: string, activity?: string): TrailStep[] {
  const steps: TrailStep[] = []
  for (const entry of entries) {
    const call = entry.toolCall
    if (call && call.toolName !== 'pass_turn') {
      const state = stepState(call)
      const elapsed = entry.updatedAt - entry.createdAt
      steps.push({
        id: call.callId || entry.id,
        title: visibleToolLabel(call.toolName, call.title),
        state,
        substeps: facts(call),
        ...(state === 'done' && Number.isFinite(elapsed) && elapsed >= 0 ? { duration: elapsed } : {}),
        ...(state === 'running' ? { startedAt: entry.createdAt, status: runningWord(call, activity) } : {})
      })
    }
    const approval = entry.approval
    if (!approval) continue
    const decision = approval.decision
    const state: TrailStepState =
      approval.status === 'pending'
        ? 'waiting'
        : approval.status === 'expired'
          ? 'failed'
          : decision === 'deny' || decision === 'never'
            ? 'declined'
            : 'done'
    steps.push({
      id: approval.approvalId,
      title: visibleToolLabel(approval.toolName),
      state,
      gate: approval.status === 'pending',
      ask: approvalQuestion(botName, approval.toolName)
    })
  }
  return steps
}

export function ChatTrail({ bot, entries, title, activity }: { bot: Bot; entries: Entry[]; title?: string; activity?: string }) {
  const steps = trailSteps(entries, bot.name, activity)
  if (steps.length === 0) return null
  const task = title?.trim() || activity?.trim() || undefined
  return (
    <div className="w-full max-w-[min(100%,620px)]">
      <AgentTrail
        steps={steps}
        title={task}
        agent={{ name: bot.name, logo: <BotAvatar bot={bot} size={12} /> }}
      />
    </div>
  )
}
