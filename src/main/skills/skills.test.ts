import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type PlatformStore } from '../store'
import { fakeBus } from '../store/test-helpers'
import { parseSkillFile, renderSkillFile } from './frontmatter'
import { importName, slugifySkillName, uniqueName } from './naming'
import { createSkillService, type PlatformSkillService } from './skills'

describe('frontmatter', () => {
  it('parses name, description and body', () => {
    const parsed = parseSkillFile('---\nname: pdf\ndescription: Use when reading PDFs\n---\n\n# PDF\nSteps')
    expect(parsed.data).toEqual({ name: 'pdf', description: 'Use when reading PDFs' })
    expect(parsed.body).toBe('# PDF\nSteps')
  })

  it('handles files without frontmatter, BOM and CRLF', () => {
    expect(parseSkillFile('# Just text').data).toEqual({})
    const crlf = parseSkillFile('\uFEFF---\r\nname: x\r\ndescription: y\r\n---\r\nbody')
    expect(crlf.data).toEqual({ name: 'x', description: 'y' })
    expect(crlf.body).toBe('body')
  })

  it('round-trips unknown keys and comments when rewriting', () => {
    const original = [
      '---',
      '# kept comment',
      'name: old-name',
      'description: old',
      'argument-hint: "[file]"',
      'metadata:',
      '  version: 2',
      'disable-model-invocation: false',
      '---',
      '',
      'Old body'
    ].join('\n')
    const rewritten = renderSkillFile({ name: 'new-name', description: 'Use when: testing', body: 'New body', previous: original })
    const parsed = parseSkillFile(rewritten)
    expect(parsed.data).toEqual({
      name: 'new-name',
      description: 'Use when: testing',
      'argument-hint': '[file]',
      metadata: { version: 2 },
      'disable-model-invocation': false
    })
    expect(rewritten).toContain('# kept comment')
    expect(parsed.body).toBe('New body\n')
  })
})

describe('naming', () => {
  it('slugifies', () => {
    expect(slugifySkillName('Weekly Report (v2)')).toBe('weekly-report-v2')
    expect(slugifySkillName('Café — notes')).toBe('cafe-notes')
    expect(slugifySkillName('!!!')).toBe('')
  })

  it('picks import names: frontmatter, folder, H1, file name', () => {
    expect(importName('/x/a.md', '---\nname: From Front\ndescription: d\n---\n# Heading')).toBe('from-front')
    expect(importName('/x/My Folder/SKILL.md', '# Heading')).toBe('my-folder')
    expect(importName('C:\\x\\My Folder\\SKILL.md', 'body')).toBe('my-folder')
    expect(importName('/x/notes.md', 'intro\n\n# Weekly Review\nbody')).toBe('weekly-review')
    expect(importName('/x/release-checklist.txt', 'no heading here')).toBe('release-checklist')
  })

  it('suffixes clashes', () => {
    const taken = new Set(['a', 'a-2'])
    expect(uniqueName('a', (n) => taken.has(n))).toBe('a-3')
    expect(uniqueName('b', (n) => taken.has(n))).toBe('b')
  })
})

describe('SkillService', () => {
  let dir: string
  let home: string
  let dataDir: string
  let store: PlatformStore
  let bus: ReturnType<typeof fakeBus>
  let skills: PlatformSkillService

  const writeExternal = (root: string, name: string, frontmatter: string, body = 'Do the thing') => {
    const folder = join(home, root, 'skills', name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
    return folder
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'faibots-skills-'))
    home = join(dir, 'home')
    dataDir = join(dir, 'data')
    mkdirSync(home, { recursive: true })
    store = openStore(':memory:', { homeDir: home })
    bus = fakeBus()
    writeExternal('.claude', 'pdf', 'name: pdf\ndescription: Use when working with PDFs')
    writeExternal('.codex', 'pdf', 'name: pdf\ndescription: Codex PDF skill')
    writeExternal('.agents', 'hidden-one', 'name: hidden-one\ndescription: secret\ndisable-model-invocation: true')
    skills = createSkillService({ dataDir, homeDir: home, store, bus })
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('finds external skills read-only at startup, with stable ids', () => {
    const external = skills.list().filter((s) => s.source === 'external')
    expect(external.map((s) => s.name).sort()).toEqual(['hidden-one', 'pdf', 'pdf'])
    expect(external.every((s) => s.readOnly)).toBe(true)
    const again = createSkillService({ dataDir, homeDir: home, store, bus })
    expect(again.list().map((s) => s.id).sort()).toEqual(skills.list().map((s) => s.id).sort())
    expect(() => skills.save({ id: external[0]!.id, name: 'pdf', description: 'x', body: 'y' })).toThrow(/read-only/)
    expect(() => skills.delete(external[0]!.id)).toThrow(/read-only/)
  })

  it('creates, renames and deletes library skills; rename keeps the id and folder', () => {
    const created = skills.save({ name: 'Weekly Report', description: 'Use when writing the weekly report', body: '1. Gather\n2. Write' })
    expect(created.name).toBe('weekly-report')
    expect(created.source).toBe('library')
    expect(existsSync(join(dataDir, 'skills', 'weekly-report', 'SKILL.md'))).toBe(true)
    expect(() => skills.save({ name: 'weekly-report', description: 'd', body: 'b' })).toThrow(/already exists/)

    const renamed = skills.save({ id: created.id, name: 'status-report', description: 'Use when reporting status', body: 'New steps' })
    expect(renamed.id).toBe(created.id)
    expect(renamed.dir).toBe(created.dir)
    const full = skills.get(created.id)
    expect(full).toMatchObject({ name: 'status-report', description: 'Use when reporting status' })
    expect(full.body.trim()).toBe('New steps')
    expect(bus.of('skills:changed').length).toBeGreaterThanOrEqual(2)

    const bot = store.bots.create({ name: 'Writer', skillIds: [created.id] })
    skills.delete(created.id)
    expect(existsSync(created.dir)).toBe(false)
    expect(store.bots.get(bot.id)!.skillIds).toEqual([])
  })

  it('validates content and limits', () => {
    expect(() => skills.save({ name: 'x', description: '', body: 'b' })).toThrow(/Use when/)
    expect(() => skills.save({ name: 'x', description: 'd', body: '  ' })).toThrow(/instructions/)
    expect(() => skills.save({ name: '!!!', description: 'd', body: 'b' })).toThrow(/names/)
    expect(() => skills.save({ name: 'big', description: 'd', body: 'x'.repeat(256_001) })).toThrow(/at most/)
  })

  it('shows a bot its assigned skills plus its own private ones, never another bot\'s', () => {
    const a = store.bots.create({ name: 'A' })
    const b = store.bots.create({ name: 'B' })
    const lib = skills.save({ name: 'shared', description: 'Use when sharing', body: 'b' })
    const pdf = skills.list().find((s) => s.name === 'pdf' && s.dir.includes('.claude'))!
    store.bots.update(a.id, { skillIds: [lib.id, pdf.id] })
    const privateA = skills.save({ name: 'notes', description: 'Use when taking notes', body: 'mine', ownerBotId: a.id })
    const privateB = skills.save({ name: 'notes', description: 'B notes', body: 'theirs', ownerBotId: b.id })
    expect(privateA.source).toBe('bot')
    expect(privateB.id).not.toBe(privateA.id)

    expect(skills.list(a.id).map((s) => s.name)).toEqual(['notes', 'shared', 'pdf'])
    expect(skills.list(b.id).map((s) => s.id)).toEqual([privateB.id])
    expect(skills.findForBot(a.id, 'NOTES')?.body.trim()).toBe('mine')
    expect(skills.findForBot(b.id, 'notes')?.body.trim()).toBe('theirs')
    expect(skills.findForBot(b.id, 'shared')).toBeUndefined()
    expect(skills.dirsForBot(a.id)).toContain(lib.dir)
  })

  it('promptBlock lists name and description and skips disable-model-invocation', () => {
    const bot = store.bots.create({ name: 'A' })
    expect(skills.promptBlock(bot.id)).toContain('no skills yet')
    const hidden = skills.list().find((s) => s.name === 'hidden-one')!
    const lib = skills.save({ name: 'deploy', description: 'Use when deploying', body: 'b' })
    store.bots.update(bot.id, { skillIds: [lib.id, hidden.id] })
    const block = skills.promptBlock(bot.id)
    expect(block).toContain('- deploy: Use when deploying')
    expect(block).toContain('`skill` tool')
    expect(block).not.toContain('hidden-one')
    expect(skills.findForBot(bot.id, 'hidden-one')).toBeDefined()
  })

  it('imports SKILL.md folders with resources, loose files and folders of files', () => {
    const src = join(dir, 'src')
    mkdirSync(join(src, 'Report Kit', 'templates'), { recursive: true })
    writeFileSync(join(src, 'Report Kit', 'SKILL.md'), '---\ndescription: Use when building reports\nversion: 3\n---\nUse templates/a.md')
    writeFileSync(join(src, 'Report Kit', 'templates', 'a.md'), 'template')
    mkdirSync(join(src, 'Report Kit', '.git'), { recursive: true })
    writeFileSync(join(src, 'Report Kit', '.git', 'HEAD'), 'ref')
    writeFileSync(join(src, 'triage.md'), '# Bug Triage\n\nSort incoming bugs by impact.\n\n1. Read')
    mkdirSync(join(src, 'bundle'), { recursive: true })
    writeFileSync(join(src, 'bundle', 'one.txt'), 'First instructions')
    writeFileSync(join(src, 'bundle', 'empty.md'), '   ')
    writeFileSync(join(src, 'bundle', 'image.png'), 'not text')

    const bot = store.bots.create({ name: 'A' })
    const imported = skills.importFiles(
      [join(src, 'Report Kit', 'SKILL.md'), join(src, 'triage.md'), join(src, 'bundle')],
      bot.id
    )
    expect(imported.map((s) => s.name)).toEqual(['report-kit', 'bug-triage', 'one'])

    const kit = skills.get(imported[0]!.id)
    expect(kit.description).toBe('Use when building reports')
    expect(kit.resources).toEqual(['templates/a.md'])
    expect(existsSync(join(kit.dir, '.git'))).toBe(false)
    expect(parseSkillFile(readFileSync(join(kit.dir, 'SKILL.md'), 'utf8')).data).toMatchObject({ name: 'report-kit', version: 3 })

    expect(skills.get(imported[1]!.id).description).toBe('Sort incoming bugs by impact.')
    expect(store.bots.get(bot.id)!.skillIds).toEqual(imported.map((s) => s.id))

    // Importing the same file again does not overwrite: it gets a suffix.
    const again = skills.importFiles([join(src, 'triage.md')])
    expect(again[0]!.name).toBe('bug-triage-2')

    expect(() => skills.importFiles([join(src, 'bundle', 'empty.md')])).toThrow(/Nothing imported/)
  })

  it('deleteOwnedBy removes a bot\'s private skills and their assignments', () => {
    const a = store.bots.create({ name: 'A' })
    const b = store.bots.create({ name: 'B' })
    const owned = skills.save({ name: 'mine', description: 'd', body: 'b', ownerBotId: a.id })
    store.bots.update(b.id, { skillIds: [owned.id] })
    skills.deleteOwnedBy(a.id)
    expect(existsSync(owned.dir)).toBe(false)
    expect(skills.list().some((s) => s.id === owned.id)).toBe(false)
    expect(store.bots.get(b.id)!.skillIds).toEqual([])
  })

  it('rescan picks up folders added by hand', () => {
    mkdirSync(join(dataDir, 'skills', 'manual'), { recursive: true })
    writeFileSync(join(dataDir, 'skills', 'manual', 'SKILL.md'), '---\nname: manual\ndescription: hand made\n---\nbody')
    expect(skills.list().some((s) => s.name === 'manual')).toBe(false)
    expect(skills.rescan().some((s) => s.name === 'manual' && s.source === 'library')).toBe(true)
  })
})
