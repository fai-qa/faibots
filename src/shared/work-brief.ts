export type WorkState = 'active' | 'waiting' | 'needs_input' | 'review' | 'accepted' | 'cancelled'
export type WorkDecision = 'steer' | 'answer' | 'accept' | 'request_changes' | 'cancel'

export const MAX_ASKS_PER_CHAIN = 12

export interface WorkConstraints {
  exclusions: string
  stopWhen: string
  assignmentLimit: number
}

export interface WorkBrief extends WorkConstraints {
  id: string
  conversationId: string
  userEntryId: string
  objective: string
  deliverable: string
  checks: string
  state: WorkState
  revision: number
  lastInstruction: string
  question: string
  choices: string[]
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

/** Only the original request and explicitly linked inputs. Re-resolve when the owner opens the card. */
export interface WorkScope {
  inputs: string[]
  withheld: boolean
}
