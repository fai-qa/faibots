import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Services } from './contracts'
import { createPlatformServices } from './platform-services'
import { createRuntimeServices } from './runtime-services'
import { fakeBus, fakeCipher } from './store/test-helpers'

describe('createRuntimeServices', () => {
  let dir: string
  let services: Services
  let bus: ReturnType<typeof fakeBus>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-runtime-services-'))
    bus = fakeBus()
    const dataDir = join(dir, 'data')
    const platform = createPlatformServices({ dataDir, bus, cipher: fakeCipher, homeDir: join(dir, 'home') })
    const base = { ...platform, bus, dataDir }
    services = { ...base, ...createRuntimeServices(base) }
  })
  afterEach(async () => {
    await services.routines.shutdown()
    await services.runtime.shutdown()
    await services.mcp.shutdown()
    await services.bridge.shutdown()
    services.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers the collab tools next to the platform tools', async () => {
    const tools = await services.tools.info()
    expect(tools.map((t) => t.name)).toEqual([
      'shell', 'read_file', 'list_dir', 'write_file', 'edit_file', 'web_fetch',
      'update_memory', 'recall_memory', 'skill', 'update_skill',
      'send_to_agent', 'list_bots', 'create_bot', 'pass_turn',
      'assign_to_agent', 'assignment_status', 'wait_for_assignment', 'cancel_assignment', 'group_work_snapshot',
      'plan_work', 'review_work',
      'create_routine', 'list_routines', 'delete_routine'
    ])
    expect(tools.find((t) => t.name === 'create_bot')).toMatchObject({ source: 'faibots', defaultPermission: 'ask' })
    expect(tools.find((t) => t.name === 'create_routine')).toMatchObject({ source: 'faibots', defaultPermission: 'ask' })
    expect(tools.find((t) => t.name === 'list_routines')).toMatchObject({ defaultPermission: 'always' })
  })

  it('stores provider keys through the vault and never returns them', async () => {
    const provider = services.providers.save({ kind: 'anthropic', label: 'Claude API', defaultModelId: '', enabled: true, apiKey: 'sk-ant-test-key-123' })
    expect(provider).toMatchObject({ hasApiKey: true, defaultModelId: 'claude-opus-5-5' })
    expect(services.secrets.getProviderKey(provider.id)).toBe('sk-ant-test-key-123')
    expect(JSON.stringify(services.providers.list())).not.toContain('sk-ant-test-key-123')
  })

  it('runs a dm end to end up to the model call (no network: the bot has no model)', async () => {
    const bot = services.store.bots.create({ name: 'Newbie' })
    const dm = services.runtime.openDm(bot.id)
    const entry = await services.runtime.send({
      conversationId: dm.id,
      text: 'hello @newbie',
      mentions: [],
      mentionsEveryone: false,
      attachmentPaths: [],
      clientNonce: 'n-1'
    })
    expect(entry).toMatchObject({ kind: 'message', author: { kind: 'user' }, text: 'hello @newbie', mentions: [bot.id] })
    for (let i = 0; i < 100 && services.store.entries.page(dm.id, { limit: 5 }).entries.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 5))
    }
    const last = services.store.entries.page(dm.id, { limit: 5 }).entries.at(-1)!
    expect(last).toMatchObject({ kind: 'event', text: 'Newbie could not answer: This bot has no model yet. Pick one in its Profile.' })
    expect(bus.of('conv:changed').some((e) => e.conversation.id === dm.id)).toBe(true)
  })
})
