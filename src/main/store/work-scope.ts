import type { WorkScope } from '@shared/work-brief'
import type { Services } from '../contracts'
import type { PlatformStore } from './index'
import { getHandoffCheckpoint } from './escalations'
import { projectResultForEntry } from './project-result-requests'
import { workBriefs } from './work-briefs'

/** Resolve display names on demand, with the same current grants as the model tools. */
export function workScope(store: PlatformStore, authority: Pick<Services, 'dataDir' | 'attachments'>, chat: string, id: string): WorkScope {
  const brief = workBriefs(store.db).get(id, chat)
  const original = store.entries.get(brief.userEntryId)
  const inputs = new Set<string>(['Your original message'])
  for (const file of original?.attachments ?? []) inputs.add(file.name + ' (attached to your message)')
  const result = projectResultForEntry(store, authority.dataDir, authority.attachments, chat, brief.userEntryId)
  let withheld = result?.status === 'withheld'
  if (result?.status === 'available') {
    const project = store.projects.get(result.projectId)
    const session = store.db.prepare('select label from project_sessions where project_id=? and id=?').get(result.projectId, result.sessionId)
    if (project && session) inputs.add(project.name + ' / ' + String(session.label))
    for (const citation of result.evidence) {
      inputs.add(citation.name + ' · revision ' + citation.revision + ', line ' + citation.line)
    }
  }
  for (const handoff of getHandoffCheckpoint(store, chat, { workId: id }, authority)) {
    if (handoff.availability === 'withheld') {
      withheld = true
      continue
    }
    const specialist = store.bots.get(handoff.specialistId)
    if (specialist) inputs.add('Selected excerpts from ' + specialist.name)
    const project = handoff.scope && store.projects.get(handoff.scope.projectId)
    if (project) inputs.add(project.name)
  }
  return { inputs: [...inputs], withheld }
}
