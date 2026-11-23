import type { Id, ProjectSource } from './domain'

export interface LibrarySource {
  itemId: Id
  ownerProjectId: Id
  revision: number
  selected: boolean
  readable: boolean
  sharedWith: Id[]
  source: ProjectSource
  versions: { sourceId: Id; name: string; sha256: string; revision: number }[]
}

export interface SpacePage {
  id: Id
  spaceId: Id
  name: string
  runId: Id
  revisionId: Id
  sha256: string
  reviewer: string
  createdAt: number
}

export interface AcceptedWorkPage extends Omit<SpacePage, 'runId'> {
  projectId: Id
  workId: Id
  workRevision: number
  partial: boolean
}

export interface WorkPageRequest {
  conversationId: Id
  workId: Id
  revision: number
}

export interface ProjectEvaluation {
  runId: Id
  status: string
  rubric: string
  reason: string
  reviewer?: string
  revisionId?: Id
  turns: number
  report?: {
    candidateId: Id
    status: 'passed' | 'failed'
    integrity: 'verified' | 'unavailable' | 'unknown'
    contract: 'accepted' | 'unmet'
    reason: string
    at: number
  }
}

export interface ProjectContent {
  space: { id: Id; name: string }
  library: LibrarySource[]
  pages: (SpacePage | AcceptedWorkPage)[]
  evaluations: ProjectEvaluation[]
}

export interface ContentInvoke {
  'content:work-destinations': {
    req: WorkPageRequest
    res: { projects: { id: Id; name: string }[]; saved?: AcceptedWorkPage }
  }
  'content:save-work': { req: WorkPageRequest & { projectId: Id }; res: AcceptedWorkPage }
  'content:project': { req: { projectId: Id }; res: ProjectContent }
  'content:select': { req: { projectId: Id; itemId: Id; selected: boolean }; res: void }
  'content:revoke': { req: { projectId: Id; itemId: Id; targetProjectId?: Id }; res: void }
  'content:restore': { req: { projectId: Id; itemId: Id }; res: void }
  'content:share': { req: { projectId: Id; itemId: Id; targetProjectId: Id }; res: void }
  'content:revise': { req: { projectId: Id; itemId: Id; path: string }; res: void }
  'content:read-source': { req: { projectId: Id; sourceId: Id }; res: { text: string; sha256: string } }
  'content:read-page': {
    req: { projectId: Id; pageId: Id }
    res: { body: string; sources: { name: string; sha256: string }[]
      attribution?: { workId: Id; workRevision: number; ownerAccepted: true; partial: boolean } }
  }
  'content:rerun': { req: { projectId: Id; runId: Id }; res: { runId: Id } }
  'content:evaluate': { req: { projectId: Id; runId: Id }; res: ProjectEvaluation }
}

export const CONTENT_CHANNELS = [
  'content:work-destinations',
  'content:save-work',
  'content:project',
  'content:select',
  'content:revoke',
  'content:restore',
  'content:share',
  'content:revise',
  'content:read-source',
  'content:read-page',
  'content:rerun',
  'content:evaluate'
] as const
