import type { SecretVault, SkillService, ToolRegistry } from '../contracts'
import type { PlatformMemoryService } from '../memory/memory'
import { fileTools } from './builtin/files'
import { memoryTools, skillTools } from './builtin/memory-skills'
import { shellTool } from './builtin/shell'
import { webFetchTool } from './builtin/web-fetch'

export { createApprovalService } from './approvals'
export { createToolRegistry, type McpToolSource } from './registry'

/** Register the built-in, memory and skill tools. */
export function registerPlatformTools(
  registry: ToolRegistry,
  deps: {
    homeDir: string
    secrets: Pick<SecretVault, 'envForBot'>
    memory: PlatformMemoryService
    skills: SkillService & { dirsForBot(botId: string): string[] }
    fetch?: typeof fetch
  }
): void {
  const tools = [
    shellTool({ secrets: deps.secrets, homeDir: deps.homeDir }),
    ...fileTools({ homeDir: deps.homeDir, skillDirsForBot: (botId) => deps.skills.dirsForBot(botId) }),
    webFetchTool({ fetch: deps.fetch }),
    ...memoryTools({ memory: deps.memory }),
    ...skillTools({ skills: deps.skills })
  ]
  for (const tool of tools) registry.register(tool)
}
