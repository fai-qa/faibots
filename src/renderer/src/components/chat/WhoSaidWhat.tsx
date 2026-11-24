// Group overview. The list is the default. The map is the affectUI graph, behind Show as map.
// Every line and every node comes from this conversation. Nothing is invented.

import { useMemo, useState } from 'react'
import type { Bot, BotPhase, Conversation, Entry } from '@shared/domain'
import { findBotByRef } from '../../lib/bots'
import { approvalQuestion, visibleToolLabel } from '../../lib/tools'
import { useData } from '../../store/data'
import { BotAvatar } from '../avatar/BotAvatar'
import { AgentGraph, type GraphCall, type GraphNode, type GraphNodeStatus } from 'agent-graph-clean'
import { eventLineText } from './EventLine'

export interface OverviewLine {
  id: string
  who: string
  text: string
}

export interface OverviewGraph {
  nodes: GraphNode[]
  calls: GraphCall[]
  edges: [string, string][]
  botCount: number
}

function whoOf(entry: Entry, bots: Map<string, Bot>): string {
  if (entry.author.kind === 'user') return 'You'
  if (entry.author.kind === 'system') return 'faibots'
  return bots.get(entry.author.botId)?.name ?? 'A bot'
}

function firstLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line
}

/** The conversation in order. Pass lines use the same words as the chat. */
export function overviewLines(entries: Entry[], bots: Map<string, Bot>): OverviewLine[] {
  const lines: OverviewLine[] = []
  for (const entry of entries) {
    const who = whoOf(entry, bots)
    const botName = entry.author.kind === 'bot' ? bots.get(entry.author.botId)?.name : undefined
    if (entry.kind === 'event' || (entry.kind === 'tool-call' && entry.toolCall?.toolName === 'pass_turn')) {
      const text = eventLineText(entry, botName)
      if (text.trim()) lines.push({ id: entry.id, who, text })
      continue
    }
    if (entry.kind === 'message' && entry.text.trim()) {
      lines.push({ id: entry.id, who, text: entry.text })
      continue
    }
    if (entry.kind === 'tool-call' && entry.toolCall && entry.toolCall.toolName !== 'pass_turn') {
      lines.push({ id: entry.id, who, text: visibleToolLabel(entry.toolCall.toolName, entry.toolCall.title) })
      continue
    }
    if (entry.kind === 'approval' && entry.approval) {
      lines.push({ id: entry.id, who, text: approvalQuestion(botName ?? 'This bot', entry.approval.toolName) })
    }
  }
  return lines
}

function liveStatus(phase: BotPhase | undefined): GraphNodeStatus {
  if (phase === 'thinking' || phase === 'typing' || phase === 'tool' || phase === 'reading') return 'working'
  if (phase === 'waiting') return 'waiting'
  return 'idle'
}

/** Bots in this conversation, plus You. Calls are the messages and exchanges that actually happened. */
export function overviewGraph(
  conv: Conversation,
  bots: Map<string, Bot>,
  entries: Entry[],
  phases: Map<string, BotPhase | undefined>
): OverviewGraph {
  const members = conv.botIds.flatMap((id) => {
    const bot = bots.get(id)
    return bot ? [bot] : []
  })
  const lead = members.find((bot) => bot.isPrimary) ?? members[0]
  const nodes: GraphNode[] = [
    { id: 'you', kind: 'user', name: 'You' },
    ...members.map((bot) => ({
      id: bot.id,
      kind: 'agent' as const,
      name: bot.name,
      detail: bot.label.trim() || undefined,
      lead: bot.id === lead?.id,
      status: liveStatus(phases.get(bot.id)),
      icon: <BotAvatar bot={bot} size={18} />
    }))
  ]
  const edges: [string, string][] = members.map((bot) => ['you', bot.id])
  const calls: GraphCall[] = []

  for (const entry of entries) {
    if (entry.kind === 'message' && entry.text.trim()) {
      if (entry.author.kind === 'user' && lead) {
        calls.push({ id: entry.id, from: 'you', to: lead.id, label: firstLine(entry.text), status: 'ok', at: entry.createdAt })
      } else if (entry.author.kind === 'bot') {
        calls.push({ id: entry.id, from: entry.author.botId, to: 'you', label: firstLine(entry.text), status: 'ok', at: entry.createdAt })
      }
    }
    const call = entry.toolCall
    if (call?.toolName !== 'send_to_agent' || entry.author.kind !== 'bot') continue
    const peer = findBotByRef((call.input as { to?: unknown } | undefined)?.to, [...bots.values()])
    if (!peer || !conv.botIds.includes(peer.id)) continue
    calls.push({
      id: call.callId || entry.id,
      from: entry.author.botId,
      to: peer.id,
      label: visibleToolLabel(call.toolName, call.title),
      status: call.status === 'error' ? 'error' : call.status === 'running' ? 'pending' : 'ok',
      at: entry.createdAt
    })
    edges.push([entry.author.botId, peer.id])
  }

  return { nodes, calls, edges, botCount: members.length }
}

export function WhoSaidWhatView({
  title,
  lines,
  graph,
  map = false,
  onMap,
  onBack
}: {
  title: string
  lines: OverviewLine[]
  graph: OverviewGraph
  map?: boolean
  onMap: (map: boolean) => void
  onBack: () => void
}) {
  const count = graph.botCount === 1 ? '1 bot' : `${graph.botCount} bots`
  const clock = graph.calls.reduce((latest, call) => Math.max(latest, call.at), 0)
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-pane" aria-label="Who said what">
      <div className="flex items-center gap-3 border-b border-line-soft px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-fg">Who said what</h2>
          <p className="text-[12px] text-fg-3">{map ? count : 'This conversation, in order.'}</p>
        </div>
        <button type="button" className="rounded-md px-2 py-1 text-[13px] text-fg-3 hover:bg-hover hover:text-fg" onClick={() => onMap(!map)}>
          {map ? 'Show as list' : 'Show as map'}
        </button>
        <button type="button" className="rounded-md px-2 py-1 text-[13px] font-medium text-fg-2 hover:bg-hover hover:text-fg" onClick={onBack}>
          Back to chat
        </button>
      </div>
      {map ? (
        <div className="overview-map flex min-h-0 flex-1 flex-col px-4 py-3">
          <AgentGraph
            title={title}
            nodes={graph.nodes}
            calls={graph.calls}
            edges={graph.edges}
            now={clock || undefined}
            height={440}
            formatCost={() => ''}
            className="min-h-0 flex-1"
          />
        </div>
      ) : (
        <ol className="scroll-y min-h-0 flex-1 space-y-3 px-5 py-4">
          {lines.map((line) => (
            <li key={line.id} className="text-[13px] leading-5 text-fg">
              <span className="font-semibold">{line.who}</span>
              <span className="text-fg-4"> · </span>
              <span className="whitespace-pre-wrap text-fg-2">{line.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function WhoSaidWhat({ conv, onBack }: { conv: Conversation; onBack: () => void }) {
  const bots = useData((state) => state.botMap)
  const entries = useData((state) => state.entries[conv.id]) ?? []
  const live = useData((state) => state.live)
  const [map, setMap] = useState(false)
  const phases = useMemo(() => {
    const next = new Map<string, BotPhase | undefined>()
    for (const id of conv.botIds) next.set(id, live[`${conv.id}:${id}`]?.phase)
    return next
  }, [conv.botIds, conv.id, live])
  const lines = useMemo(() => overviewLines(entries, bots), [entries, bots])
  const graph = useMemo(() => overviewGraph(conv, bots, entries, phases), [conv, bots, entries, phases])
  return <WhoSaidWhatView title={conv.title || 'Group'} lines={lines} graph={graph} map={map} onMap={setMap} onBack={onBack} />
}
