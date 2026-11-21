import type { Id } from './domain'

export interface ProjectAddress {
  projectId: Id
  hostId: Id
  environmentId: Id
}

export interface SessionSource {
  itemId: Id
  sourceId: Id
  revision: number
  sha256: string
  name: string
}

export interface ProjectSession extends ProjectAddress {
  id: Id
  label: string
  ownerId: Id
  mode: 'fresh' | 'fork'
  parentId?: Id
  engine: string
  sources: SessionSource[]
  createdAt: number
}

export interface EvidenceCitation {
  source: SessionSource
  line: number
  excerpt: string
}

export interface ProjectAnswer {
  id: Id
  sessionId: Id
  projectId: Id
  ownerId: Id
  query: string
  createdAt: number
  status: 'found' | 'conflict' | 'unavailable'
  retrieval: 'native'
  graph: 'disconnected'
  modelRequested: boolean
  verifiedSourceIds: string[]
  citations: EvidenceCitation[]
  conflicts: string[]
  omissions: string[]
  sources: SessionSource[]
  modelReply?: string
}

export interface ProjectSessionView {
  session: ProjectSession
  history: ProjectAnswer[]
  omittedHistory: number
}

export interface SessionInvoke {
  'session:instruction': { req: { conversationId: Id; entryId: Id }; res: string | null }
  'session:ask-fai': {
    req: ProjectAddress & { sessionId: Id; answerId: Id; requestId: Id; instruction: string }
    res: { conversationId: Id; entryId: Id }
  }
  'session:project': { req: { projectId: Id }; res: { address: ProjectAddress; sessions: ProjectSession[] } }
  'session:open': {
    req: ProjectAddress &
      (
        | { mode: 'fresh'; label?: string }
        | { mode: 'continue'; sessionId: Id }
        | { mode: 'fork'; parentId: Id; parentProjectId: Id; answerIds: Id[]; label?: string }
      )
    res: ProjectSessionView
  }
  'session:lookup': {
    req: ProjectAddress & { sessionId: Id; query: string; requestId: Id; useModel?: boolean }
    res: ProjectAnswer
  }
  'session:history': {
    req: ProjectAddress & { sessionId: Id }
    res: Pick<ProjectSessionView, 'history' | 'omittedHistory'>
  }
}

export const SESSION_CHANNELS = ['session:project', 'session:open', 'session:lookup', 'session:history', 'session:ask-fai', 'session:instruction'] as const
