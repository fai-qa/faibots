import type { Id } from './domain'

export interface ExchangeSummary {
  anchorId: Id
  callerId: Id
  botIds: Id[]
  messageCount: number
  active: boolean
  attention?: 'failed' | 'reconciliation_required'
  incompleteHistory?: boolean
}

export interface ExchangeMessage {
  id: Id
  conversationId: Id
  authorId: Id
  recipientId: Id
  /** The caller's recorded reason for selecting this recipient. Only assignment questions carry it. */
  selectionReason?: string
  text: string
  createdAt: number
  isStreaming: boolean
}

export interface ExchangeMessagesPage {
  /** The newest available page, in conversation order. */
  messages: ExchangeMessage[]
  /** Pass this opaque entry ID back to fetch the preceding page. */
  before?: Id
}

interface ExchangeSelection {
  conversationId: Id
  entryIds: Id[]
}

export interface ExchangeActivityInvoke {
  'conv:exchange-summaries': { req: ExchangeSelection; res: ExchangeSummary[] }
  'conv:exchange-messages': {
    req: ExchangeSelection & { before?: Id; limit?: number }
    res: ExchangeMessagesPage
  }
}

export const EXCHANGE_ACTIVITY_CHANNELS = ['conv:exchange-summaries', 'conv:exchange-messages'] as const
