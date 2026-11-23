import { createHash, randomUUID } from 'node:crypto'
import type { ArtifactProvenance, Entry } from '@shared/domain'
import type { AcceptedWorkPage, WorkPageRequest } from '@shared/project-content'
import type { Services } from '../contracts'
import { num, str, transaction, type Row } from './db'
import { chiefForHandoff, getHandoffCheckpoint } from './escalations'
import type { PlatformStore } from './index'
import { MAX_PROJECT_NAME } from './projects'
import { readProjectResult } from './project-result-requests'
import { workBriefs } from './work-briefs'

type Authority = Pick<Services, 'dataDir' | 'attachments'>
type Source = NonNullable<ArtifactProvenance['sources']>[number]
type Inputs = {
  results: string[]
  handoffs: string[]
  attachments: { entryId: string; id: string; sha256: string }[]
  evidenceIds: string[]
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const unavailable = () => new Error('The evidence for this work is no longer available.')
const pages = `select p.id,p.space_id,s.project_id,p.work_id,p.work_revision,p.partial,p.chat_id,p.entry_id,p.inputs,
  p.revision_id,p.created_at,v.sha256,v.provenance,a.name,d.reviewer
  from accepted_work_pages p join artifact_revisions v on v.id=p.revision_id
  join project_spaces s on s.id=p.space_id
  join artifacts a on a.id=v.artifact_id and a.project_id=s.project_id join review_decisions d on d.id=p.review_id`

function describe(row: Row): AcceptedWorkPage {
  return {
    id: str(row.id),
    spaceId: str(row.space_id),
    projectId: str(row.project_id),
    name: str(row.name),
    workId: str(row.work_id),
    workRevision: num(row.work_revision),
    partial: Boolean(row.partial),
    revisionId: str(row.revision_id),
    createdAt: num(row.created_at),
    sha256: str(row.sha256),
    reviewer: str(row.reviewer)
  }
}

export function acceptedWorkPages(store: PlatformStore, authority: Authority) {
  function inputRefs(chat: string, workId: string, originalId: string, evidenceIds: string[]): Inputs {
    const results = new Set<string>()
    const handoffs = new Set(getHandoffCheckpoint(store, chat, { workId }, authority).map((h) => h.id))
    const attachments: Inputs['attachments'] = []
    for (const entryId of new Set([originalId, ...evidenceIds])) {
      const entry: Entry | undefined = store.entries.get(entryId)
      if (!entry || entry.conversationId !== chat) throw unavailable()
      const selected = entry.meta?.selectedResultEntryId ?? entryId
      if (
        entry.meta?.selectedResultEntryId ||
        store.db
          .prepare('select 1 from project_result_requests where entry_id=? and conversation_id=?')
          .get(selected, chat)
      ) {
        results.add(selected)
      }
      for (const handoff of getHandoffCheckpoint(store, chat, { userEntryId: entryId }, authority))
        handoffs.add(handoff.id)
      for (const file of entry.attachments) {
        const sha256 = file.sha256 ?? digest(authority.attachments.read(file, file.sizeBytes))
        attachments.push({ entryId, id: file.id, sha256 })
      }
    }
    return { results: [...results], handoffs: [...handoffs], attachments, evidenceIds }
  }

  function verify(chat: string, inputs: Inputs) {
    const projects = new Set<string>()
    const sources = new Map<string, Source>()
    for (const entryId of inputs.results) {
      const result = readProjectResult(store, authority, chat, entryId)
      if (!result) throw unavailable()
      projects.add(result.projectId)
      for (const { source } of result.citations) {
        const stored = store.projectSources.get(source.sourceId)
        if (!stored) throw unavailable()
        sources.set(source.sourceId, { ...source, attachmentId: stored.attachmentId })
      }
    }
    for (const id of inputs.handoffs) {
      const [handoff] = getHandoffCheckpoint(store, chat, { handoffId: id }, authority)
      if (handoff?.availability !== 'available') throw unavailable()
      if (handoff.scope) projects.add(handoff.scope.projectId)
      for (const ref of handoff.sources ?? []) {
        const source = store.projectSources.get(ref.sourceId)
        if (!source || !handoff.scope) throw unavailable()
        const pin = store.projectContent.pin(handoff.scope.projectId, source.id)
        sources.set(source.id, { ...pin, name: source.name, attachmentId: source.attachmentId })
      }
    }
    for (const ref of inputs.attachments) {
      const entry = store.entries.get(ref.entryId)
      const file = entry?.attachments.find((a) => a.id === ref.id)
      if (
        entry?.conversationId !== chat ||
        !file ||
        digest(authority.attachments.read(file, file.sizeBytes)) !== ref.sha256
      )
        throw unavailable()
    }
    if (projects.size > 1)
      throw new Error('This work contains evidence from different projects and cannot be saved to one Space.')
    return { projectId: [...projects][0], sources: [...sources.values()] }
  }

  function authorized(req: WorkPageRequest) {
    const chief = chiefForHandoff(store)
    if (chief.hidden || store.conversations.findDm(chief.id)?.id !== req.conversationId)
      throw new Error('Open the original fai chat.')
    const brief = workBriefs(store.db).get(req.workId, req.conversationId)
    if (brief.state !== 'accepted' || brief.revision !== req.revision || !brief.result.trim())
      throw new Error('Only the current owner-accepted result can be saved.')
    const inputs = inputRefs(brief.conversationId, brief.id, brief.userEntryId, brief.evidenceIds)
    const scope = verify(brief.conversationId, inputs)
    return { brief, inputs, scope }
  }

  function readVerified(row: Row) {
    const inputs: Inputs = JSON.parse(str(row.inputs))
    const scope = verify(str(row.chat_id), inputs)
    if (scope.projectId && scope.projectId !== row.project_id) throw unavailable()
    const stored: ArtifactProvenance = JSON.parse(str(row.provenance))
    if (JSON.stringify(stored.sources) !== JSON.stringify(scope.sources)) throw unavailable()
    const body = str(
      store.db.prepare('select body from accepted_work_pages where id=?').get(str(row.id))!.body
    )
    if (digest(body) !== row.sha256) throw new Error('The saved result no longer matches its revision.')
    return {
      body,
      sources: scope.sources.map(({ name, sha256, revision }) => ({
        name: name + ' · revision ' + revision,
        sha256
      })),
      attribution: {
        workId: str(row.work_id),
        workRevision: num(row.work_revision),
        ownerAccepted: true as const,
        partial: Boolean(row.partial)
      }
    }
  }

  const byWork = (workId: string) => store.db.prepare(pages + ' where p.work_id=?').get(workId)
  const projectList = (id?: string) =>
    store.projects
      .list()
      .filter((p) => !id || p.id === id)
      .map(({ id, name }) => ({ id, name }))

  return {
    destinations(req: WorkPageRequest) {
      const { scope } = authorized(req)
      const saved = byWork(req.workId)
      return {
        projects: projectList(scope.projectId ?? (saved && str(saved.project_id))),
        ...(saved && { saved: describe(saved) })
      }
    },
    save(req: WorkPageRequest & { projectId: string }): AcceptedWorkPage {
      return transaction(store.db, () => {
        const { brief, inputs, scope } = authorized(req)
        if (scope.projectId && scope.projectId !== req.projectId)
          throw new Error('Save this result in the project that provided its evidence.')
        const space = store.projectContent.space(req.projectId)
        const existing = byWork(brief.id)
        if (existing) {
          if (
            existing.space_id !== space.id ||
            existing.work_revision !== brief.revision ||
            existing.sha256 !== digest(brief.result)
          ) {
            throw new Error('This accepted result already has a different saved destination or revision.')
          }
          readVerified(existing)
          return describe(existing)
        }
        const artifact = store.artifacts.create({
          projectId: req.projectId,
          name: brief.deliverable.slice(0, MAX_PROJECT_NAME),
          kind: 'work-result'
        })
        const revision = store.artifacts.createRevision({
          artifactId: artifact.id,
          sha256: digest(brief.result),
          provenance: {
            projectId: req.projectId,
            sources: scope.sources,
            note: 'Owner-accepted fai chat work ' + brief.id + ', revision ' + brief.revision
          }
        })
        const review = store.artifacts.addReview({
          artifactRevisionId: revision.id,
          rubric: brief.checks,
          reviewer: 'Owner',
          decision: 'accepted',
          explanation: brief.partial
            ? 'The owner accepted this partial result.'
            : 'The owner accepted this result in fai chat.'
        })
        store.artifacts.updateStatus(artifact.id, 'reviewed')
        store.db
          .prepare('insert into accepted_work_pages values (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(
            randomUUID(),
            space.id,
            brief.id,
            brief.revision,
            brief.conversationId,
            brief.userEntryId,
            revision.id,
            review.id,
            JSON.stringify(inputs),
            brief.result,
            Number(brief.partial),
            Date.now()
          )
        return describe(byWork(brief.id)!)
      })
    },
    list(projectId: string) {
      return store.db
        .prepare(pages + ' where s.project_id=? order by p.created_at desc')
        .all(projectId)
        .map((row) => {
          const page = describe(row)
          try {
            verify(str(row.chat_id), JSON.parse(str(row.inputs)))
          } catch {
            page.name = 'Unavailable work result'
          }
          return page
        })
    },
    read(projectId: string, pageId: string) {
      const row = store.db.prepare(pages + ' where s.project_id=? and p.id=?').get(projectId, pageId)
      if (!row) return
      return readVerified(row)
    }
  }
}
