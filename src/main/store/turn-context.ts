import { createHash } from 'node:crypto'
import { MAX_NOTE_BYTES } from '../attachments/snapshots'
import type { Entry } from '@shared/domain'
import type { ContextSource, TurnContextInvoke, TurnContextReceipt } from '@shared/turn-context'
import type { Services } from '../contracts'
import type { PlatformStore } from './index'
import { createProjectSessions } from './project-sessions'
import { readSourceSnapshot } from '../attachments/project-reads'

type Authority = Pick<Services, 'dataDir' | 'attachments'>
type Metadata = TurnContextReceipt
type Lookup = TurnContextInvoke['context:turns']['req']
const withheld = (): ContextSource => ({ kind: 'withheld' })
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Bound synchronous work for one user-opened page, including multiple turns sharing a file. */
function verificationBudget() {
  let remaining = 16 * 1024 * 1024
  return (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_NOTE_BYTES || size > remaining) return false
    remaining -= size
    return true
  }
}
const overBudget = (): ContextSource => ({ kind: 'withheld', reason: 'verification-limit' })

/** Model IDs may be user-supplied. Keep common namespace/model IDs; never persist URLs, paths or vault values. */
export function safeModelId(value: string, redact: (text: string) => string) {
  if (
    value.length > 256 ||
    /^(?:sk[-_]|gh[pousr]_|github_pat_|AIza)/i.test(value) ||
    value !== redact(value) ||
    !/^[a-z0-9][\w.+-]*(?:\/[a-z0-9][\w.+-]*)?(?::[a-z0-9][\w.+-]*)?$/i.test(value)
  )
    return 'withheld'
  return value
}

export function attachmentContext(entries: Entry[], authority: Authority): ContextSource[] {
  const sources: ContextSource[] = []
  const reserve = verificationBudget()
  for (const entry of entries) {
    if (entry.kind !== 'message' || entry.author.kind !== 'user') continue
    for (const attachment of entry.attachments) {
      try {
        if (!attachment.sha256 && !reserve(attachment.sizeBytes)) {
          sources.push(overBudget())
          continue
        }
        const sha256 = attachment.sha256 ?? digest(authority.attachments.read(attachment, attachment.sizeBytes))
        sources.push({ kind: 'attachment', entryId: entry.id, attachmentId: attachment.id, sha256 })
      } catch {
        sources.push(withheld())
      }
    }
  }
  return sources
}

export function projectSelections(store: PlatformStore, projectId: string, runId: string): ContextSource[] {
  return store.projectContent.pins(projectId, runId).map((p) => ({ kind: 'project', ...p }))
}

export function saveTurnContext(store: PlatformStore, row: Metadata, isSession = false) {
  // A size/invalid-session retry updates the same turn with the actual retried dispatch.
  store.db
    .prepare(
      `insert into turn_context_receipts(turn_id,conversation_id,session_id,project_id,payload)
    values(?,?,?,?,?) on conflict(turn_id) do update set payload=excluded.payload
    where conversation_id is excluded.conversation_id and session_id is excluded.session_id and project_id is excluded.project_id`
    )
    .run(
      row.id,
      isSession ? null : row.scopeId,
      isSession ? row.scopeId : null,
      row.projectId ?? null,
      JSON.stringify(row)
    )
}

export function turnContextHandlers(services: Authority, store: PlatformStore) {
  function reveal(
    row: Metadata,
    source: ContextSource,
    reserve: (size: number) => boolean,
    verified: Set<string>
  ): ContextSource {
    const key = JSON.stringify([row.scopeId, row.projectId, source])
    if (source.kind === 'withheld') return source
    try {
      if (source.kind === 'project' && row.projectId) {
        const selected = store.db
          .prepare(
            `select 1 from library_access a where a.project_id=? and a.item_id=? and a.selected=1
          and ?=(select max(revision) from library_revisions where item_id=a.item_id)`
          )
          .get(row.projectId, source.itemId, source.revision)
        if (!selected) return withheld()
        const current = store.projectContent.check(row.projectId, source)
        if (!verified.has(key)) {
          if (!reserve(current.sizeBytes)) return overBudget()
          readSourceSnapshot(services.dataDir, services.attachments, current)
          verified.add(key)
        }
        return source
      }
      if (source.kind === 'attachment') {
        const entry = store.entries.get(source.entryId)
        const attachment =
          entry?.conversationId === row.scopeId && entry.author.kind === 'user'
            ? entry.attachments.find((a) => a.id === source.attachmentId)
            : undefined
        if (!attachment) return withheld()
        if (!verified.has(key)) {
          if (!reserve(attachment.sizeBytes)) return overBudget()
          if (digest(services.attachments.read(attachment, attachment.sizeBytes)) !== source.sha256)
            return withheld()
          verified.add(key)
        }
        return source
      }
    } catch {
      /* Source details remain private when a revision or its bytes cannot be verified. */
    }
    return withheld()
  }

  return {
    'context:turns': ({ scope, turnId, before }: Lookup) => {
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
        throw new Error('Invalid context page.')
      const session = scope.kind === 'project'
      if (session) createProjectSessions(store, services.dataDir).sessionAt(scope, scope.sessionId)
      else if (scope.kind !== 'chat' || !store.conversations.get(scope.conversationId))
        throw new Error('Chat unavailable.')
      const scopeId = session ? scope.sessionId : scope.conversationId
      const rows = store.db
        .prepare(
          `select rowid,payload from turn_context_receipts
      where ${session ? 'session_id=? and project_id=?' : 'conversation_id=?'}
      and (? is null or turn_id=?) and rowid < ? order by rowid desc limit 11`
        )
        .all(
          ...(session ? [scopeId, scope.projectId] : [scopeId]),
          turnId ?? null,
          turnId ?? null,
          before ?? Number.MAX_SAFE_INTEGER
        )
      const reserve = verificationBudget()
      const verified = new Set<string>()
      const turns = rows.slice(0, 10).map((item) => {
        const row = JSON.parse(String(item.payload)) as Metadata
        return { ...row, sources: row.sources.map((source) => reveal(row, source, reserve, verified)) }
      })
      return { turns, ...(rows.length > 10 && { next: Number(rows[9]!.rowid) }) }
    }
  }
}
