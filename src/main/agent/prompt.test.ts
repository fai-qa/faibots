import { describe, expect, it } from 'vitest'
import { DEFAULT_GROUP_SETTINGS, type Bot, type Conversation } from '@shared/domain'
import { buildSystemPrompt, promptText, turnNote, type PromptInput } from './prompt'

const bot = (over: Partial<Bot>): Bot => ({
  id: 'b1',
  name: 'Researcher',
  handle: 'researcher',
  label: 'Research, sources',
  description: 'Finds and checks sources.',
  soul: 'You are curious and precise. You cite everything.',
  avatar: { shape: 'blob', color: 'blue' },
  dailyRunLimit: 0,
  model: { providerId: 'p', modelId: '' },
  isPrimary: false,
  toolPermissions: {},
  mcpServerIds: 'all',
  skillIds: [],
  notify: true,
  pinned: false,
  hidden: false,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

const conversation = (over: Partial<Conversation>): Conversation => ({
  id: 'c1',
  kind: 'dm',
  title: 'Researcher',
  botIds: ['b1'],
  notes: '',
  lastEntryAt: 0,
  unreadCount: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over
})

const base = (over: Partial<PromptInput> = {}): PromptInput => ({
  bot: bot({}),
  conversation: conversation({}),
  others: [],
  userName: 'Alex',
  memoryBlock: '## Your memory\n- Alex prefers short answers',
  skillsBlock: '## Skills\n- weekly-report: Use when writing the weekly report',
  mcpInstructions: '',
  workspaceDir: 'C:\\Users\\sample\\FaiBots\\workspaces\\researcher',
  now: new Date('2026-10-18T12:00:00Z'),
  platform: 'win32',
  engine: 'native',
  ...over
})

describe('buildSystemPrompt', () => {
  it('puts identity, soul, situation and skills in the stable part; memory and date in the volatile part', () => {
    const prompt = buildSystemPrompt(base())
    expect(prompt.stable).toContain('You are Researcher (@researcher), Research, sources.')
    expect(prompt.stable).toContain('You are curious and precise.')
    expect(prompt.stable).toContain('A private chat between you and Alex.')
    expect(prompt.stable).toContain('weekly-report')
    expect(prompt.stable).not.toContain('prefers short answers')
    expect(prompt.stable).not.toContain('2026')
    expect(prompt.volatile).toContain('prefers short answers')
    expect(prompt.volatile).toContain('Sunday, October 18, 2026')
    expect(prompt.volatile).toContain('Windows (shell commands run in Windows PowerShell)')
    expect(prompt.volatile).toContain('C:\\Users\\sample\\FaiBots\\workspaces\\researcher')
    expect(promptText(prompt)).toBe(`${prompt.stable}\n\n${prompt.volatile}`)
  })

  it('includes the description when the soul is empty', () => {
    expect(buildSystemPrompt(base({ bot: bot({ soul: '' }) })).stable).toContain('Finds and checks sources.')
  })

  it('gives the selected specialist its advertised responsibilities alongside its persona in an exchange', () => {
    const specialist = bot({ description: 'Compare delivery dates and return a ranked shortlist.', soul: 'Use short sentences.' })
    const prompt = buildSystemPrompt(base({ bot: specialist, conversation: conversation({ kind: 'exchange' }) }))
    expect(prompt.stable).toContain(specialist.description)
    expect(prompt.stable).toContain(specialist.soul)
  })

  it('states a responsibility once when both profile fields contain the same text', () => {
    const specialist = bot({ description: 'Check the sources.', soul: ' Check the sources. ' })
    expect(buildSystemPrompt(base({ bot: specialist })).stable.split('Check the sources.')).toHaveLength(2)
  })

  it('describes a group with its members, notes and the passing rule', () => {
    const writer = bot({ id: 'b2', name: 'Writer', handle: 'writer', label: '', description: 'Writes copy' })
    const prompt = buildSystemPrompt(
      base({
        conversation: conversation({ kind: 'group', title: 'Launch', botIds: ['b1', 'b2'], group: DEFAULT_GROUP_SETTINGS, notes: 'Launch is May 3.' }),
        others: [writer]
      })
    )
    expect(prompt.stable).toContain('The group chat "Launch". Members:')
    expect(prompt.stable).toContain('- Alex (the person you all work for)')
    expect(prompt.stable).toContain('- Researcher (@researcher), Research, sources: Finds and checks sources. (you)')
    expect(prompt.stable).toContain('- Writer (@writer): Writes copy')
    expect(prompt.stable).toContain('call pass_turn')
    expect(prompt.stable).toContain('## Group notes\nLaunch is May 3.')
  })

  it('describes an exchange from the point of view of the bot that was asked', () => {
    const writer = bot({ id: 'b2', name: 'Writer', handle: 'writer' })
    const prompt = buildSystemPrompt(base({ conversation: conversation({ kind: 'exchange', botIds: ['b2', 'b1'] }), others: [writer], asker: writer }))
    expect(prompt.stable).toContain("A side conversation with Writer (@writer), another of Alex's bots, who asked you for help.")
  })

  it('gives the primary bot coordinator instructions', () => {
    expect(buildSystemPrompt(base({ bot: bot({ isPrimary: true }) })).stable).toContain("You coordinate Alex's other bots")
    expect(buildSystemPrompt(base()).stable).not.toContain('You coordinate')
  })

  it('tells external engines where FaiBots tools come from, and adds connector instructions', () => {
    const prompt = buildSystemPrompt(base({ engine: 'claude-code', mcpInstructions: '## Connector: github\nUse it for issues.' }))
    expect(prompt.stable).toContain('come from the "faibots" connector')
    expect(prompt.stable).toContain('# Connectors\n## Connector: github')
  })

  it('lists selected sources with their hashes when manifest-lite sources are given (FJ-09)', () => {
    const prompt = buildSystemPrompt(base({
      manifestLite: { sources: [
        { path: 'notes/brief.md', sha256: 'a'.repeat(64) },
        { path: 'notes/audience.txt', name: 'Audience notes' }
      ] }
    }))
    expect(prompt.volatile).toContain('# Selected sources')
    expect(prompt.volatile).toContain('- notes/brief.md [sha256: ' + 'a'.repeat(64) + ']')
    expect(prompt.volatile).toContain('- Audience notes (notes/audience.txt)')
    // The block is per-turn evidence, so it stays out of the cached stable part.
    expect(prompt.stable).not.toContain('Selected sources')
  })

  it('omits the selected sources block when none were given', () => {
    expect(buildSystemPrompt(base()).volatile).not.toContain('Selected sources')
    expect(buildSystemPrompt(base({ manifestLite: { sources: [] } })).volatile).not.toContain('Selected sources')
  })
})

describe('turnNote', () => {
  it('is empty outside groups', () => {
    expect(turnNote({ inGroup: false, mustAnswer: true, isWindingDown: false })).toBe('')
  })
  it('tells addressed bots to answer and the others that they may pass', () => {
    expect(turnNote({ inGroup: true, mustAnswer: true, isWindingDown: false })).toMatch(/addressed, so reply; do not pass/)
    expect(turnNote({ inGroup: true, mustAnswer: false, isWindingDown: false })).toMatch(/otherwise call pass_turn/)
  })
  it('marks the last round', () => {
    expect(turnNote({ inGroup: true, mustAnswer: false, isWindingDown: true })).toMatch(/last round.*only if it is essential/)
    expect(turnNote({ inGroup: true, mustAnswer: true, isWindingDown: true })).toMatch(/briefly: this is the last round/)
  })
})
