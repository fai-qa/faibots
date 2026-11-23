import { randomUUID } from 'node:crypto'
import type { Entry } from '@shared/domain'
import type { EvidenceCitation, ProjectAddress, ProjectAnswer, SessionInvoke } from '@shared/project-sessions'
import { readSourceSnapshot } from '../attachments/project-reads'
import type { AttachmentStore, Services } from '../contracts'
import { str, transaction } from './db'
import { chiefForHandoff } from './escalations'
import type { PlatformStore } from './index'
import { createProjectSessions } from './project-sessions'
import { readPageEvidence, type PageCheck, type PageEvidence } from './page-evidence'

type Request = SessionInvoke['session:ask-fai']['req']
type PageRequest = SessionInvoke['session:ask-page']['req']
type Authority = Pick<Services, 'dataDir' | 'attachments'>
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const pointer = 'Use the project result I selected and reply here.'

function resultOwner(store: PlatformStore, chat: string) {
  const chief = chiefForHandoff(store)
  if (
    chief.hidden ||
    store.conversations.findDm(chief.id)?.id !== chat ||
    (chief.toolPermissions.read_project_result ??
      store.settings.get().toolPermissions.read_project_result) === 'never'
  )
    throw new Error('The selected result is unavailable to fai in this chat.')
  return chief.id
}

function checked(
  store: PlatformStore,
  authority: Authority,
  req: Pick<Request, 'sessionId' | 'answerId' | 'projectId' | 'hostId' | 'environmentId'>,
  chat: string
) {
  resultOwner(store, chat)
  const verified = new Set<string>()
  let remaining = 16 * 1024 * 1024
  const result = createProjectSessions(store, authority.dataDir).selectedAnswer(
    req,
    req.sessionId,
    req.answerId,
    (projectId, pin) => {
      const source = store.projectContent.check(projectId, pin)
      const key = JSON.stringify([source.attachmentId, source.name, source.sha256])
      if (verified.has(key)) return
      if (source.sizeBytes > remaining)
        throw new Error('The selected result exceeds the source verification limit.')
      try {
        readSourceSnapshot(authority.dataDir, authority.attachments, source)
      } catch {
        throw new Error('The selected source snapshot could not be verified.')
      }
      remaining -= source.sizeBytes
      verified.add(key)
    }
  )
  if (JSON.stringify([result.citations, result.relationships, result.conflicts, result.omissions]).length > 80_000)
    throw new Error('This result exceeds the context limit. Narrow the search before asking fai.')
  return result
}

function checkedPage(store: PlatformStore, authority: Authority, ref: Pick<PageRequest,'projectId'|'pageId'|'revisionId'|'sha256'>, check?: PageCheck) {
  const page = readPageEvidence(store,authority,ref.projectId,ref.pageId,check)
  if (page.revisionId !== ref.revisionId || page.sha256 !== ref.sha256) throw new Error('The selected Page revision has changed.')
  if (JSON.stringify(page).length > 80_000) throw new Error('The selected Page exceeds the chat context limit.')
  return page
}

/** The source reference and owner-visible generic pointer are committed together. */
export function queueProjectResult(
  store: PlatformStore,
  authority: Authority,
  chat: string,
  req: Request | PageRequest
): Entry {
  const instruction = typeof req.instruction === 'string' && req.instruction.trim()
  if (
    !instruction ||
    instruction.length > 2000 ||
    typeof req.requestId !== 'string' ||
    !uuid.test(req.requestId)
  )
    throw new Error('Enter an instruction up to 2,000 characters and a valid request ID.')
  return transaction(store.db, () => {
    const ownerId = resultOwner(store,chat)
    const page = 'pageId' in req ? checkedPage(store,authority,req) : undefined
    const address = page && createProjectSessions(store,authority.dataDir).address(req.projectId)
    const answer = 'pageId' in req ? undefined : checked(store,authority,req,chat)
    const sessionId = 'pageId' in req ? null : req.sessionId
    if (answer && answer.ownerId !== ownerId) throw new Error('The result owner changed.')
    const old = store.db.prepare('select * from project_result_requests where id=?').get(req.requestId)
    if (old) {
      if (
        old.session_id !== sessionId ||
        old.answer_id !== (answer?.id ?? null) ||
        old.page_id !== (page?.id ?? null) || old.page_revision_id !== (page?.revisionId ?? null) ||
        old.page_sha256 !== (page?.sha256 ?? null) || old.project_id !== (page?.projectId ?? null) ||
        old.host_id !== (address?.hostId ?? null) || old.environment_id !== (address?.environmentId ?? null) ||
        old.instruction !== instruction ||
        old.conversation_id !== chat
      )
        throw new Error('This request ID already belongs to another selection or instruction.')
      return store.entries.get(str(old.entry_id))!
    }
    const nonce = 'project-result-' + req.requestId
    if (store.entries.findByNonce(chat, nonce)) throw new Error('This request ID is already in use.')
    const entryId = randomUUID()
    const entry = store.entries.append({
      id: entryId,
      meta: { selectedResultEntryId: entryId },
      conversationId: chat,
      kind: 'message',
      author: { kind: 'user' },
      text: pointer,
      attachments: [],
      mentions: [],
      mentionsEveryone: false,
      isStreaming: false,
      clientNonce: nonce
    })
    store.db
      .prepare(
        `insert into project_result_requests(id,session_id,answer_id,owner_id,conversation_id,entry_id,instruction,state,
          page_id,page_revision_id,page_sha256,project_id,host_id,environment_id)
      values(?,?,?,?,?,?,?,'queued',?,?,?,?,?,?)`
      )
      .run(req.requestId, sessionId, answer?.id ?? null, ownerId, chat, entry.id, instruction,
        page?.id ?? null,page?.revisionId ?? null,page?.sha256 ?? null,page?.projectId ?? null,address?.hostId ?? null,address?.environmentId ?? null)
    return entry
  })
}

/** Clicking Reply on the owner's selected message or fai's finished answer is a new explicit selection. */
export function projectReplyOrigin(store: PlatformStore, chat: string, replyId: string): string | undefined {
  const target = store.entries.get(replyId)
  if (!target || target.conversationId !== chat || target.kind !== 'message' || target.isStreaming) return
  let origin: string | undefined
  if (target.author.kind === 'user') origin = target.id
  else if (target.author.kind === 'bot' && target.meta?.selectedResultEntryId) {
    const chief = chiefForHandoff(store)
    if (target.author.botId === chief.id) origin = target.meta.selectedResultEntryId
  }
  if (!origin) return
  const row = store.db
    .prepare('select entry_id from project_result_requests where conversation_id=? and entry_id=?')
    .get(chat, origin)
  return row && str(row.entry_id)
}

/** Atomically give a follow-up its own authority, instruction, turn fence and recovery state. */
export function queueProjectReply(
  store: PlatformStore,
  authority: Authority,
  chat: string,
  origin: string,
  append: () => Entry
): Entry {
  return transaction(store.db, () => {
    const row = store.db
      .prepare('select * from project_result_requests where entry_id=? and conversation_id=?')
      .get(origin, chat)
    if (!row || !readProjectResult(store, authority, chat, origin))
      throw new Error('The selected project result is unavailable.')
    const entry = append()
    store.db
      .prepare(
        `insert into project_result_requests(id,session_id,answer_id,owner_id,conversation_id,entry_id,instruction,state,
          page_id,page_revision_id,page_sha256,project_id,host_id,environment_id)
        select ?,session_id,answer_id,owner_id,conversation_id,?,?,'queued',page_id,page_revision_id,page_sha256,project_id,host_id,environment_id
        from project_result_requests where entry_id=? and conversation_id=?`
      )
      .run(
        randomUUID(),
        entry.id,
        entry.text.trim() || 'Use my attached message with the selected project result.',origin,chat
      )
    return entry
  })
}

/** An unrelated DM message cannot gain authority by naming a work ID or calling review_work. */
export function projectResultOrigin(
  store: PlatformStore,
  chat: string,
  entry: Entry,
  wake?: { id: string; revision: number }
): string | undefined {
  if (entry.conversationId !== chat) return
  if (entry.author.kind === 'user' && (entry.replyToId || entry.clientNonce?.startsWith('project-result-'))) {
    const row = store.db
      .prepare('select entry_id from project_result_requests where conversation_id=? and entry_id=?')
      .get(chat, entry.id)
    if (row) return str(row.entry_id)
  }
  if (entry.author.kind === 'user' && entry.clientNonce?.startsWith('work-')) {
    const row = store.db
      .prepare(
        `select r.entry_id from chief_decisions d join chief_work w on w.id=d.work_id
      join project_result_requests r on r.entry_id=w.user_entry_id and r.conversation_id=w.conversation_id
      where w.conversation_id=? and w.state='active' and w.revision=d.revision+1 and d.decision in ('answer','steer','request_changes')
      and 'work-'||w.id||'-'||d.revision=?`
      )
      .get(chat, entry.clientNonce)
    return row && str(row.entry_id)
  }
  if (wake && entry.author.kind === 'system') {
    const row = store.db
      .prepare(
        `select r.entry_id from chief_wakes k join chief_work w on w.id=k.work_id
      join project_result_requests r on r.entry_id=w.user_entry_id and r.conversation_id=w.conversation_id
      where w.conversation_id=? and w.state='active' and w.revision=k.revision+2 and k.work_id=? and k.revision=?
      and k.entry_id=? and k.state in ('ready','started')`
      )
      .get(chat, wake.id, wake.revision, entry.id)
    return row && str(row.entry_id)
  }
}

interface SelectedResult extends ProjectAddress {
  requestId: string; conversationId: string; entryId: string; instruction: string
  sessionId?: string; answerId?: string; page?: PageEvidence
  relationships?: ProjectAnswer['relationships']
  query: string; status: ProjectAnswer['status']; citations: EvidenceCitation[]; conflicts: string[]; omissions: string[]
}
export function readProjectResult(store: PlatformStore, authority: Authority, chat: string, entryId: string, pageCheck?: PageCheck): SelectedResult | undefined {
  const row = store.db
    .prepare(
      `select r.*,s.project_id session_project,s.host_id session_host,s.environment_id session_environment from project_result_requests r
    left join project_sessions s on s.id=r.session_id where r.conversation_id=? and r.entry_id=?`
    )
    .get(chat, entryId)
  if (!row) return
  const common = { requestId:str(row.id), conversationId:chat, entryId, instruction:str(row.instruction) }
  if (row.page_id) {
    if (resultOwner(store,chat) !== row.owner_id) throw new Error('The result owner changed.')
    const address = createProjectSessions(store,authority.dataDir).address(str(row.project_id))
    if (address.hostId !== row.host_id || address.environmentId !== row.environment_id) throw new Error('The selected Page belongs to another environment.')
    const page = checkedPage(store,authority,{projectId:address.projectId,pageId:str(row.page_id),revisionId:str(row.page_revision_id),sha256:str(row.page_sha256)},pageCheck)
    return { ...common,...address,page,query:page.name,status:'found',citations:[],conflicts:[],omissions:[] }
  }
  const scope = {
    projectId: str(row.session_project),
    hostId: str(row.session_host),
    environmentId: str(row.session_environment),
    sessionId: str(row.session_id),
    answerId: str(row.answer_id)
  }
  const answer = checked(store, authority, scope, chat)
  if (answer.ownerId !== row.owner_id) throw new Error('The result owner changed.')
  // A prior optional summary may contain other results; this read carries only this result's own citations.
  return {
    ...scope,
    ...common,
    query: answer.query,
    status: answer.status,
    citations: answer.citations,
    ...(answer.relationships?.length && {relationships:answer.relationships}),
    conflicts: answer.conflicts,
    omissions: answer.omissions
  }
}

/** User-facing brief provenance. The opaque withheld form reveals no titles, queries or source IDs. */
export function projectResultForEntry(
  store: PlatformStore,
  dataDir: string,
  attachments: AttachmentStore,
  conversationId: string,
  userEntryId: string
) {
  try {
    const result = readProjectResult(store, { dataDir, attachments }, conversationId, userEntryId)
    if (!result) return
    return {
      status: 'available' as const,
      projectId: result.projectId,
      sessionId: result.sessionId,
      answerId: result.answerId,
      ...(result.page && { page: { name:result.page.name, revision:result.page.revision, sources:result.page.sources } }),
      conversationId,
      entryId: userEntryId,
      evidence: result.citations.map(({ source, line }) => ({ ...source, line }))
    }
  } catch {
    return { status: 'withheld' as const }
  }
}
