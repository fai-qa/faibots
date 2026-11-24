// Types for the affectUI Agent Graph file. The implementation does not typecheck under
// noUncheckedIndexedAccess, so the project checks this declaration and Vite loads the source.

import type { ReactNode } from 'react'

export type GraphNodeKind = 'agent' | 'tool' | 'user'
export type GraphNodeStatus = 'idle' | 'working' | 'waiting' | 'error' | 'done'

export type GraphNode = {
  id: string
  name: string
  kind: GraphNodeKind
  short?: string
  icon?: ReactNode
  detail?: string
  status?: GraphNodeStatus
  doing?: string
  cost?: number
  lead?: boolean
}

export type GraphCall = {
  id: string
  from: string
  to: string
  label?: string
  status?: 'pending' | 'ok' | 'error'
  at: number
  ms?: number
}

export type AgentGraphProps = {
  nodes: GraphNode[]
  calls?: GraphCall[]
  edges?: [string, string][]
  now?: number
  heatWindow?: number
  onSelect?: (node: GraphNode | null) => void
  height?: number
  formatCost?: (amount: number) => string
  title?: string
  className?: string
}

export function AgentGraph(props: AgentGraphProps): ReactNode
