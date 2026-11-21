import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'
import type {
  ProjectAddress,
  ProjectAnswer,
  ProjectSession,
  SessionInvoke,
  SessionSource
} from '@shared/project-sessions'
import type { PlatformStore } from './index'
import { num, str, transaction, type Row } from './db'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const keys = (sources: SessionSource[]) =>
  sources.map((s) => [s.itemId, s.sourceId, s.revision, s.sha256].join('/')).sort()

function fromRow(row: Row): ProjectSession {
  return {
    id: str(row.id),
    projectId: str(row.project_id),
    hostId: str(row.host_id),
    environmentId: str(row.environment_id),
    ownerId: str(row.owner_id),
    label: str(row.label),
    mode: str(row.mode) as ProjectSession['mode'],
    ...(row.parent_id && { parentId: str(row.parent_id) }),
    engine: str(row.engine),
    sources: JSON.parse(str(row.sources)) as SessionSource[],
    createdAt: num(row.created_at)
  }
}

export function createProjectSessions(store: PlatformStore, dataDir: string) {
  const db = store.db
  const hostKey = hash(JSON.stringify([process.platform, hostname().toLowerCase()]))
  const root = realpathSync.native(resolve(dataDir))
  const rootKey = hash(process.platform === 'win32' ? root.toLowerCase() : root)
  function address(projectId: string): ProjectAddress {
    if (!store.projects.get(projectId)) throw new Error('Unknown project ID.')
    return transaction(db, () => {
      db.prepare('insert or ignore into session_hosts values (?,?)').run(hostKey, randomUUID())
      const hostId = str(db.prepare('select host_id from session_hosts where host_key=?').get(hostKey)!.host_id)
      db.prepare('insert or ignore into session_environments values (?,?,?)').run(hostId, rootKey, randomUUID())
      const env = db
        .prepare('select environment_id from session_environments where host_id=? and root_key=?')
        .get(hostId, rootKey)!
      return { projectId, hostId, environmentId: str(env.environment_id) }
    })
  }
  function assertHost(scope: ProjectAddress) {
    const actual = address(scope.projectId)
    if (scope.hostId !== actual.hostId || scope.environmentId !== actual.environmentId)
      throw new Error('The host or environment ID does not match this desktop profile.')
  }
  function selected(projectId: string): SessionSource[] {
    return store.projectContent
      .library(projectId)
      .filter((item) => item.selected && item.readable)
      .map(({ itemId, revision, source }) => ({
        itemId,
        sourceId: source.id,
        name: source.name,
        revision,
        sha256: source.sha256
      }))
  }
  function sessionAt(scope: ProjectAddress, sessionId: string): ProjectSession {
    assertHost(scope)
    const r = db
      .prepare('select * from project_sessions where id=? and project_id=? and host_id=? and environment_id=?')
      .get(sessionId, scope.projectId, scope.hostId, scope.environmentId)
    if (!r)
      throw new Error(
        'This session belongs to a different project, host or environment. Start fresh or choose Fork.'
      )
    return fromRow(r)
  }
  function binding() {
    const chief = store.bots.list().find((b) => b.isPrimary)
    if (!chief) throw new Error('The main bot is unavailable.')
    const route = chief.model.providerId ? chief.model : store.settings.get().defaultModel
    const provider = route && store.providers.get(route.providerId)
    return {
      ownerId: chief.id,
      engine: JSON.stringify([
        provider?.kind ?? 'local',
        route?.providerId ?? '',
        route?.modelId || provider?.defaultModelId || '',
        provider?.baseUrl ?? '',
        provider?.enabled ?? false,
        route?.effort ?? ''
      ])
    }
  }
  function ready(scope: ProjectAddress, sessionId: string) {
    const session = sessionAt(scope, sessionId)
    const current = binding()
    if (current.ownerId !== session.ownerId || current.engine !== session.engine)
      throw new Error('The main bot or its configured model changed. Start fresh or fork selected results.')
    if (JSON.stringify(keys(session.sources)) !== JSON.stringify(keys(selected(scope.projectId))))
      throw new Error(
        'Selected source revisions or permissions changed. Start fresh or fork results you can still read.'
      )
    return session
  }
  function records(id: string): ProjectAnswer[] {
    return db
      .prepare(
        `select a.payload from project_answers a where a.session_id=? or
      exists(select 1 from project_history_selection h where h.session_id=? and h.answer_id=a.id)
      order by a.created_at,a.rowid`
      )
      .all(id, id)
      .map((r) => JSON.parse(str(r.payload)) as ProjectAnswer)
  }
  function checkAnswer(
    projectId: string,
    answer: ProjectAnswer,
    readable: SessionSource[],
    verify: (id: string, s: SessionSource) => void
  ) {
    const available = new Set(keys(readable))
    if (!keys(answer.sources).every((key) => available.has(key)))
      throw new Error('A selected result references a revision outside the target project selection.')
    const included = new Set(answer.verifiedSourceIds)
    for (const source of answer.sources) if (included.has(source.sourceId)) verify(projectId, source)
  }
  function open(req: SessionInvoke['session:open']['req'], verify: (id: string, s: SessionSource) => void) {
    assertHost(req)
    if (req.mode === 'continue') {
      const session = ready(req, req.sessionId)
      return { session, ...historyAt(req, session.id, verify) }
    }
    if (req.mode !== 'fresh' && req.mode !== 'fork') throw new Error('Choose a session mode.')
    const sources = selected(req.projectId)
    const { engine, ownerId } = binding()
    const label = req.label?.trim().slice(0, 100) || new Date().toLocaleString()
    return transaction(db, () => {
      let history: ProjectAnswer[] = []
      if (req.mode === 'fork') {
        const parent = sessionAt({ ...req, projectId: req.parentProjectId }, req.parentId)
        const available = new Map(records(parent.id).map((e) => [e.id, e]))
        if (
          !Array.isArray(req.answerIds) ||
          !req.answerIds.length ||
          req.answerIds.length > 100 ||
          new Set(req.answerIds).size !== req.answerIds.length
        )
          throw new Error('Select between 1 and 100 distinct results to carry.')
        history = req.answerIds.map((id) => {
          const entry = available.get(id)
          if (!entry) throw new Error('A result does not belong to the chosen parent session.')
          checkAnswer(parent.projectId, entry, selected(parent.projectId), verify)
          checkAnswer(req.projectId, entry, sources, verify)
          return entry
        })
      }
      const id = randomUUID(),
        at = Date.now()
      db.prepare('insert into project_sessions values (?,?,?,?,?,?,?,?,?,?,?)').run(
        id,
        req.projectId,
        req.hostId,
        req.environmentId,
        ownerId,
        label,
        req.mode,
        req.mode === 'fork' ? req.parentId : null,
        engine,
        JSON.stringify(sources),
        at
      )
      for (const answer of history)
        db.prepare('insert into project_history_selection values (?,?)').run(id, answer.id)
      return { session: sessionAt(req, id), history, omittedHistory: 0 }
    })
  }
  function list(projectId: string) {
    const scope = address(projectId)
    const allowed = new Set(keys(selected(projectId)))
    const sessions = db
      .prepare(
        'select * from project_sessions where project_id=? and host_id=? and environment_id=? order by created_at desc,rowid desc'
      )
      .all(scope.projectId, scope.hostId, scope.environmentId)
      .map(fromRow)
      .map((s) => ({ ...s, sources: s.sources.filter((pin) => allowed.has(keys([pin])[0]!)) }))
    return { address: scope, sessions }
  }
  function save(answer: ProjectAnswer) {
    db.prepare('insert into project_answers values (?,?,?,?,?)').run(
      answer.id,
      answer.sessionId,
      answer.query,
      JSON.stringify(answer),
      answer.createdAt
    )
  }
  function historyAt(scope: ProjectAddress, id: string, verify: (id: string, s: SessionSource) => void) {
    sessionAt(scope, id)
    const pins = selected(scope.projectId)
    const rows = records(id)
    const history = rows.filter((entry) => {
      try {
        checkAnswer(scope.projectId, entry, pins, verify)
        return true
      } catch {
        return false
      }
    })
    return { history, omittedHistory: rows.length - history.length }
  }
  return { list, ready, open, save, historyAt, checkAnswer }
}
