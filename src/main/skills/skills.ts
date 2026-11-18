// Skills are SKILL.md folders on disk; the disk is the source of truth and this service keeps an
// in-memory index of it.
//   <dataDir>/skills/<name>/              library (editable)
//   <dataDir>/bot-skills/<botId>/<name>/  a bot's private skills (written with update_skill)
//   ~/.claude/skills, ~/.codex/skills, ~/.agents/skills   external, read-only
// Ids are derived from the folder path, so they stay stable across restarts and rescans. A rename
// rewrites the frontmatter but keeps the folder, so assignments (bot.skillIds) survive it.

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import { MAX_SKILL_CHARS, MAX_SKILLS_PER_BOT, type Bot, type Id, type Skill, type SkillWithBody } from '@shared/domain'
import type { EventBus, SkillService, Store } from '../contracts'
import { isInside } from '../tools/paths'
import { parseSkillFile, renderSkillFile, stringField } from './frontmatter'
import {
  firstParagraph, importName, MAX_SKILL_DESCRIPTION, SKILL_NAME_PATTERN, slugifySkillName, uniqueName
} from './naming'

const IMPORT_EXTENSIONS = new Set(['.md', '.markdown', '.txt'])
const MAX_RESOURCES = 200
const PROMPT_BLOCK_CHARS = 12_000
const PROMPT_DESCRIPTION_CHARS = 250

interface Root {
  dir: string
  source: Skill['source']
  ownerBotId?: Id
}

interface IndexedSkill extends Skill {
  /** Frontmatter `disable-model-invocation: true`: loadable by name, not advertised in the prompt. */
  hidden: boolean
}

export interface PlatformSkillService extends SkillService {
  /** Remove a deleted bot's private skills and its assignments elsewhere. */
  deleteOwnedBy(botId: Id): void
  /** Folders of the skills a bot can use (read_file/list_dir may read them without asking). */
  dirsForBot(botId: Id): string[]
}

const skillId = (dir: string) => `sk_${createHash('sha256').update(resolve(dir)).digest('hex').slice(0, 20)}`

function findSkillMd(dir: string): string | undefined {
  try {
    const entry = readdirSync(dir).find((n) => n.toLowerCase() === 'skill.md')
    return entry ? join(dir, entry) : undefined
  } catch {
    return undefined
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function listResources(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (out.length >= MAX_RESOURCES) return
      if (entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (!(current === dir && entry.name.toLowerCase() === 'skill.md')) {
        out.push(relative(dir, full).split('\\').join('/'))
      }
    }
  }
  try {
    walk(dir)
  } catch {
    // unreadable folder: no resources
  }
  return out.sort()
}

function checkContent(input: { description: string; body: string }): { description: string; body: string } {
  const description = input.description.trim()
  if (!description) throw new Error('Describe when to use this skill ("Use when…")')
  if (description.length > MAX_SKILL_DESCRIPTION) {
    throw new Error(`Skill descriptions are at most ${MAX_SKILL_DESCRIPTION} characters`)
  }
  if (!input.body.trim()) throw new Error('A skill needs instructions')
  if (input.body.length > MAX_SKILL_CHARS) throw new Error(`Skills are at most ${MAX_SKILL_CHARS} characters`)
  return { description, body: input.body }
}

export function createSkillService(deps: {
  dataDir: string
  homeDir: string
  store: Pick<Store, 'bots'>
  bus: EventBus
}): PlatformSkillService {
  const libraryDir = join(deps.dataDir, 'skills')
  const botSkillsDir = join(deps.dataDir, 'bot-skills')
  const externalDirs = ['.claude', '.codex', '.agents'].map((d) => join(deps.homeDir, d, 'skills'))
  let index = new Map<Id, IndexedSkill>()

  const roots = (): Root[] => {
    const list: Root[] = [{ dir: libraryDir, source: 'library' }]
    if (existsSync(botSkillsDir)) {
      for (const entry of readdirSync(botSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) list.push({ dir: join(botSkillsDir, entry.name), source: 'bot', ownerBotId: entry.name })
      }
    }
    for (const dir of externalDirs) list.push({ dir, source: 'external' })
    return list
  }

  const readSkill = (dir: string, root: Root): IndexedSkill | undefined => {
    const file = findSkillMd(dir)
    if (!file) return undefined
    try {
      const { data } = parseSkillFile(readFileSync(file, 'utf8'))
      return {
        id: skillId(dir),
        name: stringField(data, 'name') ?? basename(dir),
        description: stringField(data, 'description') ?? '',
        source: root.source,
        dir,
        ...(root.ownerBotId && { ownerBotId: root.ownerBotId }),
        readOnly: root.source === 'external',
        updatedAt: Math.round(statSync(file).mtimeMs),
        hidden: data['disable-model-invocation'] === true
      }
    } catch (err) {
      console.warn(`[skills] skipped ${dir}:`, err instanceof Error ? err.message : err)
      return undefined
    }
  }

  const scan = () => {
    const next = new Map<Id, IndexedSkill>()
    for (const root of roots()) {
      if (!existsSync(root.dir)) continue
      for (const entry of readdirSync(root.dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(join(root.dir, entry.name)))) continue
        const skill = readSkill(join(root.dir, entry.name), root)
        if (skill) next.set(skill.id, skill)
      }
    }
    index = next
  }

  const publicSkill = ({ hidden: _hidden, ...skill }: IndexedSkill): Skill => skill
  const sortSkills = (skills: IndexedSkill[]) => {
    const order = { bot: 0, library: 1, external: 2 }
    return skills.sort((a, b) => order[a.source] - order[b.source] || a.name.localeCompare(b.name))
  }

  const visible = (bot: Bot): IndexedSkill[] => {
    const own = [...index.values()].filter((s) => s.ownerBotId === bot.id)
    const assigned = bot.skillIds.map((id) => index.get(id)).filter((s): s is IndexedSkill => !!s && s.ownerBotId !== bot.id)
    return [...sortSkills(own), ...sortSkills(assigned)]
  }

  const forBot = (botId: Id) => {
    const bot = deps.store.bots.get(botId)
    return bot ? visible(bot) : []
  }

  /** Writable skills that share a namespace with `ownerBotId` (library, or that bot's private set). */
  const nameTaken = (name: string, ownerBotId: Id | undefined, exceptId?: Id) =>
    [...index.values()].some(
      (s) => s.id !== exceptId && s.source !== 'external' && s.ownerBotId === ownerBotId && s.name === name
    )

  const rootFor = (ownerBotId: Id | undefined) => (ownerBotId ? join(botSkillsDir, ownerBotId) : libraryDir)

  const newFolder = (name: string, ownerBotId: Id | undefined) => {
    const root = rootFor(ownerBotId)
    mkdirSync(root, { recursive: true })
    const folder = uniqueName(name, (n) => existsSync(join(root, n)))
    return join(root, folder)
  }

  const changed = () => deps.bus.emit('skills:changed', { at: Date.now() })

  /** Remove skill ids from every bot's assignments. */
  const unassign = (ids: Set<Id>) => {
    let touched = false
    for (const bot of deps.store.bots.list()) {
      const kept = bot.skillIds.filter((id) => !ids.has(id))
      if (kept.length !== bot.skillIds.length) {
        deps.store.bots.update(bot.id, { skillIds: kept })
        touched = true
      }
    }
    if (touched) deps.bus.emit('bots:changed', { bots: deps.store.bots.list() })
  }

  const assign = (botId: Id, ids: Id[]) => {
    const bot = deps.store.bots.get(botId)
    if (!bot) throw new Error('Bot not found')
    const next = [...new Set([...bot.skillIds, ...ids])]
    const own = [...index.values()].filter((s) => s.ownerBotId === botId).length
    if (next.length + own > MAX_SKILLS_PER_BOT) throw new Error(`A bot can use at most ${MAX_SKILLS_PER_BOT} skills`)
    deps.store.bots.update(botId, { skillIds: next })
    deps.bus.emit('bots:changed', { bots: deps.store.bots.list() })
  }

  const get = (id: Id): SkillWithBody => {
    const skill = index.get(id)
    if (!skill) throw new Error('Skill not found')
    const file = findSkillMd(skill.dir)
    if (!file) throw new Error(`SKILL.md is missing from ${skill.dir}`)
    const { body } = parseSkillFile(readFileSync(file, 'utf8'))
    return { ...publicSkill(skill), body, resources: listResources(skill.dir) }
  }

  /** Write SKILL.md into dir (creating it) and index it. */
  const writeSkill = (dir: string, ownerBotId: Id | undefined, input: { name: string; description: string; body: string }) => {
    mkdirSync(dir, { recursive: true })
    const existingFile = findSkillMd(dir)
    const file = existingFile ?? join(dir, 'SKILL.md')
    const previous = existingFile ? readFileSync(existingFile, 'utf8') : undefined
    writeFileSync(file, renderSkillFile({ ...input, previous }), 'utf8')
    const root: Root = ownerBotId ? { dir: rootFor(ownerBotId), source: 'bot', ownerBotId } : { dir: libraryDir, source: 'library' }
    const skill = readSkill(dir, root)
    if (!skill) throw new Error('Could not read the skill back after saving it')
    index.set(skill.id, skill)
    return skill
  }

  const removeDir = (dir: string) => {
    // Never delete outside FaiBots's own skill folders.
    if (!isInside(dir, libraryDir) && !isInside(dir, botSkillsDir)) throw new Error('Refusing to delete outside the skill library')
    rmSync(dir, { recursive: true, force: true })
  }

  // ---- import ------------------------------------------------------------------------------

  type Candidate = { kind: 'folder'; dir: string; file: string } | { kind: 'file'; file: string }

  const collect = (path: string): Candidate[] => {
    const full = resolve(path)
    const stat = statSync(full)
    if (stat.isFile()) {
      if (basename(full).toLowerCase() === 'skill.md') return [{ kind: 'folder', dir: resolve(full, '..'), file: full }]
      return IMPORT_EXTENSIONS.has(extname(full).toLowerCase()) ? [{ kind: 'file', file: full }] : []
    }
    if (!stat.isDirectory()) return []
    const skillMd = findSkillMd(full)
    if (skillMd) return [{ kind: 'folder', dir: full, file: skillMd }]
    // A folder of skills and/or loose instruction files (one level deep).
    const out: Candidate[] = []
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const child = join(full, entry.name)
      if (entry.isDirectory()) {
        const md = findSkillMd(child)
        if (md) out.push({ kind: 'folder', dir: child, file: md })
      } else if (IMPORT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        out.push({ kind: 'file', file: child })
      }
    }
    return out
  }

  const importOne = (candidate: Candidate): IndexedSkill => {
    const text = readFileSync(candidate.file, 'utf8')
    if (!text.trim()) throw new Error('the file is empty')
    if (text.length > MAX_SKILL_CHARS) throw new Error(`it is over ${MAX_SKILL_CHARS} characters`)
    const { data, body } = parseSkillFile(text)
    if (!body.trim()) throw new Error('it has no instructions')
    const name = uniqueName(importName(candidate.file, text), (n) => nameTaken(n, undefined))
    const description = (
      stringField(data, 'description') ??
      firstParagraph(body) ??
      `Instructions imported from ${basename(candidate.file)}`
    ).slice(0, MAX_SKILL_DESCRIPTION)
    const dir = newFolder(name, undefined)
    if (candidate.kind === 'folder') {
      // Bring the skill's resource files along, but not VCS or dependency folders.
      cpSync(candidate.dir, dir, {
        recursive: true,
        filter: (src) => !relative(candidate.dir, src).split(/[\\/]/).some((part) => part === '.git' || part === 'node_modules')
      })
    }
    return writeSkill(dir, undefined, { name, description, body })
  }

  scan()

  return {
    list(botId) {
      const skills = botId ? forBot(botId) : sortSkills([...index.values()])
      return skills.map(publicSkill)
    },

    get,

    findForBot(botId, name) {
      const wanted = name.trim().toLowerCase()
      const match = forBot(botId).find((s) => s.name.toLowerCase() === wanted)
      return match ? get(match.id) : undefined
    },

    save(input) {
      const name = slugifySkillName(input.name)
      if (!name || !SKILL_NAME_PATTERN.test(name)) throw new Error('Skill names use lowercase letters, digits and dashes')
      const content = checkContent(input)

      if (input.id) {
        const current = index.get(input.id)
        if (!current) throw new Error('Skill not found')
        if (current.readOnly) throw new Error('This skill is read-only; import it into the library to edit a copy')
        if (nameTaken(name, current.ownerBotId, current.id)) throw new Error(`A skill named "${name}" already exists`)
        const skill = writeSkill(current.dir, current.ownerBotId, { name, ...content })
        changed()
        return publicSkill(skill)
      }

      const owner = input.ownerBotId
      if (owner) {
        if (!deps.store.bots.get(owner)) throw new Error('Bot not found')
        const own = [...index.values()].filter((s) => s.ownerBotId === owner).length
        if (own >= MAX_SKILLS_PER_BOT) throw new Error(`A bot can have at most ${MAX_SKILLS_PER_BOT} skills`)
      }
      if (nameTaken(name, owner)) throw new Error(`A skill named "${name}" already exists`)
      const skill = writeSkill(newFolder(name, owner), owner, { name, ...content })
      changed()
      return publicSkill(skill)
    },

    delete(id) {
      const skill = index.get(id)
      if (!skill) return
      if (skill.readOnly) throw new Error(`This skill is read-only; remove it from ${skill.dir} instead`)
      removeDir(skill.dir)
      index.delete(id)
      unassign(new Set([id]))
      changed()
    },

    importFiles(paths, assignToBotId) {
      const imported: IndexedSkill[] = []
      const problems: string[] = []
      for (const path of paths) {
        let candidates: Candidate[]
        try {
          candidates = collect(path)
        } catch (err) {
          problems.push(`${basename(path)}: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        if (candidates.length === 0) problems.push(`${basename(path)}: no SKILL.md, .md or .txt files found`)
        for (const candidate of candidates) {
          try {
            imported.push(importOne(candidate))
          } catch (err) {
            problems.push(`${basename(candidate.file)}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      if (imported.length === 0 && problems.length > 0) throw new Error(`Nothing imported. ${problems.join('; ')}`)
      if (problems.length > 0) console.warn('[skills] some files were skipped:', problems.join('; '))
      if (assignToBotId && imported.length > 0) assign(assignToBotId, imported.map((s) => s.id))
      if (imported.length > 0) changed()
      return imported.map(publicSkill)
    },

    rescan() {
      scan()
      changed()
      return sortSkills([...index.values()]).map(publicSkill)
    },

    promptBlock(botId) {
      const skills = forBot(botId).filter((s) => !s.hidden)
      if (skills.length === 0) {
        return '## Skills\nYou have no skills yet. When you work out a repeatable way of doing something, save it with update_skill.'
      }
      const lines = [
        '## Skills',
        'Skills are saved ways of working. When a task matches one, load it with the `skill` tool and follow it.'
      ]
      let size = lines.join('\n').length
      for (const [i, skill] of skills.entries()) {
        const description = skill.description.replace(/\s+/g, ' ')
        const short = description.length > PROMPT_DESCRIPTION_CHARS
          ? `${description.slice(0, PROMPT_DESCRIPTION_CHARS - 1)}…`
          : description
        const line = `- ${skill.name}: ${short || '(no description)'}`
        if (size + line.length + 1 > PROMPT_BLOCK_CHARS) {
          lines.push(`- …and ${skills.length - i} more: ${skills.slice(i).map((s) => s.name).join(', ')}`.slice(0, 2000))
          break
        }
        lines.push(line)
        size += line.length + 1
      }
      return lines.join('\n')
    },

    deleteOwnedBy(botId) {
      const owned = [...index.values()].filter((s) => s.ownerBotId === botId)
      const dir = join(botSkillsDir, botId)
      if (existsSync(dir)) removeDir(dir)
      for (const skill of owned) index.delete(skill.id)
      if (owned.length > 0) {
        unassign(new Set(owned.map((s) => s.id)))
        changed()
      }
    },

    dirsForBot: (botId) => forBot(botId).map((s) => s.dir)
  }
}
