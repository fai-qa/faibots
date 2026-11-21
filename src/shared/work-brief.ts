export type WorkState = 'active' | 'waiting' | 'needs_input' | 'review' | 'accepted' | 'cancelled'
export type WorkDecision = 'answer' | 'accept' | 'request_changes' | 'cancel'

export interface WorkBrief {
  id: string
  conversationId: string
  userEntryId: string
  objective: string
  deliverable: string
  checks: string
  state: WorkState
  revision: number
  question: string
  partial: boolean
  result: string
  evidenceIds: string[]
  updatedAt: number
}

export interface WorkReply {
  id: string
  revision: number
  decision: WorkDecision
  note: string
}
