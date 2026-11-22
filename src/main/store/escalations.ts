import { createHash } from 'node:crypto'
import type { Checkpoint, HandoffRange, HandoffReceipt, HandoffRequest, HandoffScope } from '@shared/escalations'
import type { SessionSource } from '@shared/project-sessions'
import type { Services } from '../contracts'
import { readSourceSnapshot } from '../attachments/project-reads'
import { createProjectSessions } from './project-sessions'
import type { PlatformStore } from './index'
import { num, str, transaction, type Row } from './db'

type Authority = Pick<Services, 'dataDir' | 'attachments'>
type Pin = HandoffRange & { authorId: string; sha256: string }
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

export function chiefForHandoff(store: PlatformStore) {
  const chief = store.bots.list().find((candidate) => candidate.isPrimary && candidate.name === 'fai')
  if (!chief) throw new Error('The permanent main bot fai is unavailable.')
  return chief
}
function specialist(store: PlatformStore, chatId: string) {
  const chat = store.conversations.get(chatId)
  const member = chat?.kind === 'dm' && chat.botIds.length === 1 && store.bots.get(chat.botIds[0]!)
  if (!member || member.isPrimary || member.id === chiefForHandoff(store).id)
    throw new Error('Choose a direct chat with a specialist.')
  return member
}
function hasWork(store: PlatformStore) {
  return !!store.db.prepare("select 1 from sqlite_master where type='table' and name='chief_work'").get()
}
function workAt(store: PlatformStore, chiefChat: string, id: string) {
  const w =
    hasWork(store) &&
    store.db
      .prepare('select id,state,revision from chief_work where conversation_id=? and id=?')
      .get(chiefChat, id)
  if (!w || ['cancelled', 'accepted'].includes(str(w.state)))
    throw new Error('The original work is unavailable or closed.')
  return { id: str(w.id), revision: num(w.revision) }
}
function excerpt(store: PlatformStore, sourceChat: string, specialistId: string, range: HandoffRange) {
  const e = store.entries.get(range.entryId)
  if (
    !e ||
    e.conversationId !== sourceChat ||
    e.kind !== 'message' ||
    e.isStreaming ||
    e.trigger ||
    !(e.author.kind === 'user' || (e.author.kind === 'bot' && e.author.botId === specialistId))
  )
    throw new Error('Choose a completed message from this specialist chat.')
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end > e.text.length ||
    range.start >= range.end ||
    range.end - range.start > 4000
  )
    throw new Error('Choose an excerpt of 1 to 4,000 characters.')
  const text = e.text.slice(range.start, range.end)
  if (!text.trim()) throw new Error('The selected excerpt is empty.')
  return {
    entryId: e.id,
    start: range.start,
    end: range.end,
    authorId: e.author.kind === 'user' ? 'user' : specialistId,
    text,
    sha256: sha(text)
  }
}
function receipt(r: Row): HandoffReceipt {
  const scope = r.scope && (JSON.parse(str(r.scope)) as HandoffScope)
  return {
    id: str(r.id),
    sourceChatId: str(r.source_chat),
    specialistId: str(r.specialist_id),
    chiefId: str(r.chief_id),
    chiefChatId: str(r.chief_chat),
    createdAt: num(r.created_at),
    ...(r.destination_entry && { destinationEntryId: str(r.destination_entry) }),
    ...(r.work_id && { workId: str(r.work_id) }),
    ...(scope && { projectId: scope.projectId })
  }
}
function pinsAt(store: PlatformStore, scope: HandoffScope, authority?: Authority) {
  if (!authority) throw new Error('Project source verification is unavailable.')
  const session = createProjectSessions(store, authority.dataDir).ready(scope, scope.sessionId)
  for (const pin of session.sources)
    readSourceSnapshot(authority.dataDir, authority.attachments, store.projectContent.check(scope.projectId, pin))
  return session.sources
}
function fingerprint(scope: HandoffScope | null) {
  return scope ? JSON.stringify([scope.projectId, scope.hostId, scope.environmentId, scope.sessionId]) : ''
}
export function prepareHandoff(
  store: PlatformStore,
  req: HandoffRequest,
  destination: string,
  authority: Authority
) {
  if (
    !uuid.test(req.id) ||
    typeof req.question !== 'string' ||
    !req.question.trim() ||
    req.question.length > 2000 ||
    !Array.isArray(req.selections) ||
    req.selections.length < 1 ||
    req.selections.length > 8
  )
    throw new Error('Select 1 to 8 excerpts and write a question up to 2,000 characters.')
  const signature = sha(
    JSON.stringify([
      req.sourceChatId,
      req.question,
      req.selections.map((r) => [r.entryId, r.start, r.end, r.expectedText]),
      fingerprint(req.scope ?? null),
      req.work?.id ?? '',
      req.work?.revision ?? 0
    ])
  )
  return transaction(store.db, () => {
    const chief = chiefForHandoff(store),
      owner = specialist(store, req.sourceChatId)
    const dm = store.conversations.findDm(chief.id)
    if (dm?.id !== destination) throw new Error('This is not the main bot’s direct chat.')
    const prior = store.db.prepare('select * from specialist_escalations where id=?').get(req.id)
    if (prior) {
      if (prior.signature !== signature || prior.chief_chat !== destination)
        throw new Error('The handoff ID belongs to another request.')
      return receipt(prior)
    }
    const sources = req.scope ? pinsAt(store, req.scope, authority) : []
    const excerpts = req.selections.map((range) => {
      const { text, ...ref } = excerpt(store, req.sourceChatId, owner.id, range)
      if (text !== range.expectedText)
        throw new Error('The original words changed. Review the excerpt before sending.')
      return ref
    })
    if (new Set(excerpts.map((e) => JSON.stringify([e.entryId, e.start, e.end]))).size !== excerpts.length)
      throw new Error('Each selected excerpt must be distinct.')
    if (req.work) {
      const w = workAt(store, destination, req.work.id)
      if (w.revision !== req.work.revision) throw new Error('This work changed. Review it again before sending.')
      const priorScope = store.db
        .prepare(
          `select scope from specialist_escalations where chief_chat=? and
        (work_id=? or destination_entry=(select user_entry_id from chief_work where conversation_id=? and id=?)) limit 1`
        )
        .get(destination, w.id, destination, w.id)
      if (
        priorScope &&
        fingerprint(priorScope.scope ? JSON.parse(str(priorScope.scope)) : null) !== fingerprint(req.scope ?? null)
      )
        throw new Error('This work already has a handoff in another project session.')
    }
    const scope = req.scope && {
      projectId: req.scope.projectId,
      hostId: req.scope.hostId,
      environmentId: req.scope.environmentId,
      sessionId: req.scope.sessionId
    }
    store.db
      .prepare('insert into specialist_escalations values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        req.id,
        signature,
        req.sourceChatId,
        owner.id,
        destination,
        chief.id,
        req.work?.id ?? null,
        scope ? JSON.stringify(scope) : null,
        JSON.stringify(sources),
        req.question.trim(),
        JSON.stringify(excerpts),
        null,
        Date.now(),
        req.work?.revision ?? null
      )
    return receipt(store.db.prepare('select * from specialist_escalations where id=?').get(req.id)!)
  })
}

export function getHandoffCheckpoint(
  store: PlatformStore,
  chiefConversationId: string,
  query: { userEntryId?: string; workId?: string; handoffId?: string },
  authority?: Authority
): Checkpoint[] {
  const chief = chiefForHandoff(store)
  if (store.conversations.findDm(chief.id)?.id !== chiefConversationId) return []
  const filters = [query.userEntryId, query.workId, query.handoffId].filter(Boolean)
  if (filters.length !== 1) throw new Error('Select one handoff, original request or work ID.')
  const workLookup = !!query.workId && hasWork(store)
  const condition = query.handoffId
    ? 'id=?'
    : query.userEntryId
      ? 'destination_entry=?'
      : workLookup
        ? `(work_id=? or (work_id is null and destination_entry=(select user_entry_id from chief_work where id=? and conversation_id=?)))`
        : 'work_id=?'
  const args = workLookup ? [query.workId!, query.workId!, chiefConversationId] : [filters[0]!]
  const rows = store.db
    .prepare(
      'select * from specialist_escalations where chief_chat=? and chief_id=? and ' +
        condition +
        ' order by created_at,id'
    )
    .all(chiefConversationId, chief.id, ...args)
  return rows.map((r) => {
    const base = receipt(r)
    if (!base.workId && base.destinationEntryId && hasWork(store)) {
      const linked = store.db
        .prepare('select id from chief_work where conversation_id=? and user_entry_id=?')
        .get(chiefConversationId, base.destinationEntryId)
      if (linked) base.workId = str(linked.id)
    }
    try {
      if ((chief.toolPermissions.read_handoff ?? store.settings.get().toolPermissions.read_handoff) === 'never')
        throw new Error('Reading specialist handoffs is turned off for fai.')
      if (specialist(store, base.sourceChatId).id !== base.specialistId)
        throw new Error('The specialist context changed.')
      const work = base.workId && workAt(store, chiefConversationId, base.workId)
      if (work && !base.destinationEntryId && r.work_revision && work.revision !== num(r.work_revision))
        throw new Error('The linked work changed before this handoff was delivered.')
      const scope = r.scope ? (JSON.parse(str(r.scope)) as HandoffScope) : undefined
      const sources: SessionSource[] = scope ? pinsAt(store, scope, authority) : []
      if (JSON.stringify(sources) !== str(r.pins)) throw new Error('The saved project source manifest changed.')
      const refs = JSON.parse(str(r.excerpts)) as Pin[]
      const excerpts = refs.map((ref) => {
        const item = excerpt(store, base.sourceChatId, base.specialistId, ref)
        if (item.sha256 !== ref.sha256 || ref.authorId !== item.authorId)
          throw new Error('An original excerpt changed.')
        return item
      })
      return {
        ...base,
        availability: 'available',
        scope,
        question: str(r.question),
        excerpts,
        sources: sources.map(({ sourceId, revision, sha256 }) => ({ sourceId, revision, sha256 })),
        ...(work && { workId: work.id, workRevision: work.revision })
      }
    } catch (error) {
      return {
        ...base,
        availability: 'withheld',
        reason: error instanceof Error ? error.message : 'The handoff context is unavailable.'
      }
    }
  })
}

export function handoffOptions(store: PlatformStore, sourceChatId: string) {
  specialist(store, sourceChatId)
  const chief = chiefForHandoff(store),
    dm = store.conversations.findDm(chief.id)
  const receipts = store.db
    .prepare('select * from specialist_escalations where source_chat=? and chief_id=? order by created_at desc')
    .all(sourceChatId, chief.id)
    .map(receipt)
  const work =
    dm && hasWork(store)
      ? store.db
          .prepare(
            "select id,objective,revision from chief_work where conversation_id=? and state='active' order by updated_at desc"
          )
          .all(dm.id)
          .map((w) => ({ id: str(w.id), objective: str(w.objective), revision: num(w.revision) }))
      : []
  return { receipts, work }
}
