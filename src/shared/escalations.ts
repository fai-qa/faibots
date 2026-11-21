import type { ProjectAddress } from './project-sessions'

export interface HandoffScope extends ProjectAddress {
  sessionId: string
}
export interface HandoffRange {
  entryId: string
  start: number
  end: number
}
export interface HandoffRequest {
  id: string
  sourceChatId: string
  question: string
  selections: (HandoffRange & { expectedText: string })[]
  scope?: HandoffScope
  work?: { id: string; revision: number }
}
export interface HandoffReceipt {
  id: string
  sourceChatId: string
  specialistId: string
  chiefId: string
  chiefChatId: string
  createdAt: number
  destinationEntryId?: string
  projectId?: string
  workId?: string
}
export interface Checkpoint extends HandoffReceipt {
  availability: 'available' | 'withheld'
  reason?: string
  scope?: HandoffScope
  workRevision?: number
  question?: string
  excerpts?: (HandoffRange & { authorId: string; text: string; sha256: string })[]
  sources?: { sourceId: string; revision: number; sha256: string }[]
}
export interface EscalationInvoke {
  'handoff:options': {
    req: { sourceChatId: string }
    res: { receipts: HandoffReceipt[]; work: { id: string; objective: string; revision: number }[] }
  }
  'handoff:send': { req: HandoffRequest; res: HandoffReceipt }
  'handoff:resume': { req: { sourceChatId: string; id: string }; res: HandoffReceipt }
  'handoff:read': { req: { chiefChatId: string; id: string }; res: Checkpoint[] }
}
export const ESCALATION_CHANNELS = ['handoff:options', 'handoff:send', 'handoff:resume', 'handoff:read'] as const
