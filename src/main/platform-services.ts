// Builds every platform service and wires them together. The integrator calls this from
// src/main/index.ts with Electron's userData folder, the event bus and a safeStorage cipher.

import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createAttachmentStore } from './attachments/attachments'
import type { Cipher, EventBus, Services } from './contracts'
import { createToolBridge } from './mcp/bridge'
import { createMcpHost } from './mcp/host'
import { createMemoryService } from './memory/memory'
import { createRecipeService } from './recipes/recipes'
import { createSecretVault } from './secrets/vault'
import { createSkillService } from './skills/skills'
import { createStore, type PlatformStore } from './store'
import { createApprovalService, createToolRegistry, registerPlatformTools } from './tools'

function osUserName(): string {
  try {
    return userInfo().username
  } catch {
    return ''
  }
}

export function createPlatformServices(deps: {
  dataDir: string
  bus: EventBus
  cipher: Cipher
  homeDir: string
  defaultWorkspaceRoot?: string
  /** When false (OS encryption unavailable), the vault refuses new secrets; reads of existing entries still work. */
  canStoreSecrets?: () => boolean
}): Omit<Services, 'providers' | 'runtime' | 'routines' | 'webhooks' | 'missions' | 'bus' | 'dataDir' | 'store'> & { store: PlatformStore } {
  const { dataDir, bus, cipher, homeDir } = deps

  const store = createStore({ dataDir, homeDir, userName: osUserName(), defaultWorkspaceRoot: deps.defaultWorkspaceRoot })
  const secrets = createSecretVault({ db: store.db, cipher, filePath: join(dataDir, 'secrets.json'), canStore: deps.canStoreSecrets })
  const memory = createMemoryService(store.db, { bus })
  const skills = createSkillService({ dataDir, homeDir, store, bus })
  const approvals = createApprovalService({ store, bus })
  const mcp = createMcpHost({ db: store.db, bus, homeDir, store })
  const tools = createToolRegistry({ store, approvals, secrets, mcp, bus })
  registerPlatformTools(tools, { homeDir, secrets, memory, skills })
  const bridge = createToolBridge({ registry: tools })
  const recipes = createRecipeService({ store, memory, skills, mcp })
  const attachments = createAttachmentStore({ dataDir })

  // The db rows went with the bot; clean up its files and tell the UI what changed.
  store.onBotDeleted((deletion) => {
    skills.deleteOwnedBy(deletion.bot.id)
    secrets.prune()
    for (const conversationId of deletion.deletedConversationIds) bus.emit('conv:deleted', { conversationId })
    for (const id of deletion.changedConversationIds) {
      const conversation = store.conversations.get(id)
      if (conversation) bus.emit('conv:changed', { conversation })
    }
  })

  return { store, secrets, memory, skills, tools, approvals, mcp, bridge, recipes, attachments }
}
