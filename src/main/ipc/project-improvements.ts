import type { ImprovementInvoke } from '@shared/project-improvements'
import type { Services } from '../contracts'
import type { PlatformStore } from '../store'
import { revisionText } from '../attachments/project-reads'
import { createProjectImprovements } from '../store/project-improvements'

type Handlers = { [K in keyof ImprovementInvoke]: (req: ImprovementInvoke[K]['req']) => ImprovementInvoke[K]['res'] }

export function improvementHandlers(s: Services, store: PlatformStore): Handlers {
  const repo = () => createProjectImprovements(store,(project,revision) => revisionText(store,project,revision,s.dataDir,s.attachments))
  const changed = (projectId: string) => s.bus.emit('journey:changed', { projectId })
  return {
    'improvement:list': ({ projectId }) => repo().overview(projectId),
    'improvement:propose': ({ projectId,instruction,requiredText,matched,heldout }) => {
      const id = repo().propose(projectId,instruction,requiredText,matched,heldout)
      changed(projectId)
      return id
    },
    'improvement:review': ({ projectId,candidateId,decision }) => {
      repo().review(projectId,candidateId,decision)
      changed(projectId)
    },
    'improvement:trial': ({ projectId,candidateId,lane }) => {
      if (lane !== 'matched' && lane !== 'heldout') throw new Error('Unknown trial case.')
      const candidate = repo().get(projectId,candidateId)
      return s.missions.start(projectId,candidate[lane],candidate.id).id
    },
    'improvement:publish': ({ projectId,candidateId }) => { repo().publish(projectId,candidateId); changed(projectId) },
    'improvement:rollback': ({ projectId,candidateId }) => { repo().rollback(projectId,candidateId); changed(projectId) }
  }
}
