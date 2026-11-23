import { createHash } from 'node:crypto'
import type { SessionSource } from '@shared/project-sessions'
import type { Services } from '../contracts'
import { readSourceSnapshot, revisionText } from '../attachments/project-reads'
import type { PlatformStore } from './index'
import { acceptedWorkPages } from './accepted-work-pages'
import { str } from './db'

type Authority = Pick<Services, 'attachments' | 'dataDir'>
export type PageCheck = { active: Set<string>; count: number }
export interface PageEvidence {
  id: string
  spaceId: string
  projectId: string
  name: string
  revisionId: string
  revision: number
  sha256: string
  body: string
  reviewer: string
  partial: boolean
  sources: SessionSource[]
  attachments: { name: string; sha256: string }[]
  parentPages: { id: string; name: string; revisionId: string; sha256: string }[]
}

export function readPageEvidence(
  store: PlatformStore, authority: Authority, projectId: string, pageId: string,
  check: PageCheck = { active: new Set(), count: 0 }
): PageEvidence {
  if (check.active.has(pageId) || ++check.count > 64)
    throw new Error('The linked Page history could not be verified within the read limit.')
  check.active.add(pageId)
  try {
    const row = store.db.prepare(`with page as (
      select p.id,c.space_id,p.revision_id,p.review_id,'journey' kind from space_pages p
        join project_context c on c.run_id=p.run_id join journey_runs r on r.id=p.run_id
        where p.id=? and r.project_id=? and r.status='complete'
      union all select id,space_id,revision_id,review_id,'work' from accepted_work_pages where id=?)
      select p.*,a.id artifact_id,a.name,d.reviewer from page p join project_spaces s on s.id=p.space_id
      join artifact_revisions v on v.id=p.revision_id join artifacts a on a.id=v.artifact_id and a.project_id=s.project_id
      join review_decisions d on d.id=p.review_id and d.artifact_revision_id=v.id and d.decision='accepted'
      where s.project_id=?`).get(pageId, projectId, pageId, projectId)
    if (!row) throw new Error('No accepted Page is available here.')
    const revision = store.artifacts.revisions(str(row.artifact_id)).find(r => r.id === row.revision_id)
    if (!revision || revision.provenance.projectId !== projectId) throw new Error('The Page revision is unavailable.')
    const work = row.kind === 'work' ? acceptedWorkPages(store,authority,check).read(projectId,pageId) : undefined
    if (row.kind === 'work' && !work) throw new Error('The accepted work Page is unavailable.')
    const body = work?.body ?? revisionText(store,projectId,revision,authority.dataDir,authority.attachments)
    if (createHash('sha256').update(body).digest('hex') !== revision.sha256)
      throw new Error('The Page body no longer matches its saved revision.')
    const sources = (revision.provenance.sources ?? []).map(ref => {
      const legacy = !ref.sourceId && store.db.prepare(
        'select id from project_sources where project_id=? and attachment_id=? and sha256=?'
      ).get(projectId,ref.attachmentId,ref.sha256)
      const pin = store.projectContent.pin(projectId,ref.sourceId ?? (legacy ? str(legacy.id) : ''))
      const source = store.projectContent.check(projectId,pin)
      if (pin.sha256 !== ref.sha256 || source.attachmentId !== ref.attachmentId ||
        (ref.itemId && ref.itemId !== pin.itemId) || (ref.revision !== undefined && ref.revision !== pin.revision))
        throw new Error('A Page source no longer matches its revision.')
      if (work) readSourceSnapshot(authority.dataDir,authority.attachments,source)
      return { ...pin, name: source.name }
    })
    return { id:pageId, projectId, spaceId:str(row.space_id), name:str(row.name), revisionId:revision.id,
      revision:revision.revisionNo, sha256:revision.sha256, body, reviewer:str(row.reviewer),
      partial:work?.attribution.partial ?? false, sources, attachments:work?.attachments ?? [], parentPages:work?.parentPages ?? [] }
  } finally {
    check.active.delete(pageId)
  }
}
