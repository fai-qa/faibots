// Builds the runtime services on top of the platform ones. The integrator calls this from
// src/main/index.ts after createPlatformServices. It registers the collab tools (send_to_agent,
// list_bots, create_bot, pass_turn) and the routine tools (create_routine, list_routines,
// delete_routine) into deps.tools. On quit, call routines.shutdown() and webhooks.close(), then
// runtime.shutdown() before mcp.shutdown(), bridge.shutdown() and store.close().

import type { MissionRunService, ProviderService, RoutineService, Runtime, Services, WebhookHost } from './contracts'
import { workBriefTools } from './agent/work-brief-tools'
import { createRuntime } from './agent'
import { escalationTool } from './agent/escalation-tool'
import { projectResultTool } from './agent/project-result-tool'
import { createProviderService } from './providers/provider-service'
import { createMissionRunService } from './routines/mission-run'
import { routineTools } from './routines/routine-tools'
import { createRoutineService } from './routines/routines'
import { createWebhookServer } from './routines/webhook-server'
import type { PlatformStore } from './store'

export function createRuntimeServices(deps: Omit<Services, 'providers' | 'runtime' | 'routines' | 'webhooks' | 'missions'>): {
  providers: ProviderService
  runtime: Runtime
  routines: RoutineService
  missions: MissionRunService
  webhooks: WebhookHost
} {
  const providers = createProviderService({ store: deps.store, secrets: deps.secrets, bus: deps.bus })
  const runtime = createRuntime({ ...deps, store: deps.store as PlatformStore, providers })
  for (const tool of runtime.assignments.tools()) deps.tools.register(tool)
  for (const tool of workBriefTools(deps.store as PlatformStore, deps.bus, deps)) deps.tools.register(tool)
  deps.tools.register(escalationTool(deps.store as PlatformStore, deps))
  deps.tools.register(projectResultTool(deps.store as PlatformStore, deps))
  const routines = createRoutineService({ store: deps.store, runtime, bus: deps.bus })
  for (const tool of routineTools(routines)) deps.tools.register(tool)
  const missions = createMissionRunService({ store: deps.store as PlatformStore, runtime, providers, skills: deps.skills, attachments: deps.attachments, dataDir: deps.dataDir, bus: deps.bus })
  // Runs left working/waiting_review by a crash are unknown, not success (A20).
  missions.closeInterrupted(Date.now())
  const webhooks = createWebhookServer({ triggerWebhook: (id, token, payload) => routines.triggerWebhook(id, token, payload) })
  return { providers, runtime, routines, missions, webhooks }
}
