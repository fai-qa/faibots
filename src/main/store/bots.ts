import { randomUUID } from 'node:crypto'
import { AVATAR_SHAPES, BOT_COLORS, type Bot, type BotAvatar, type Id, type ModelRoute } from '@shared/domain'
import type { BotRepo, SettingsRepo } from '../contracts'
import { bool, defined, num, parseJson, str, transaction, type Db, type Row } from './db'

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
/** Windows device names: a bot's workspace folder is named after its handle and cannot use them. */
const RESERVED_HANDLE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/
const MAX_NAME = 80
export const MAIN_BOT_NAME = 'fai'

export function assertRemovableBot(bot: Bot | undefined): void {
  if (bot?.isPrimary && bot.name === MAIN_BOT_NAME) throw new Error('fai is your permanent main bot.')
}

/** What a bot delete removed or changed, so listeners can clean files and notify the UI. */
export interface BotDeletion {
  bot: Bot
  deletedConversationIds: Id[]
  changedConversationIds: Id[]
}

/** "Dr. Zoë Researcher" -> "drzoeresearcher". Mentions match @handle, so keep it to [a-z0-9]. */
export function handleFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return base.slice(0, 32) || 'bot'
}

function randomAvatar(): BotAvatar {
  // Black reads badly on the dark theme, so random picks skip it (the user can still choose it).
  const colors = BOT_COLORS.filter((c) => c !== 'black')
  return {
    shape: AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)]!,
    color: colors[Math.floor(Math.random() * colors.length)]!
  }
}

function toBot(r: Row): Bot {
  return {
    id: str(r['id']),
    name: str(r['name']),
    handle: str(r['handle']),
    label: str(r['label']),
    description: str(r['description']),
    soul: str(r['soul']),
    avatar: parseJson<BotAvatar>(r['avatar'], { shape: 'blob', color: 'gray' }),
    model: parseJson<ModelRoute>(r['model'], { providerId: '', modelId: '' }),
    isPrimary: bool(r['is_primary']),
    toolPermissions: parseJson(r['tool_permissions'], {}),
    mcpServerIds: parseJson<Bot['mcpServerIds']>(r['mcp_server_ids'], 'all'),
    skillIds: parseJson<Id[]>(r['skill_ids'], []),
    notify: bool(r['notify']),
    dailyRunLimit: num(r['daily_run_limit']),
    pinned: bool(r['pinned']),
    hidden: bool(r['hidden']),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at'])
  }
}

function checkName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A bot needs a name')
  if (trimmed.length > MAX_NAME) throw new Error(`Bot names are at most ${MAX_NAME} characters`)
  return trimmed
}

function checkLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0 || limit > 10_000) throw new Error('The daily run limit is a whole number from 0 (no limit) to 10000')
  return limit
}

export function createBotRepo(
  db: Db,
  settings: SettingsRepo,
  onDeleted: (deletion: BotDeletion) => void
): BotRepo {
  const selectAll = db.prepare('select * from bots order by created_at, rowid')
  const selectOne = db.prepare('select * from bots where id = ?')
  const selectByHandle = db.prepare('select * from bots where handle = ?')
  const clearPrimary = db.prepare('update bots set is_primary = 0 where id != ? and is_primary = 1')
  const mainBot = db.prepare('select id from bots where name = ? and is_primary = 1')

  const get = (id: Id) => {
    const row = selectOne.get(id)
    return row ? toBot(row) : undefined
  }

  const handleTaken = (handle: string, exceptId?: Id) => {
    if (RESERVED_HANDLE.test(handle)) return true
    const row = selectByHandle.get(handle)
    return !!row && str(row['id']) !== exceptId
  }

  const uniqueHandle = (base: string) => {
    if (!handleTaken(base)) return base
    for (let n = 2; ; n++) {
      const suffix = String(n)
      const candidate = base.slice(0, 32 - suffix.length) + suffix
      if (!handleTaken(candidate)) return candidate
    }
  }

  const checkHandle = (handle: string, exceptId?: Id) => {
    if (!HANDLE_PATTERN.test(handle)) {
      throw new Error('Handles use lowercase letters, digits, - and _, up to 32 characters')
    }
    if (RESERVED_HANDLE.test(handle)) throw new Error(`@${handle} is a reserved name on Windows; pick another`)
    if (handleTaken(handle, exceptId)) throw new Error(`@${handle} is already taken`)
  }

  const write = (bot: Bot) => {
    db.prepare(
      `insert into bots (id, name, handle, label, description, soul, avatar, model, is_primary, tool_permissions,
         mcp_server_ids, skill_ids, notify, daily_run_limit, pinned, hidden, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (id) do update set name = excluded.name, handle = excluded.handle, label = excluded.label,
         description = excluded.description, soul = excluded.soul, avatar = excluded.avatar, model = excluded.model,
         is_primary = excluded.is_primary, tool_permissions = excluded.tool_permissions,
         mcp_server_ids = excluded.mcp_server_ids, skill_ids = excluded.skill_ids, notify = excluded.notify,
         daily_run_limit = excluded.daily_run_limit, pinned = excluded.pinned, hidden = excluded.hidden, updated_at = excluded.updated_at`
    ).run(
      bot.id, bot.name, bot.handle, bot.label, bot.description, bot.soul,
      JSON.stringify(bot.avatar), JSON.stringify(bot.model), bot.isPrimary ? 1 : 0,
      JSON.stringify(bot.toolPermissions), JSON.stringify(bot.mcpServerIds), JSON.stringify(bot.skillIds),
      bot.notify ? 1 : 0, bot.dailyRunLimit, bot.pinned ? 1 : 0, bot.hidden ? 1 : 0, bot.createdAt, bot.updatedAt
    )
    if (bot.isPrimary) clearPrimary.run(bot.id)
  }

  return {
    list: () => selectAll.all().map(toBot),
    get,
    getByHandle(handle) {
      const row = selectByHandle.get(handle.replace(/^@/, '').toLowerCase())
      return row ? toBot(row) : undefined
    },

    create(input) {
      return transaction(db, () => {
        const name = checkName(input.name)
        if ((input.isPrimary || name.toLowerCase() === MAIN_BOT_NAME) && mainBot.get(MAIN_BOT_NAME)) {
          throw new Error('fai is your permanent main bot. Give the specialist its own name and role.')
        }
        let handle: string
        if (input.handle) {
          handle = input.handle.replace(/^@/, '').toLowerCase()
          checkHandle(handle)
        } else {
          handle = uniqueHandle(handleFromName(name))
        }
        const now = Date.now()
        const hasPrimary = !!db.prepare('select 1 from bots where is_primary = 1').get()
        const bot: Bot = {
          id: randomUUID(),
          name,
          handle,
          label: input.label ?? '',
          description: input.description ?? '',
          soul: input.soul ?? '',
          avatar: input.avatar ?? randomAvatar(),
          model: input.model ?? settings.get().defaultModel ?? { providerId: '', modelId: '' },
          // The first bot coordinates the others unless the caller says otherwise.
          isPrimary: input.isPrimary ?? !hasPrimary,
          toolPermissions: input.toolPermissions ?? {},
          mcpServerIds: input.mcpServerIds ?? 'all',
          skillIds: input.skillIds ?? [],
          notify: input.notify ?? true,
          dailyRunLimit: checkLimit(input.dailyRunLimit ?? 0),
          pinned: input.pinned ?? false,
          hidden: input.hidden ?? false,
          createdAt: now,
          updatedAt: now
        }
        write(bot)
        return bot
      })
    },

    update(id, patch) {
      return transaction(db, () => {
        const current = get(id)
        if (!current) throw new Error('Bot not found')
        if (current.isPrimary && current.name === MAIN_BOT_NAME) {
          if ((patch.name !== undefined && patch.name !== current.name) ||
              (patch.handle !== undefined && patch.handle !== current.handle) ||
              patch.hidden === true || patch.isPrimary === false) {
            throw new Error('fai keeps its name, handle and role as your main bot.')
          }
        } else if ((patch.isPrimary || (patch.name !== undefined && patch.name !== current.name &&
                   patch.name.trim().toLowerCase() === MAIN_BOT_NAME)) && mainBot.get(MAIN_BOT_NAME)) {
          throw new Error('fai is your permanent main bot. Give the specialist its own name and role.')
        }
        const next: Bot = { ...current, ...defined(patch), id, createdAt: current.createdAt, updatedAt: Date.now() }
        if (patch.name !== undefined) next.name = checkName(patch.name)
        if (patch.dailyRunLimit !== undefined) next.dailyRunLimit = checkLimit(patch.dailyRunLimit)
        if (patch.handle !== undefined && patch.handle !== current.handle) {
          next.handle = patch.handle.replace(/^@/, '').toLowerCase()
          checkHandle(next.handle, id)
        }
        write(next)
        return next
      })
    },

    delete(id) {
      const deletion = transaction(db, () => {
        const bot = get(id)
        if (!bot) return undefined
        assertRemovableBot(bot)
        const deletedConversationIds: Id[] = []
        const changedConversationIds: Id[] = []
        const rows = db
          .prepare(`select c.id, c.kind, c.bot_ids from conversations c, json_each(c.bot_ids) m where m.value = ?`)
          .all(id)
        for (const row of rows) {
          const convId = str(row['id'])
          const botIds = parseJson<Id[]>(row['bot_ids'], []).filter((b) => b !== id)
          if (str(row['kind']) === 'group' && botIds.length > 0) {
            db.prepare('update conversations set bot_ids = ?, updated_at = ? where id = ?')
              .run(JSON.stringify(botIds), Date.now(), convId)
            db.prepare('delete from bot_context where conversation_id = ? and bot_id = ?').run(convId, id)
            changedConversationIds.push(convId)
          } else {
            // The bot's dm, its exchanges and a group it was the last member of mean nothing without it.
            db.prepare('delete from conversations where id = ?').run(convId)
            deletedConversationIds.push(convId)
          }
        }
        db.prepare('delete from bot_context where bot_id = ?').run(id)
        db.prepare('delete from memory_facts where bot_id = ?').run(id)
        db.prepare('delete from memory_profiles where bot_id = ?').run(id)
        db.prepare('delete from secrets where bot_id = ?').run(id)
        db.prepare('delete from bots where id = ?').run(id)
        return { bot, deletedConversationIds, changedConversationIds }
      })
      if (deletion) onDeleted(deletion)
    }
  }
}
