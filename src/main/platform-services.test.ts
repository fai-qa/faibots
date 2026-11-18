import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_SETTINGS } from '@shared/domain'
import { createPlatformServices } from './platform-services'
import { fakeBus, fakeCipher } from './store/test-helpers'

describe('createPlatformServices', () => {
  let dir: string
  let services: ReturnType<typeof createPlatformServices>
  let bus: ReturnType<typeof fakeBus>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-platform-'))
    bus = fakeBus()
    services = createPlatformServices({ dataDir: join(dir, 'data'), bus, cipher: fakeCipher, homeDir: join(dir, 'home') })
  })
  afterEach(async () => {
    await services.mcp.shutdown()
    await services.bridge.shutdown()
    services.store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers the built-in, memory and skill tools', async () => {
    const names = (await services.tools.info()).map((t) => t.name)
    expect(names).toEqual([
      'shell', 'read_file', 'list_dir', 'write_file', 'edit_file', 'web_fetch',
      'update_memory', 'recall_memory', 'skill', 'update_skill'
    ])
    const defaults = Object.fromEntries((await services.tools.info()).map((t) => [t.name, t.defaultPermission]))
    expect(defaults).toMatchObject({ shell: 'ask', web_fetch: 'always', update_memory: 'always', skill: 'always' })
    const free = (await services.tools.info()).filter((t) => t.autoAllowedInWorkspace).map((t) => t.name)
    expect(free).toEqual(['read_file', 'list_dir', 'write_file', 'edit_file'])
    expect(existsSync(join(dir, 'data', 'faibots.db'))).toBe(true)
  })

  it('a bot\'s memory tool call flows through the registry into its own memory', async () => {
    const bot = services.store.bots.create({ name: 'Keeper' })
    const conversation = services.store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
    const ctx = {
      bot, conversation, turnId: 't', callId: 'c', signal: new AbortController().signal, chain: [], inGroup: false,
      workspaceDir: join(dir, 'ws')
    }
    const result = await services.tools.execute('update_memory', { action: 'write', tier: 'log', content: 'Launch is in May' }, ctx)
    expect(result.isError).toBeUndefined()
    expect(services.memory.promptBlock(bot.id)).toContain('Launch is in May')
  })

  it('deleting a bot removes its private skills and secret values and tells the UI', () => {
    const bot = services.store.bots.create({ name: 'Temp' })
    const keep = services.store.bots.create({ name: 'Keep' })
    const dm = services.store.conversations.create({ kind: 'dm', title: '', botIds: [bot.id] })
    const group = services.store.conversations.create({ kind: 'group', title: 'G', botIds: [bot.id, keep.id], group: DEFAULT_GROUP_SETTINGS })
    const skill = services.skills.save({ name: 'temp-skill', description: 'd', body: 'b', ownerBotId: bot.id })
    services.secrets.set({ botId: bot.id, name: 'TEMP_TOKEN', description: '', value: 'temp-secret-value' })

    services.store.bots.delete(bot.id)

    expect(existsSync(skill.dir)).toBe(false)
    expect(readFileSync(join(dir, 'data', 'secrets.json'), 'utf8')).not.toContain(Buffer.from('temp-secret-value').toString('hex'))
    expect(bus.of('conv:deleted')).toEqual([{ conversationId: dm.id }])
    expect(bus.of('conv:changed').map((e) => e.conversation.botIds)).toEqual([[keep.id]])
    expect(services.store.conversations.get(group.id)!.botIds).toEqual([keep.id])
  })

  it('wires an unavailable-encryption flag into the vault: new secrets refused, existing reads kept', () => {
    const locked = createPlatformServices({
      dataDir: join(dir, 'locked'),
      bus: fakeBus(),
      cipher: fakeCipher,
      homeDir: join(dir, 'home'),
      canStoreSecrets: () => false
    })
    const bot = locked.store.bots.create({ name: 'R' })
    expect(() => locked.secrets.set({ botId: bot.id, name: 'TOKEN', description: '', value: 'v' })).toThrow(/OS encryption is not available/)
    expect(locked.secrets.list(bot.id)).toEqual([]) // nothing silently stored
    locked.store.close()
  })
})
