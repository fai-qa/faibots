import type { Id, PermissionMode } from './domain'
import type { ProjectAddress } from './project-sessions'

export type ContextScope =
  | { kind: 'chat'; conversationId: Id }
  | ({ kind: 'project'; sessionId: Id } & ProjectAddress)

export interface OfferedTool {
  name: string
  exposedAs: string
  permission: PermissionMode
  workspaceException?: boolean
  hostApproval?: 'app' | 'cli-default'
}

export type ContextSource =
  | { kind: 'project'; itemId: Id; sourceId: Id; revision: number; sha256: string }
  | { kind: 'attachment'; entryId: Id; attachmentId: Id; sha256: string }
  | { kind: 'withheld'; reason?: 'verification-limit' }

export interface TurnContextReceipt {
  id: Id
  createdAt: number
  botId: Id
  scopeId: Id
  projectId?: Id
  route: 'dm' | 'group' | 'exchange' | 'project'
  engine: 'native' | 'codex' | 'claude-code' | 'local-search'
  providerId?: Id
  modelId?: string
  tools: OfferedTool[]
  sources: ContextSource[]
  omissions: string[]
}

export interface TurnContextInvoke {
  'context:turns': {
    req: { scope: ContextScope; turnId?: Id; before?: number }
    res: { turns: TurnContextReceipt[]; next?: number }
  }
}
