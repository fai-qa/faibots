import type { ContentInvoke } from '@shared/project-content'
import type { Id } from '@shared/domain'
import type { Services } from '../contracts'
import type { PlatformStore } from '../store'
import { createSnapshotService } from '../attachments/snapshots'
import { prepareNoteReader, revisionText } from '../attachments/project-reads'

type Handlers = { [C in keyof ContentInvoke]: (req: ContentInvoke[C]['req']) =>
  C extends 'content:read-source' ? Promise<ContentInvoke[C]['res']> : ContentInvoke[C]['res'] }

export function projectContentHandlers(s: Services, store: PlatformStore): Handlers {
  const changed = (projectId: Id) => s.bus.emit('journey:changed', { projectId })
  const refreshGrants = (itemId: Id) => {
    for (const row of store.db.prepare('select project_id from library_access where item_id=?').all(itemId))
      changed(String(row.project_id))
  }
  const readPage = (projectId: Id, pageId: Id) => {
    const page = store.projectContent.pages(projectId).find((p) => p.id === pageId)
    if (!page) throw new Error('Page not found in this project.')
    const run = store.journeyRuns.get(page.runId)
    const revision = run?.artifactId && store.artifacts.revisions(run.artifactId).find((r) => r.id === page.revisionId)
    if (!revision) throw new Error('Published revision not found.')
    const body = revisionText(store, projectId, revision, s.dataDir, s.attachments)
    return { body, sources: (revision.provenance.sources ?? []).map(({ name, sha256 }) => ({ name, sha256 })) }
  }
  return {
    'content:project': ({ projectId }) => store.projectContent.overview(projectId),
    'content:select': ({ projectId, itemId, selected }) => {
      store.projectContent.select(projectId, itemId, selected)
      changed(projectId)
    },
    'content:restore': ({ projectId, itemId }) => {
      store.projectContent.restore(projectId, itemId)
      refreshGrants(itemId)
    },
    'content:revoke': ({ projectId, itemId, targetProjectId }) => {
      store.projectContent.revoke(projectId, itemId, targetProjectId)
      refreshGrants(itemId)
    },
    'content:share': ({ projectId, itemId, targetProjectId }) => {
      store.projectContent.share(projectId, itemId, targetProjectId)
      changed(targetProjectId)
      changed(projectId)
    },
    'content:revise': ({ projectId, itemId, path }) => {
      if (
        !store.projectContent
          .library(projectId)
          .some((i) => i.itemId === itemId && i.ownerProjectId === projectId && i.readable)
      )
        throw new Error('Only the owning project can revise an accessible source.')
      createSnapshotService({
        attachments: s.attachments,
        projects: store.projects,
        projectSources: store.projectSources
      }).attach(projectId, [path], itemId)
      refreshGrants(itemId)
    },
    'content:read-source': async ({ projectId, sourceId }) => {
      const pin = store.projectContent.pin(projectId, sourceId)
      const read = await prepareNoteReader(store, projectId, [pin], s.dataDir, s.attachments)
      return { text: read(pin), sha256: pin.sha256 }
    },
    'content:read-page': ({ projectId, pageId }) => readPage(projectId, pageId),
    'content:rerun': ({ projectId, runId }) => ({ runId: s.missions.start(projectId, runId).id }),
    'content:evaluate': ({ projectId, runId }) => {
      const outcome = store.projectContent.reevaluate(projectId, runId, (candidateId) => {
        const page = store.projectContent.pages(projectId).find((p) => p.runId === candidateId)
        if (!page) throw new Error('No reviewed Page is available for these inputs.')
        readPage(projectId, page.id)
      })
      changed(projectId)
      return outcome
    }
  }
}
