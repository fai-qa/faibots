// In-memory fake of the whole FaiBots bridge, used when the app runs in a plain browser
// (no Electron preload). It behaves like the real backend closely enough to click through
// every screen: bots stream replies with conv:delta, groups run rounds where some bots pass,
// a bot asks another bot for help in an exchange, and risky tools wait for approval cards.

import {
  DEFAULT_GROUP_SETTINGS,
  MAX_GROUP_BOTS,
  AVATAR_SHAPES,
  BOT_COLORS,
  type ApprovalDecision,
  type Artifact,
  type ArtifactRevision,
  type Bot,
  type BotPhase,
  type BotRecipe,
  type Conversation,
  type Entry,
  type Id,
  type JourneyRun,
  type McpServerConfig,
  type MemoryFact,
  type ModelInfo,
  type NoteKind,
  type PermissionMode,
  type Project,
  type ProjectSource,
  type ReviewDecision,
  type Routine,
  type RoutineRun,
  type Skill,
  type SkillWithBody,
  type ToolCallInfo
} from '@shared/domain'
import { nextRunAfter, normalizeSchedule } from '@shared/routines'
import type {
  EventChannel,
  EventMap,
  FaiBotsBridge,
  InvokeChannel,
  InvokeMap,
  ProviderTestResult
} from '@shared/ipc'
import { DATA_DIR, seedMockData, type MockDb } from './mock-seed'

type Handlers = { [C in InvokeChannel]: (req: InvokeMap[C]['req']) => InvokeMap[C]['res'] | Promise<InvokeMap[C]['res']> }

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/
const RESERVED_SECRETS = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'COMSPEC', 'TEMP', 'TMP']

class Stopped extends Error {}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped())
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new Stopped())
      },
      { once: true }
    )
  })
}

const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    csv: 'text/csv',
    md: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json'
  }
  return map[ext] ?? 'application/octet-stream'
}

export function createMockBridge(): FaiBotsBridge {
  const db: MockDb = seedMockData()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const turns = new Map<Id, AbortController>()
  const approvals = new Map<Id, { entryIds: Id[]; resolve: (d: ApprovalDecision) => void }>()

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  function emit<C extends EventChannel>(channel: C, payload: EventMap[C]): void {
    const set = listeners.get(channel)
    if (!set) return
    for (const listener of [...set]) listener(clone(payload))
  }

  const now = () => Date.now()
  const getBot = (id: Id | undefined) => db.bots.find((b) => b.id === id)
  const getConv = (id: Id | undefined) => db.conversations.find((c) => c.id === id)
  const emitBots = () => emit('bots:changed', { bots: db.bots })
  const emitConv = (c: Conversation) => emit('conv:changed', { conversation: c })

  function mustBot(id: Id): Bot {
    const b = getBot(id)
    if (!b) throw new Error('Bot not found')
    return b
  }
  function mustConv(id: Id): Conversation {
    const c = getConv(id)
    if (!c) throw new Error('Conversation not found')
    return c
  }

  function append(conversationId: Id, p: Partial<Entry> & Pick<Entry, 'kind' | 'author'>): Entry {
    const c = mustConv(conversationId)
    const seq = db.entries.filter((e) => e.conversationId === conversationId).reduce((m, e) => Math.max(m, e.seq), 0) + 1
    const at = now()
    const entry: Entry = {
      id: uid('e'),
      conversationId,
      seq,
      text: '',
      mentions: [],
      mentionsEveryone: false,
      attachments: [],
      isStreaming: false,
      createdAt: at,
      updatedAt: at,
      ...p
    }
    db.entries.push(entry)
    c.lastEntryAt = at
    c.updatedAt = at
    if (entry.author.kind === 'bot' && (entry.kind === 'message' || entry.kind === 'approval')) c.unreadCount += 1
    emit('conv:entry', { entry })
    emitConv(c)
    return entry
  }

  function updateEntry(entry: Entry, patch: Partial<Entry>): void {
    Object.assign(entry, patch, { updatedAt: now() })
    emit('conv:entry', { entry })
  }

  function updateTool(entry: Entry, patch: Partial<ToolCallInfo>): void {
    if (!entry.toolCall) return
    updateEntry(entry, { toolCall: { ...entry.toolCall, ...patch } })
  }

  function setLive(botId: Id, conversationId: Id, phase: BotPhase, activity?: string): void {
    const key = `${conversationId}:${botId}`
    const state = { botId, conversationId, phase, activity, updatedAt: now() }
    if (phase === 'idle') db.live.delete(key)
    else db.live.set(key, state)
    emit('bot:state', { state })
  }

  function signalFor(conversationId: Id): AbortSignal {
    let ctl = turns.get(conversationId)
    if (!ctl || ctl.signal.aborted) {
      ctl = new AbortController()
      turns.set(conversationId, ctl)
    }
    return ctl.signal
  }

  function permissionFor(bot: Bot, toolName: string): PermissionMode {
    const def = db.tools.find((t) => t.name === toolName)
    return bot.toolPermissions[toolName] ?? db.settings.toolPermissions[toolName] ?? def?.defaultPermission ?? 'ask'
  }

  function rootOf(c: Conversation): Conversation | undefined {
    let cur: Conversation | undefined = c
    for (let i = 0; cur?.kind === 'exchange' && cur.origin && i < 10; i++) cur = getConv(cur.origin.conversationId)
    return cur && cur.id !== c.id && cur.kind !== 'exchange' ? cur : undefined
  }

  // -------------------------------------------------------------------------
  // Fake bot behaviour
  // -------------------------------------------------------------------------

  function topicOf(text: string): string {
    const clean = text.replace(/@[\w.-]+/g, '').replace(/[?!.]+$/g, '').replace(/\s+/g, ' ').trim()
    const words = clean.split(' ').slice(0, 8).join(' ')
    return words || 'this'
  }

  function replyFor(bot: Bot, userText: string, where: 'dm' | 'group' | 'exchange'): string {
    const topic = topicOf(userText)
    const style = bot.handle
    if (where === 'group') {
      const lines: Record<string, string> = {
        fai: `From my side, **${topic}** needs one owner and a date. I'll track it on the launch checklist.`,
        iris: `I can dig into **${topic}** and bring back a short comparison by tonight.`,
        juno: `I'll draft the wording for **${topic}** once we agree on the plan.`,
        rex: `I'll review anything about **${topic}** that touches code before it ships.`,
        pixel: `Happy to sketch **${topic}** once the plan settles.`
      }
      return lines[style] ?? `I can help with **${topic}**. Tell me which part to take.`
    }
    if (where === 'exchange') {
      return style === 'iris'
        ? `Short version on **${topic}**:\n\n- Start with the smallest version that is useful.\n- Test it with real use for a week.\n- Then decide whether to widen it.\n\nConfidence: medium. Happy to go deeper on any of these.`
        : `My take on **${topic}**: keep it small, test it with real use, then decide. Shout if you need more.`
    }
    switch (style) {
      case 'fai':
        return `Here's how I'd handle **${topic}**:\n\n1. Pin down what "done" looks like, and by when.\n2. Split it into small pieces and hand the research to @iris.\n3. Check in with you before anything goes out.\n\nWant me to start on step 1?`
      case 'iris':
        return `Here's what I found on **${topic}**:\n\n| Option | Effort | Why it matters |\n|---|---|---|\n| Start small | Low | Quick to test with real users |\n| Go broad | High | Covers more cases, slower to ship |\n\nSources are in my notes. I can send the links if you want them.`
      case 'juno':
        return `A first line you could use:\n\n> ${topic.charAt(0).toUpperCase()}${topic.slice(1)}, done properly: local, private and yours.\n\nI can make it shorter, warmer or more technical. Which way?`
      case 'rex':
        return "Looks reasonable. One thing I'd check before merging:\n\n```ts\n// Guard against a missing bot before reading its model\nconst route = bot?.model ?? settings.defaultModel\nif (!route) throw new Error('Pick a model for this bot first')\n```\n\nEverything else reads fine to me."
      case 'pixel':
        return `Two directions for **${topic}**:\n\n- **Quiet**: neutral greys, one accent, lots of space.\n- **Bold**: big type and strong colour blocks.\n\nI'd start quiet and add colour only where it helps people find things.`
      default:
        return `Got it. About **${topic}**: I'll keep it short. What's the one thing you want from me first?`
    }
  }

  async function stream(conversationId: Id, botId: Id, text: string, signal: AbortSignal, extra: Partial<Entry> = {}): Promise<Entry> {
    setLive(botId, conversationId, 'typing', 'Writing a reply')
    const bot = getBot(botId)
    const entry = append(conversationId, {
      kind: 'message',
      author: { kind: 'bot', botId },
      isStreaming: true,
      meta: { providerId: bot?.model.providerId, modelId: bot?.model.modelId },
      ...extra
    })
    const tokens = text.match(/\S+\s*|\s+/g) ?? [text]
    try {
      for (let i = 0; i < tokens.length; i += 2) {
        await sleep(28 + Math.random() * 50, signal)
        const textDelta = tokens.slice(i, i + 2).join('')
        entry.text += textDelta
        emit('conv:delta', { conversationId, entryId: entry.id, textDelta })
      }
    } finally {
      updateEntry(entry, { isStreaming: false, text: entry.text || '_Stopped before replying._' })
    }
    return entry
  }

  async function askApproval(c: Conversation, bot: Bot, toolName: string, summary: string, input: unknown, signal: AbortSignal): Promise<ApprovalDecision> {
    const mode = permissionFor(bot, toolName)
    if (mode === 'always') return 'allow_once'
    if (mode === 'never') return 'deny'
    const approvalId = uid('ap')
    const root = rootOf(c)
    const cards = [c, ...(root ? [root] : [])].map((target) =>
      append(target.id, {
        kind: 'approval',
        author: { kind: 'bot', botId: bot.id },
        text: summary,
        approval: { approvalId, toolName, summary, input, status: 'pending' }
      })
    )
    setLive(bot.id, c.id, 'waiting', 'Needs your input')
    let aborted = false
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      approvals.set(approvalId, { entryIds: cards.map((e) => e.id), resolve })
      signal.addEventListener(
        'abort',
        () => {
          aborted = true
          resolve('deny')
        },
        { once: true }
      )
    })
    approvals.delete(approvalId)
    for (const card of cards) {
      updateEntry(card, { approval: { ...card.approval!, ...(aborted ? { status: 'expired' } : { status: 'resolved', decision }) } })
    }
    if (!aborted && (decision === 'always' || decision === 'never')) {
      bot.toolPermissions = { ...bot.toolPermissions, [toolName]: decision === 'always' ? 'always' : 'never' }
      emitBots()
    }
    if (aborted) throw new Stopped()
    return decision
  }

  async function shellFlow(c: Conversation, bot: Bot, command: string, signal: AbortSignal): Promise<void> {
    const cwd = `${db.settings.workspaceRoot}\\${bot.handle}`
    const call = append(c.id, {
      kind: 'tool-call',
      author: { kind: 'bot', botId: bot.id },
      toolCall: { callId: uid('call'), toolName: 'shell', title: 'Running a command', input: { command, cwd }, status: 'running' }
    })
    setLive(bot.id, c.id, 'tool', 'Running a few commands')
    let decision: ApprovalDecision
    try {
      decision = await askApproval(c, bot, 'shell', `Run \`${command}\` in \`${cwd}\``, { command, cwd }, signal)
    } catch (err) {
      updateTool(call, { status: 'cancelled' })
      throw err
    }
    if (decision === 'deny' || decision === 'never') {
      updateTool(call, { status: 'denied', resultText: 'You denied this command.' })
      setLive(bot.id, c.id, 'thinking')
      await sleep(500, signal)
      await stream(c.id, bot.id, `Okay, I won't run \`${command}\`. Tell me if you'd like me to try something else.`, signal)
      return
    }
    setLive(bot.id, c.id, 'tool', 'Waiting on results')
    await sleep(1400, signal)
    updateTool(call, {
      status: 'done',
      resultText: 'Example test output\n\n Test Files  12 passed (12)\n      Tests  48 passed (48)\n\nexit code 0'
    })
    setLive(bot.id, c.id, 'thinking')
    await sleep(600, signal)
    await stream(c.id, bot.id, 'All tests pass: **48 of 48** in 6.4 s. Nothing blocks the release from the test side. I ticked it off the checklist.', signal)
  }

  function findOrCreateExchange(a: Bot, b: Bot, origin: Conversation, entryId: Id): Conversation {
    let x = db.conversations.find(
      (c) => c.kind === 'exchange' && c.botIds.includes(a.id) && c.botIds.includes(b.id)
    )
    if (!x) {
      const at = now()
      x = {
        id: uid('x'),
        kind: 'exchange',
        title: `${a.name} and ${b.name}`,
        botIds: [a.id, b.id],
        origin: { conversationId: origin.id, entryId, fromBotId: a.id },
        notes: '',
        lastEntryAt: at,
        unreadCount: 0,
        createdAt: at,
        updatedAt: at
      }
      db.conversations.push(x)
      emitConv(x)
    }
    return x
  }

  async function exchangeFlow(c: Conversation, bot: Bot, userText: string, signal: AbortSignal): Promise<void> {
    const peer = db.bots.find((b) => b.id !== bot.id && b.handle === (bot.handle === 'iris' ? 'fai' : 'iris')) ??
      db.bots.find((b) => b.id !== bot.id && !b.hidden)
    if (!peer) {
      await stream(c.id, bot.id, replyFor(bot, userText, 'dm'), signal)
      return
    }
    const message = `${db.settings.userName || 'The user'} asked: "${topicOf(userText)}". Can you look into it and send me a short summary?`
    setLive(bot.id, c.id, 'tool', `Checking with ${peer.name}`)
    const call = append(c.id, {
      kind: 'tool-call',
      author: { kind: 'bot', botId: bot.id },
      toolCall: { callId: uid('call'), toolName: 'send_to_agent', title: `Messaging ${peer.name}`, input: { to: `@${peer.handle}`, message }, status: 'running' }
    })
    const x = findOrCreateExchange(bot, peer, c, call.id)
    updateTool(call, { exchangeConversationId: x.id })
    append(x.id, { kind: 'message', author: { kind: 'bot', botId: bot.id }, text: message })
    try {
      setLive(peer.id, x.id, 'reading')
      await sleep(700, signal)
      setLive(peer.id, x.id, 'thinking')
      await sleep(900, signal)
      const reply = await stream(x.id, peer.id, replyFor(peer, userText, 'exchange'), signal)
      updateTool(call, {
        status: 'done',
        title: `Messaged ${peer.name}`,
        resultText: reply.text.replace(/[*#>`]/g, '').replace(/\s+/g, ' ').slice(0, 220)
      })
    } catch (err) {
      updateTool(call, { status: 'cancelled' })
      throw err
    } finally {
      setLive(peer.id, x.id, 'idle')
    }
    setLive(bot.id, c.id, 'thinking')
    await sleep(600, signal)
    await stream(
      c.id,
      bot.id,
      `I checked with @${peer.handle}. In short: start with the smallest useful version, test it for a week, then decide whether to widen it. The full exchange is in the card above.`,
      signal,
      { mentions: [peer.id] }
    )
  }

  async function rememberFlow(c: Conversation, bot: Bot, userText: string): Promise<void> {
    const text = userText.replace(/^.*?\b(remember|note) (that )?/i, '').replace(/^\w/, (s) => s.toUpperCase())
    const at = now()
    const f: MemoryFact = { id: uid('f'), botId: bot.id, tier: 'log', text, pinned: false, createdBy: 'bot', source: { conversationId: c.id }, createdAt: at, updatedAt: at }
    db.facts.push(f)
    append(c.id, {
      kind: 'tool-call',
      author: { kind: 'bot', botId: bot.id },
      toolCall: { callId: uid('call'), toolName: 'update_memory', title: 'Saved to memory', input: { action: 'write', tier: 'log', content: text }, status: 'done', resultText: `Saved: ${text}` }
    })
    emit('memory:changed', { botId: bot.id })
  }

  async function dmTurn(c: Conversation, bot: Bot, userText: string, signal: AbortSignal): Promise<void> {
    try {
      setLive(bot.id, c.id, 'reading')
      await sleep(500, signal)
      setLive(bot.id, c.id, 'thinking')
      await sleep(800, signal)
      const t = userText.toLowerCase()
      if (/\b(remember|note that)\b/.test(t)) {
        await rememberFlow(c, bot, userText)
        await stream(c.id, bot.id, "Noted. I saved that to my memory, so I'll keep it in mind from now on.", signal)
        return
      }
      if (/\b(run|test|tests|build|install|command)\b/.test(t)) {
        const command = /\btest/.test(t) ? 'npm test' : /\bbuild\b/.test(t) ? 'npm run build' : 'Get-ChildItem'
        await shellFlow(c, bot, command, signal)
        return
      }
      if (/\b(ask|research|check with|find out|compare)\b/.test(t)) {
        await exchangeFlow(c, bot, userText, signal)
        return
      }
      if (/\b(file|files|folder|workspace)\b/.test(t)) {
        setLive(bot.id, c.id, 'tool', 'Reading the file')
        const call = append(c.id, {
          kind: 'tool-call',
          author: { kind: 'bot', botId: bot.id },
          toolCall: { callId: uid('call'), toolName: 'list_dir', title: 'Looking in a folder', input: { path: '.' }, status: 'running' }
        })
        await sleep(700, signal)
        updateTool(call, { status: 'done', title: 'Looked in a folder', resultText: 'notes.md\nlaunch-checklist.md\ndrafts/' })
      }
      await stream(c.id, bot.id, replyFor(bot, userText, 'dm'), signal)
    } finally {
      setLive(bot.id, c.id, 'idle')
    }
  }

  async function groupTurns(c: Conversation, userEntry: Entry, signal: AbortSignal): Promise<void> {
    const s = c.group ?? DEFAULT_GROUP_SETTINGS
    const members = c.botIds.map(getBot).filter((b): b is Bot => !!b)
    const addressed = userEntry.mentionsEveryone ? members : members.filter((m) => userEntry.mentions.includes(m.id))
    let budget = s.maxBotPosts
    let round1: { bot: Bot; must: boolean }[]
    if (addressed.length) round1 = addressed.map((bot) => ({ bot, must: true }))
    else if (s.turnPolicy === 'mentions') {
      const first = members.find((m) => m.isPrimary) ?? members[0]
      round1 = first ? [{ bot: first, must: true }] : []
    } else round1 = members.map((bot) => ({ bot, must: false }))

    const turn = async ({ bot, must }: { bot: Bot; must: boolean }, index: number): Promise<{ bot: Bot; entry: Entry } | null> => {
      try {
        setLive(bot.id, c.id, 'reading')
        await sleep(450 + index * 300, signal)
        setLive(bot.id, c.id, 'thinking')
        await sleep(700 + Math.random() * 600, signal)
        // In an open room the first two members answer and the rest pass (passing is the default).
        if ((!must && index >= 2) || budget <= 0) {
          append(c.id, { kind: 'event', author: { kind: 'bot', botId: bot.id }, text: `${bot.name} passed` })
          return null
        }
        budget -= 1
        const entry = await stream(c.id, bot.id, replyFor(bot, userEntry.text, 'group'), signal)
        return { bot, entry }
      } finally {
        setLive(bot.id, c.id, 'idle')
      }
    }

    const results: ({ bot: Bot; entry: Entry } | null)[] = []
    if (s.parallel) results.push(...(await Promise.all(round1.map(turn))))
    else for (const [i, item] of round1.entries()) results.push(await turn(item, i))

    const posts = results.filter((r): r is { bot: Bot; entry: Entry } => !!r)
    const [first, second] = posts
    if (s.allowBotToBot && s.maxRounds >= 2 && first && second && budget > 0) {
      try {
        setLive(first.bot.id, c.id, 'reading', `Reading ${second.bot.name}'s reply`)
        await sleep(1000, signal)
        setLive(first.bot.id, c.id, 'thinking')
        await sleep(700, signal)
        await stream(
          c.id,
          first.bot.id,
          `@${second.bot.handle} sounds good. Send it my way when it's ready and I'll add it to the checklist.`,
          signal,
          { mentions: [second.bot.id] }
        )
      } finally {
        setLive(first.bot.id, c.id, 'idle')
      }
    }
  }

  function runInBackground(conversationId: Id, work: Promise<void>): void {
    work.catch((err) => {
      if (err instanceof Stopped) return
      append(conversationId, { kind: 'event', author: { kind: 'system' }, text: `Something went wrong: ${String(err)}` })
    })
  }

  // The seeded fai dm ends with "Run the test suite": continue that turn so an approval
  // card is waiting when the app opens. Entries are appended synchronously, before any fetch.
  {
    const fai = getBot('b-atlas')
    const dm = getConv('c-atlas')
    if (fai && dm) {
      runInBackground(dm.id, shellFlow(dm, fai, 'npm test', signalFor(dm.id)).finally(() => setLive(fai.id, dm.id, 'idle')))
      dm.unreadCount = 0
    }
  }

  // -------------------------------------------------------------------------
  // Journey preview state (M1b/M1c): projects, note sources, artifact revisions
  // and mission runs. The run below is a preview simulation, clearly sample data.
  // -------------------------------------------------------------------------

  const journeyProjects: Project[] = []
  const journeySources: ProjectSource[] = []
  const journeyArtifacts: { artifact: Artifact; revisions: (ArtifactRevision & { reviews: ReviewDecision[] })[]; content?: string }[] = []
  const journeyRuns: JourneyRun[] = []

  // Two seeded projects so the preview shows both journey states: one ready with notes and
  // a reviewed artifact, one empty that prompts for the first note.
  {
    const at = now() - 2 * 24 * 60 * 60 * 1000
    const launch = { id: 'p-launch', name: 'Launch plan', description: 'Ship the desktop app behind the verified checklist.', createdAt: at, updatedAt: at }
    const research = { id: 'p-research', name: 'Research notes', description: '', createdAt: at - 24 * 60 * 60 * 1000, updatedAt: at - 24 * 60 * 60 * 1000 }
    journeyProjects.push(launch, research)
    journeySources.push(
      {
        id: 'src-notes', projectId: launch.id, attachmentId: 'att-notes', name: 'launch-notes.md', kind: 'md',
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', sizeBytes: 4820, createdAt: at + 3_600_000
      },
      {
        id: 'src-brief', projectId: launch.id, attachmentId: 'att-brief', name: 'customer-brief.txt', kind: 'txt',
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', sizeBytes: 1240, createdAt: at + 7_200_000
      }
    )
    const artifact: Artifact = {
      id: 'a-plan', projectId: launch.id, name: 'launch-plan.md', kind: 'proposal', status: 'reviewed',
      createdAt: at + 10 * 3_600_000, updatedAt: at + 10 * 3_600_000
    }
    const r1: ArtifactRevision & { reviews: ReviewDecision[] } = {
      id: 'r1', artifactId: artifact.id, revisionNo: 1,
      sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      provenance: { projectId: launch.id, note: 'first draft from the notes' },
      createdAt: at + 10 * 3_600_000,
      reviews: []
    }
    const r2: ArtifactRevision & { reviews: ReviewDecision[] } = {
      id: 'r2', artifactId: artifact.id, revisionNo: 2,
      sha256: '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9',
      provenance: { projectId: launch.id, note: 'after the review pass' },
      createdAt: at + 12 * 3_600_000,
      reviews: [
        {
          id: 'dec-1', artifactRevisionId: 'r2', rubric: 'Grounded in the notes, assumptions stated, decisions named.',
          reviewer: 'b-iris', decision: 'accepted', explanation: 'The plan matches the notes and states its assumptions.', createdAt: at + 12 * 3_600_000 + 600_000
        }
      ]
    }
    journeyArtifacts.push({
      artifact,
      revisions: [r1, r2],
      content:
        '# Launch plan\n\n- **What**: ship the desktop app behind the verified checklist.\n- **Who**: fai coordinates, iris researches, juno writes.\n- **Proof**: every deliverable lands as a revision here.\n\n> Checked against the launch rubric.'
    })
    journeyRuns.push({
      id: 'jr-1', projectId: launch.id, artifactId: artifact.id, status: 'complete',
      budgets: {
        b1: 3,
        b2: { errors: 0, rate: 0 },
        b3: { inputTokens: 21_400, outputTokens: 2_310, zeroTokenTurns: 0 },
        b4: { wallMs: 3 * 3_600_000 + 600_000, totalMs: 2_620_000 },
        b5: 2,
        b6: { done: 2, error: 0, denied: 0, cancelled: 0, running: 0 },
        b7: 1,
        b8: { sourceBytes: 4_820 + 1_240, entryAttachmentBytes: 0, total: 4_820 + 1_240 },
        b9: { bytes: 342, sha256: '5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9' },
        b10: { checksPassed: 1, checksTotal: 1, repairs: 0 },
        b11: 0
      },
      startedAt: at + 9 * 3_600_000, endedAt: at + 12 * 3_600_000 + 600_000
    })
  }

  // -------------------------------------------------------------------------
  // Channel handlers
  // -------------------------------------------------------------------------

  const skillHead = (s: SkillWithBody): Skill => {
    const { body: _b, resources: _r, ...head } = s
    return head
  }

  function toolsFor(botId?: Id) {
    const bot = botId ? getBot(botId) : undefined
    const mcpTools = db.mcp
      .filter((m) => m.server.enabled && m.status.state === 'ready')
      .flatMap((m) =>
        m.tools
          .filter((t) => !m.server.disabledTools.includes(t.name))
          .map((t) => ({
            name: `mcp__${m.server.name}__${t.name}`,
            description: t.description,
            source: 'mcp' as const,
            serverId: m.server.id,
            defaultPermission: 'ask' as PermissionMode
          }))
      )
    return [...db.tools, ...mcpTools].map((t) => ({
      ...t,
      effectivePermission: bot?.toolPermissions[t.name] ?? db.settings.toolPermissions[t.name] ?? t.defaultPermission
    }))
  }

  function startServer(id: Id): void {
    const m = db.mcp.find((x) => x.server.id === id)
    if (!m) return
    if (!m.server.enabled) {
      m.status = { state: 'stopped' }
      emit('mcp:changed', { at: now() })
      return
    }
    m.status = { state: 'starting' }
    emit('mcp:changed', { at: now() })
    setTimeout(() => {
      const failing = (m.server.url ?? m.server.command ?? '').includes('fail')
      m.status = failing ? { state: 'error', message: 'Could not connect: the server closed the connection.' } : { state: 'ready', toolCount: m.tools.length }
      emit('mcp:changed', { at: now() })
    }, 900)
  }

  function addServer(input: Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>): McpServerConfig {
    const at = now()
    const server: McpServerConfig = { ...input, id: uid('m'), createdAt: at, updatedAt: at }
    db.mcp.push({
      server,
      status: { state: 'stopped' },
      tools: [
        { name: 'search', description: `Search ${server.name}.` },
        { name: 'fetch', description: `Fetch an item from ${server.name}.` },
        { name: 'create', description: `Create an item in ${server.name}.` }
      ]
    })
    startServer(server.id)
    return server
  }

  function validateServer(input: { name: string; transport: string; command?: string; url?: string; id?: Id }): void {
    if (!input.name.trim()) throw new Error('The server name cannot be blank')
    if (!/[a-z0-9]/i.test(input.name)) throw new Error('Name must contain at least one letter or number')
    if (db.mcp.some((m) => m.server.name === input.name && m.server.id !== input.id)) {
      throw new Error(`A server named "${input.name}" already exists`)
    }
    if (input.transport === 'stdio' ? !input.command?.trim() : !input.url?.trim()) {
      throw new Error('The server needs a URL or a command')
    }
  }

  function serversFromJson(json: string): Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new Error('Enter valid JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The JSON must be an object keyed by the server name')
    const root = (parsed as { mcpServers?: unknown }).mcpServers ?? parsed
    if (!root || typeof root !== 'object') throw new Error('The JSON must be an object keyed by the server name')
    return Object.entries(root as Record<string, Record<string, unknown>>).map(([name, cfg]) => {
      if (!cfg || typeof cfg !== 'object') throw new Error('The JSON must be an object keyed by the server name')
      const url = typeof cfg.url === 'string' ? cfg.url : undefined
      const type = typeof cfg.type === 'string' ? cfg.type : undefined
      return {
        name,
        transport: url ? (type === 'sse' ? 'sse' : 'http') : 'stdio',
        command: typeof cfg.command === 'string' ? cfg.command : undefined,
        args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
        env: (cfg.env as Record<string, string> | undefined) ?? undefined,
        url,
        headers: (cfg.headers as Record<string, string> | undefined) ?? undefined,
        enabled: true,
        disabledTools: [],
        customInstructions: ''
      }
    })
  }

  /** A routine run in the preview: post the task in the bot's chat, stream a reply, record the run. */
  function startMockRun(r: Routine): RoutineRun {
    const bot = mustBot(r.botId)
    let c = db.conversations.find((x) => x.kind === 'dm' && x.botIds[0] === bot.id)
    if (!c) {
      const at = now()
      c = { id: uid('c'), kind: 'dm', title: bot.name, botIds: [bot.id], notes: '', lastEntryAt: at, unreadCount: 0, createdAt: at, updatedAt: at }
      db.conversations.push(c)
      emitConv(c)
    }
    const conv = c
    const task = append(conv.id, {
      kind: 'message',
      author: { kind: 'system' },
      text: r.prompt,
      mentions: [bot.id],
      trigger: { kind: 'routine', routineId: r.id, routineName: r.name, via: 'manual' }
    })
    const run: RoutineRun = { id: uid('run'), routineId: r.id, botId: bot.id, trigger: 'manual', status: 'running', startedAt: now(), conversationId: conv.id, entryId: task.id, summary: '' }
    db.runs.push(run)
    r.lastRunAt = run.startedAt
    emit('routines:changed', { botId: bot.id })
    const signal = signalFor(conv.id)
    runInBackground(
      conv.id,
      (async () => {
        try {
          setLive(bot.id, conv.id, 'thinking', 'Working on the routine')
          await sleep(900, signal)
          const reply = `Done. Here is “${r.name}” for today:\n\n1. The routines PR is ready for review.\n2. Two issues need an answer.\n3. Nothing failed overnight.`
          await stream(conv.id, bot.id, reply, signal)
          Object.assign(run, { status: 'done', endedAt: now(), summary: reply.replace(/\s+/g, ' ').slice(0, 300) })
        } catch {
          Object.assign(run, { status: 'cancelled', endedAt: now(), error: 'Stopped' })
        } finally {
          setLive(bot.id, conv.id, 'idle')
          emit('routines:changed', { botId: bot.id })
        }
      })()
    )
    return { ...run }
  }

  const MODELS: Record<string, ModelInfo[]> = {
    anthropic: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 200_000, supportsTools: true, supportsImages: true },
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', contextWindow: 200_000, supportsTools: true, supportsImages: true },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', contextWindow: 200_000, supportsTools: true, supportsImages: true }
    ],
    'claude-code': [
      { id: 'default', label: 'Default (Claude Code picks)', supportsTools: true },
      { id: 'opus', label: 'Opus', supportsTools: true },
      { id: 'sonnet', label: 'Sonnet', supportsTools: true }
    ],
    codex: [
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', supportsTools: true },
      { id: 'gpt-5.1', label: 'GPT-5.1', supportsTools: true }
    ],
    'openai-compatible': [
      { id: 'qwen3-coder', label: 'qwen3-coder', contextWindow: 128_000, supportsTools: true },
      { id: 'llama3.3', label: 'llama3.3', contextWindow: 128_000, supportsTools: true },
      { id: 'gemma3', label: 'gemma3', contextWindow: 128_000, supportsTools: false }
    ]
  }

  const desktopContent = (): never => { throw new Error('Open the desktop app to use the local project Library and Space.') }
  const handlers: Handlers = {
    'content:project': desktopContent, 'content:select': desktopContent, 'content:revoke': desktopContent, 'content:restore': desktopContent,
    'content:read-source': desktopContent, 'content:share': desktopContent, 'content:revise': desktopContent, 'content:read-page': desktopContent, 'content:rerun': desktopContent, 'content:evaluate': desktopContent,
    'app:info': () => ({ name: 'faibots', version: '0.1.0', dataDir: DATA_DIR, platform: 'browser preview (sample data)' }),

    // Bots ------------------------------------------------------------------
    'bots:list': () => db.bots,
    'bots:create': (input) => {
      if (!input.name?.trim()) throw new Error('Name can’t be empty')
      if (input.name.trim().toLowerCase() === 'fai') throw new Error('The name fai belongs to the main bot.')
      const base = slugify(input.handle ?? input.name).replace(/-/g, '') || 'bot'
      let handle = base
      for (let i = 2; db.bots.some((b) => b.handle === handle); i++) handle = `${base}${i}`
      const at = now()
      const bot: Bot = {
        id: uid('b'),
        name: input.name.trim(),
        handle,
        label: input.label ?? '',
        description: input.description ?? '',
        soul: input.soul ?? '',
        avatar: input.avatar ?? {
          shape: AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)]!,
          color: BOT_COLORS[1 + Math.floor(Math.random() * (BOT_COLORS.length - 2))]!
        },
        model: input.model ?? db.settings.defaultModel ?? { providerId: '', modelId: '' },
        isPrimary: false,
        toolPermissions: input.toolPermissions ?? {},
        mcpServerIds: input.mcpServerIds ?? 'all',
        skillIds: input.skillIds ?? [],
        notify: input.notify ?? true,
        dailyRunLimit: input.dailyRunLimit ?? 0,
        pinned: input.pinned ?? false,
        hidden: input.hidden ?? false,
        createdAt: at,
        updatedAt: at
      }
      db.bots.push(bot)
      emitBots()
      return bot
    },
    'bots:update': ({ id, patch }) => {
      const bot = mustBot(id)
      if (patch.name !== undefined && !patch.name.trim()) throw new Error('Name can’t be empty')
      if (!bot.isPrimary && patch.name?.trim().toLowerCase() === 'fai') throw new Error('The name fai belongs to the main bot.')
      if (patch.handle !== undefined) {
        if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(patch.handle)) throw new Error('Use lowercase letters, numbers, - or _ for the handle')
        if (db.bots.some((b) => b.id !== id && b.handle === patch.handle)) throw new Error(`@${patch.handle} is already taken`)
      }
      if (patch.isPrimary !== undefined && patch.isPrimary !== bot.isPrimary) throw new Error('fai is the permanent main bot.')
      if (bot.isPrimary && ((patch.name !== undefined && patch.name !== bot.name) ||
        (patch.handle !== undefined && patch.handle !== bot.handle) || patch.hidden)) {
        throw new Error('fai keeps its name, handle and place in the sidebar.')
      }
      Object.assign(bot, patch, { updatedAt: now() })
      emitBots()
      return bot
    },
    'bots:delete': ({ id }) => {
      if (mustBot(id).isPrimary) throw new Error('fai is the permanent main bot.')
      db.bots = db.bots.filter((b) => b.id !== id)
      for (const c of [...db.conversations]) {
        if (!c.botIds.includes(id)) continue
        if (c.kind === 'group' && c.botIds.length > 1) {
          c.botIds = c.botIds.filter((b) => b !== id)
          emitConv(c)
        } else {
          db.conversations = db.conversations.filter((x) => x.id !== c.id)
          db.entries = db.entries.filter((e) => e.conversationId !== c.id)
          emit('conv:deleted', { conversationId: c.id })
        }
      }
      db.facts = db.facts.filter((f) => f.botId !== id)
      db.skills = db.skills.filter((s) => s.ownerBotId !== id)
      db.secrets = db.secrets.filter((s) => s.botId !== id)
      emitBots()
    },
    'bots:export-recipe': ({ id }) => {
      const bot = mustBot(id)
      const recipe: BotRecipe = {
        format: 'faibots.bot-recipe',
        version: 1,
        profile: { name: bot.name, label: bot.label, description: bot.description, avatarColor: bot.avatar.color, avatarShape: bot.avatar.shape },
        soul: bot.soul,
        memory: [
          ...(db.profiles[id]?.content ? [{ tier: 'profile' as const, content: db.profiles[id]!.content }] : []),
          ...db.facts.filter((f) => f.botId === id).map((f) => ({ tier: 'log' as const, content: f.text, createdAt: new Date(f.createdAt).toISOString() }))
        ],
        skills: db.skills.filter((s) => s.ownerBotId === id).map((s) => ({ name: s.name, description: s.description, content: s.body })),
        mcpServers: []
      }
      return recipe
    },
    'bots:import-recipe': ({ recipe }) => {
      const bot = handlers['bots:create']({
        name: recipe.profile.name,
        label: recipe.profile.label,
        description: recipe.profile.description,
        soul: recipe.soul,
        avatar: { shape: recipe.profile.avatarShape, color: recipe.profile.avatarColor }
      }) as Bot
      const at = now()
      for (const m of recipe.memory) {
        if (m.tier === 'profile') db.profiles[bot.id] = { botId: bot.id, content: m.content, updatedAt: at }
        else db.facts.push({ id: uid('f'), botId: bot.id, tier: 'log', text: m.content, pinned: false, createdBy: 'user', createdAt: at, updatedAt: at })
      }
      for (const s of recipe.skills) {
        const name = slugify(s.name) || 'imported-skill'
        db.skills.push({ id: uid('s'), name, description: s.description, body: s.content, source: 'bot', ownerBotId: bot.id, dir: `${DATA_DIR}\\bot-skills\\${bot.id}\\${name}`, readOnly: false, resources: [], updatedAt: at })
      }
      return bot
    },

    // Conversations ---------------------------------------------------------
    'conv:list': () => db.conversations,
    'conv:open-dm': ({ botId }) => {
      const bot = mustBot(botId)
      let c = db.conversations.find((x) => x.kind === 'dm' && x.botIds[0] === botId)
      if (!c) {
        const at = now()
        c = { id: uid('c'), kind: 'dm', title: bot.name, botIds: [botId], notes: '', lastEntryAt: 0, unreadCount: 0, createdAt: at, updatedAt: at }
        db.conversations.push(c)
        emitConv(c)
      }
      return c
    },
    'conv:create-group': ({ title, botIds, settings }) => {
      if (botIds.length < 1) throw new Error('Pick at least one bot')
      if (botIds.length > MAX_GROUP_BOTS) throw new Error(`A group can have up to ${MAX_GROUP_BOTS} bots`)
      botIds.forEach(mustBot)
      const at = now()
      const c: Conversation = {
        id: uid('g'),
        kind: 'group',
        title: title?.trim() ?? '',
        botIds: [...botIds],
        group: { ...DEFAULT_GROUP_SETTINGS, ...settings },
        notes: '',
        lastEntryAt: at,
        unreadCount: 0,
        createdAt: at,
        updatedAt: at
      }
      db.conversations.push(c)
      emitConv(c)
      return c
    },
    'conv:update': ({ id, patch }) => {
      const c = mustConv(id)
      if (patch.botIds) {
        if (patch.botIds.length > MAX_GROUP_BOTS) throw new Error(`A group can have up to ${MAX_GROUP_BOTS} bots`)
        const added = patch.botIds.filter((b) => !c.botIds.includes(b))
        const removed = c.botIds.filter((b) => !patch.botIds!.includes(b))
        c.botIds = [...patch.botIds]
        for (const b of added) append(id, { kind: 'event', author: { kind: 'system' }, text: `${getBot(b)?.name ?? 'A bot'} was added to the chat` })
        for (const b of removed) append(id, { kind: 'event', author: { kind: 'system' }, text: `${getBot(b)?.name ?? 'A bot'} was removed from the chat` })
      }
      if (patch.title !== undefined && patch.title !== c.title) {
        c.title = patch.title
        if (patch.title.trim()) append(id, { kind: 'event', author: { kind: 'system' }, text: `Renamed to ${patch.title.trim()}` })
      }
      if (patch.notes !== undefined) c.notes = patch.notes
      if (patch.group && c.group) c.group = { ...c.group, ...patch.group }
      c.updatedAt = now()
      emitConv(c)
      return c
    },
    'conv:delete': ({ id }) => {
      turns.get(id)?.abort()
      db.conversations = db.conversations.filter((c) => c.id !== id)
      db.entries = db.entries.filter((e) => e.conversationId !== id)
      emit('conv:deleted', { conversationId: id })
    },
    'conv:entries': ({ conversationId, beforeSeq, limit }) => {
      const all = db.entries
        .filter((e) => e.conversationId === conversationId && (beforeSeq === undefined || e.seq < beforeSeq))
        .sort((a, b) => a.seq - b.seq)
      const size = Math.min(limit ?? 100, 500)
      return { entries: all.slice(-size), hasMore: all.length > size }
    },
    'conv:send': (req) => {
      const c = mustConv(req.conversationId)
      if (c.kind === 'exchange') throw new Error('This chat is view-only')
      const existing = db.entries.find((e) => e.conversationId === c.id && e.clientNonce === req.clientNonce)
      if (existing) return existing
      if (!req.text.trim() && !req.attachmentPaths.length) throw new Error('Write a message first')
      const entry = append(c.id, {
        kind: 'message',
        author: { kind: 'user' },
        text: req.text,
        mentions: req.mentions,
        mentionsEveryone: req.mentionsEveryone,
        replyToId: req.replyToId,
        clientNonce: req.clientNonce,
        attachments: req.attachmentPaths.map((p) => ({
          id: uid('att'),
          name: basename(p),
          mimeType: mimeOf(p),
          sizeBytes: 18_000 + Math.floor(Math.random() * 900_000),
          path: `${DATA_DIR}\\attachments\\${basename(p)}`
        }))
      })
      const signal = signalFor(c.id)
      if (c.kind === 'dm') {
        const bot = getBot(c.botIds[0])
        if (bot) runInBackground(c.id, dmTurn(c, bot, req.text, signal))
      } else {
        runInBackground(c.id, groupTurns(c, entry, signal))
      }
      return entry
    },
    'conv:stop': ({ conversationId }) => {
      const ctl = turns.get(conversationId)
      const wasRunning = [...db.live.values()].some((s) => s.conversationId === conversationId)
      ctl?.abort()
      turns.delete(conversationId)
      for (const s of [...db.live.values()]) {
        const c = getConv(s.conversationId)
        if (s.conversationId === conversationId || c?.origin?.conversationId === conversationId) setLive(s.botId, s.conversationId, 'idle')
      }
      if (wasRunning) append(conversationId, { kind: 'event', author: { kind: 'system' }, text: 'Stopped' })
    },
    'conv:reset': ({ conversationId }) => {
      const c = mustConv(conversationId)
      turns.get(conversationId)?.abort()
      db.entries = db.entries.filter((e) => e.conversationId !== conversationId)
      c.unreadCount = 0
      c.lastEntryAt = now()
      emitConv(c)
    },
    'conv:mark-read': ({ conversationId }) => {
      const c = mustConv(conversationId)
      if (c.unreadCount) {
        c.unreadCount = 0
        emitConv(c)
      }
    },
    'conv:live-states': () => [...db.live.values()],

    // Approvals -------------------------------------------------------------
    'approval:resolve': ({ approvalId, decision }) => {
      const waiting = approvals.get(approvalId)
      if (waiting) return waiting.resolve(decision)
      for (const e of db.entries) {
        if (e.approval?.approvalId === approvalId && e.approval.status === 'pending') updateEntry(e, { approval: { ...e.approval, status: 'expired' } })
      }
    },

    // Memory ----------------------------------------------------------------
    'memory:list': ({ botId, query, limit }) => {
      const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      return db.facts
        .filter((f) => f.botId === botId && words.every((w) => f.text.toLowerCase().includes(w)))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
        .slice(0, limit ?? 200)
    },
    'memory:add': ({ botId, text, pinned }) => {
      mustBot(botId)
      if (!text.trim()) throw new Error('Write the memory first')
      const at = now()
      const f: MemoryFact = { id: uid('f'), botId, tier: 'log', text: text.trim(), pinned: !!pinned, createdBy: 'user', createdAt: at, updatedAt: at }
      db.facts.push(f)
      emit('memory:changed', { botId })
      return f
    },
    'memory:update': ({ id, patch }) => {
      const f = db.facts.find((x) => x.id === id)
      if (!f) throw new Error('Memory not found')
      Object.assign(f, patch, { updatedAt: now() })
      emit('memory:changed', { botId: f.botId })
      return f
    },
    'memory:delete': ({ id }) => {
      const f = db.facts.find((x) => x.id === id)
      db.facts = db.facts.filter((x) => x.id !== id)
      if (f) emit('memory:changed', { botId: f.botId })
    },
    'memory:get-profile': ({ botId }) => db.profiles[botId] ?? { botId, content: '', updatedAt: 0 },
    'memory:set-profile': ({ botId, content }) => {
      db.profiles[botId] = { botId, content, updatedAt: now() }
      emit('memory:changed', { botId })
      return db.profiles[botId]!
    },

    // Skills ----------------------------------------------------------------
    'skills:list': ({ botId }) => {
      const bot = botId ? getBot(botId) : undefined
      const list = bot ? db.skills.filter((s) => bot.skillIds.includes(s.id) || s.ownerBotId === bot.id) : db.skills
      return list.map(skillHead).sort((a, b) => a.name.localeCompare(b.name))
    },
    'skills:get': ({ id }) => {
      const s = db.skills.find((x) => x.id === id)
      if (!s) throw new Error('Skill not found')
      return s
    },
    'skills:save': ({ id, name, description, body, ownerBotId }) => {
      const slug = slugify(name)
      if (!slug) throw new Error('Use at least one letter (a–z) or number')
      if (!description.trim()) throw new Error('Describe when to use this skill ("Use when…")')
      if (!body.trim()) throw new Error('Write the instructions the bot follows')
      if (db.skills.some((s) => s.name === slug && s.id !== id)) throw new Error(`${slug} is already listed`)
      let s = id ? db.skills.find((x) => x.id === id) : undefined
      if (s?.readOnly) throw new Error('This skill is read-only')
      if (s) Object.assign(s, { name: slug, description: description.trim(), body, updatedAt: now() })
      else {
        s = {
          id: uid('s'),
          name: slug,
          description: description.trim(),
          body,
          source: ownerBotId ? 'bot' : 'library',
          ownerBotId,
          dir: `${DATA_DIR}\\${ownerBotId ? `bot-skills\\${ownerBotId}` : 'skills'}\\${slug}`,
          readOnly: false,
          resources: [],
          updatedAt: now()
        }
        db.skills.push(s)
      }
      emit('skills:changed', { at: now() })
      return skillHead(s)
    },
    'skills:delete': ({ id }) => {
      const s = db.skills.find((x) => x.id === id)
      if (s?.readOnly) throw new Error('This skill is read-only')
      db.skills = db.skills.filter((x) => x.id !== id)
      let touched = false
      for (const b of db.bots) {
        if (b.skillIds.includes(id)) {
          b.skillIds = b.skillIds.filter((x) => x !== id)
          touched = true
        }
      }
      if (touched) emitBots()
      emit('skills:changed', { at: now() })
    },
    'skills:import-files': ({ paths, assignToBotId }) => {
      const created: Skill[] = []
      for (const p of paths) {
        const base = slugify(basename(p).replace(/\.(md|txt)$/i, '').replace(/^SKILL$/i, 'imported-skill')) || 'imported-skill'
        let name = base
        for (let i = 2; db.skills.some((s) => s.name === name); i++) name = `${base}-${i}`
        const s: SkillWithBody = {
          id: uid('s'),
          name,
          description: `Use when doing a ${name.replace(/-/g, ' ')}.`,
          body: `# ${name}\n\nImported from ${basename(p)}.`,
          source: 'library',
          dir: `${DATA_DIR}\\skills\\${name}`,
          readOnly: false,
          resources: [],
          updatedAt: now()
        }
        db.skills.push(s)
        created.push(skillHead(s))
      }
      const bot = assignToBotId ? getBot(assignToBotId) : undefined
      if (bot) {
        bot.skillIds = [...bot.skillIds, ...created.map((s) => s.id)]
        emitBots()
      }
      emit('skills:changed', { at: now() })
      return created
    },
    'skills:rescan': () => db.skills.map(skillHead),

    // Tools -----------------------------------------------------------------
    'tools:list': ({ botId }) => toolsFor(botId),
    'tools:set-permission': ({ toolName, botId, mode }) => {
      if (botId) {
        const bot = mustBot(botId)
        const next = { ...bot.toolPermissions }
        if (mode) next[toolName] = mode
        else delete next[toolName]
        bot.toolPermissions = next
        emitBots()
      } else {
        const next = { ...db.settings.toolPermissions }
        if (mode) next[toolName] = mode
        else delete next[toolName]
        db.settings.toolPermissions = next
        emit('settings:changed', { settings: db.settings })
      }
    },

    // MCP -------------------------------------------------------------------
    'mcp:list': () => db.mcp.map((m) => ({ server: m.server, status: m.status })),
    'mcp:save': (input) => {
      validateServer(input)
      if (!input.id) return addServer(input)
      const m = db.mcp.find((x) => x.server.id === input.id)
      if (!m) throw new Error('Connector not found')
      const restart =
        m.server.enabled !== input.enabled ||
        m.server.command !== input.command ||
        m.server.url !== input.url ||
        JSON.stringify(m.server.args) !== JSON.stringify(input.args)
      m.server = { ...m.server, ...input, id: m.server.id, updatedAt: now() }
      if (m.status.state === 'ready') m.status = { state: 'ready', toolCount: m.tools.length - m.server.disabledTools.length }
      if (restart) startServer(m.server.id)
      else emit('mcp:changed', { at: now() })
      return m.server
    },
    'mcp:delete': ({ id }) => {
      db.mcp = db.mcp.filter((m) => m.server.id !== id)
      emit('mcp:changed', { at: now() })
    },
    'mcp:restart': ({ id }) => {
      startServer(id)
      return db.mcp.find((m) => m.server.id === id)?.status ?? { state: 'stopped' }
    },
    'mcp:tools': ({ id }) => {
      const m = db.mcp.find((x) => x.server.id === id)
      if (!m) throw new Error('Connector not found')
      return m.tools.map((t) => ({ ...t, disabled: m.server.disabledTools.includes(t.name) }))
    },
    'mcp:import': ({ source, json }) => {
      const presets: Record<string, Omit<McpServerConfig, 'id' | 'createdAt' | 'updatedAt'>[]> = {
        claude: [
          { name: 'playwright', transport: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], enabled: true, disabledTools: [], customInstructions: '' },
          { name: 'sentry', transport: 'http', url: 'https://mcp.sentry.dev/mcp', enabled: true, disabledTools: [], customInstructions: '' }
        ],
        codex: [{ name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], enabled: true, disabledTools: [], customInstructions: '' }],
        cursor: [{ name: 'linear', transport: 'sse', url: 'https://mcp.linear.app/sse', enabled: true, disabledTools: [], customInstructions: '' }]
      }
      const incoming = source === 'json' ? serversFromJson(json ?? '') : presets[source] ?? []
      if (source === 'json' && incoming.length === 0) throw new Error('Add one server at a time')
      const created: McpServerConfig[] = []
      for (const cfg of incoming) {
        if (db.mcp.some((m) => m.server.name === cfg.name)) {
          if (source === 'json') throw new Error(`A server named "${cfg.name}" already exists`)
          continue
        }
        validateServer(cfg)
        created.push(addServer(cfg))
      }
      return created
    },

    // Providers -------------------------------------------------------------
    'providers:list': () => db.providers,
    'providers:save': (req) => {
      if (!req.label.trim()) throw new Error('Give the provider a name')
      if (req.kind === 'openai-compatible' && !req.baseUrl?.trim()) throw new Error('Enter the server address (base URL)')
      const at = now()
      let p = req.id ? db.providers.find((x) => x.id === req.id) : undefined
      const hasApiKey = req.apiKey === undefined ? (p?.hasApiKey ?? false) : req.apiKey !== ''
      if (p) Object.assign(p, { kind: req.kind, label: req.label.trim(), baseUrl: req.baseUrl || undefined, defaultModelId: req.defaultModelId, enabled: req.enabled, hasApiKey, updatedAt: at })
      else {
        p = { id: uid('p'), kind: req.kind, label: req.label.trim(), baseUrl: req.baseUrl || undefined, defaultModelId: req.defaultModelId, enabled: req.enabled, hasApiKey, createdAt: at, updatedAt: at }
        db.providers.push(p)
      }
      emit('providers:changed', { at })
      return p
    },
    'providers:delete': ({ id }) => {
      db.providers = db.providers.filter((p) => p.id !== id)
      emit('providers:changed', { at: now() })
    },
    'providers:test': async ({ id }): Promise<ProviderTestResult> => {
      const p = db.providers.find((x) => x.id === id)
      await sleep(700)
      if (!p) return { ok: false, message: 'Provider not found', billing: 'unknown' }
      switch (p.kind) {
        case 'claude-code':
          return { ok: true, message: 'Claude Code is installed and signed in.', billing: 'subscription' }
        case 'codex':
          return { ok: true, message: 'Codex is signed in with your ChatGPT plan.', billing: 'subscription' }
        case 'openai-compatible': {
          const local = /localhost|127\.0\.0\.1/.test(p.baseUrl ?? '')
          return { ok: true, message: `The server at ${p.baseUrl} answered with 3 models.`, billing: local ? 'local' : 'api-key' }
        }
        default:
          return p.hasApiKey
            ? { ok: true, message: 'Connected. The key works.', billing: 'api-key' }
            : { ok: false, message: 'No API key saved. Add a key and test again.', billing: 'api-key' }
      }
    },
    'providers:models': async ({ id }) => {
      const p = db.providers.find((x) => x.id === id)
      await sleep(250)
      if (!p) throw new Error('Provider not found')
      return MODELS[p.kind] ?? []
    },

    // Secrets ---------------------------------------------------------------
    'secrets:list': ({ botId }) => db.secrets.filter((s) => (botId ? s.botId === botId : true)),
    'secrets:set': ({ botId, name, description, value }) => {
      if (!name) throw new Error('Enter an environment variable name')
      if (!SECRET_NAME.test(name)) throw new Error('Use an uppercase environment variable name (A-Z, 0-9, _) that starts with a letter')
      if (RESERVED_SECRETS.includes(name)) throw new Error(`${name} is reserved`)
      if (name.startsWith('FAIBOTS_')) throw new Error('Names starting with FAIBOTS_ are reserved')
      if (!value) throw new Error('Paste the secret value')
      const at = now()
      let s = db.secrets.find((x) => x.name === name && x.botId === botId)
      if (s) Object.assign(s, { description, updatedAt: at })
      else {
        s = { id: uid('sec'), name, description, botId, createdAt: at, updatedAt: at }
        db.secrets.push(s)
      }
      return s
    },
    'secrets:delete': ({ id }) => {
      db.secrets = db.secrets.filter((s) => s.id !== id)
    },

    // Routines --------------------------------------------------------------
    'routines:list': ({ botId }) => db.routines.filter((r) => !botId || r.botId === botId),
    'routines:save': (input) => {
      const bot = mustBot(input.botId)
      if (!input.name.trim()) throw new Error('Give the routine a name.')
      if (!input.prompt.trim()) throw new Error(`Say what ${bot.name} should do on each run.`)
      const schedule = normalizeSchedule(input.schedule)
      const at = now()
      let r = input.id ? db.routines.find((x) => x.id === input.id) : undefined
      const enabled = input.enabled ?? r?.enabled ?? true
      const nextRunAt = enabled ? nextRunAfter(schedule, at) : undefined
      if (r) {
        Object.assign(r, { name: input.name.trim(), prompt: input.prompt.trim(), schedule, enabled, webhookEnabled: input.webhookEnabled ?? r.webhookEnabled, updatedAt: at })
        if (nextRunAt === undefined) delete r.nextRunAt
        else r.nextRunAt = nextRunAt
      } else {
        r = {
          id: uid('r'), botId: bot.id, name: input.name.trim(), prompt: input.prompt.trim(), schedule, enabled,
          webhookEnabled: input.webhookEnabled ?? false, hasWebhookToken: false, createdBy: 'user', createdAt: at, updatedAt: at,
          ...(nextRunAt !== undefined && { nextRunAt })
        }
        db.routines.push(r)
      }
      emit('routines:changed', { botId: bot.id })
      return r
    },
    'routines:delete': ({ id }) => {
      const r = db.routines.find((x) => x.id === id)
      db.routines = db.routines.filter((x) => x.id !== id)
      db.runs = db.runs.filter((x) => x.routineId !== id)
      if (r) emit('routines:changed', { botId: r.botId })
    },
    'routines:run-now': ({ id }) => {
      const r = db.routines.find((x) => x.id === id)
      if (!r) throw new Error('Routine not found')
      if (db.runs.some((x) => x.routineId === id && x.status === 'running')) throw new Error(`“${r.name}” is already running.`)
      return startMockRun(r)
    },
    'routines:runs': ({ routineId, botId, limit }) =>
      db.runs
        .filter((x) => (routineId ? x.routineId === routineId : botId ? x.botId === botId : true))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit ?? 30),
    'routines:webhook-token': ({ id }) => {
      const r = db.routines.find((x) => x.id === id)
      if (!r) throw new Error('Routine not found')
      r.hasWebhookToken = true
      emit('routines:changed', { botId: r.botId })
      return { token: `fbr_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`, url: `http://127.0.0.1:${db.settings.webhooks.port}/routines/${id}/run` }
    },
    'routines:webhook-status': () => ({
      enabled: db.settings.webhooks.enabled,
      listening: db.settings.webhooks.enabled,
      port: db.settings.webhooks.port
    }),

    // Usage -----------------------------------------------------------------
    'usage:summary': ({ days }) => {
      const from = new Date(now() - (days - 1) * 24 * 3_600_000)
      const fromDay = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`
      return { from: from.getTime(), to: now(), rows: db.usage.filter((r) => r.day >= fromDay) }
    },

    // Settings --------------------------------------------------------------
    'settings:get': () => db.settings,
    'settings:update': (patch) => {
      const next = { ...db.settings, ...patch }
      if (!next.workspaceRoot.trim()) throw new Error('Workspace folder cannot be empty')
      if (!(next.compactAt >= 0.1 && next.compactAt <= 0.95)) throw new Error('compactAt must be between 0.1 and 0.95')
      db.settings = next
      emit('settings:changed', { settings: next })
      return next
    },

    // Journey (M1b preview) -------------------------------------------------
    'projects:list': () => journeyProjects,
    'projects:get': ({ id }) => {
      const p = journeyProjects.find((x) => x.id === id)
      if (!p) throw new Error('Project not found')
      return p
    },
    'projects:create': ({ name, description }) => {
      if (!name?.trim()) throw new Error('A project needs a name')
      const at = now()
      const project: Project = { id: uid('p'), name: name.trim(), description: (description ?? '').trim(), createdAt: at, updatedAt: at }
      journeyProjects.push(project)
      return project
    },
    'projects:attach-notes': ({ projectId, paths }) => {
      if (!journeyProjects.some((p) => p.id === projectId)) throw new Error('Project not found')
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('Pick at least one note file')
      return paths.map((path): ProjectSource => {
        const name = basename(path)
        const ext = name.split('.').pop()?.toLowerCase() ?? ''
        if (ext !== 'md' && ext !== 'txt' && ext !== 'pdf') {
          throw new Error(`Notes must be Markdown (.md), plain text (.txt) or PDF (.pdf); ${name} is not supported.`)
        }
        const source: ProjectSource = {
          id: uid('src'),
          projectId,
          attachmentId: uid('att'),
          name,
          sha256: `${Math.floor(Math.random() * 0xffffffffffffffff).toString(16).padStart(16, '0')}`.padEnd(64, '0'),
          sizeBytes: 2_048 + Math.floor(Math.random() * 60_000),
          kind: ext as NoteKind,
          createdAt: now()
        }
        journeySources.push(source)
        return source
      })
    },
    'projects:list-sources': ({ projectId }) => journeySources.filter((s) => s.projectId === projectId),
    'artifacts:list': ({ projectId }) => journeyArtifacts.filter((a) => a.artifact.projectId === projectId),
    'projects:start-mission': ({ projectId }) => {
      const project = journeyProjects.find((p) => p.id === projectId)
      if (!project) throw new Error('Project not found')
      const sources = journeySources.filter((s) => s.projectId === projectId)
      if (sources.length === 0) throw new Error('Attach at least one note before starting the mission.')
      if (journeyRuns.some((r) => r.projectId === projectId && (r.status === 'working' || r.status === 'waiting_review'))) {
        throw new Error('A mission for this project is already running.')
      }
      const at = now()
      const artifact: Artifact = { id: uid('a'), projectId, name: `${project.name} proposal.md`, kind: 'proposal', status: 'draft', createdAt: at, updatedAt: at }
      journeyArtifacts.push({ artifact, revisions: [] })
      const run: JourneyRun = { id: uid('jr'), projectId, artifactId: artifact.id, status: 'working', budgets: {}, startedAt: at }
      journeyRuns.push(run)
      emit('journey:changed', { projectId })
      // Preview simulation of the real pipeline (draft -> revision -> one bot review). Sample
      // data only: the real run is main-process code with real turns and host verification.
      setTimeout(() => {
        const row = journeyArtifacts.find((a) => a.artifact.id === artifact.id)!
        if (!row.revisions.length) {
          row.revisions.push({
            id: uid('rev'), artifactId: artifact.id, revisionNo: 1,
            sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
            provenance: { projectId, note: 'first draft from the notes' },
            createdAt: now(),
            reviews: []
          })
        }
        Object.assign(run, { status: 'waiting_review' })
        emit('journey:changed', { projectId })
      }, 1_400)
      setTimeout(() => {
        const row = journeyArtifacts.find((a) => a.artifact.id === artifact.id)!
        const revision = row.revisions[row.revisions.length - 1]
        if (revision) {
          revision.reviews.push({
            id: uid('dec'), artifactRevisionId: revision.id, rubric: 'Grounded in the notes, assumptions stated, decisions named.',
            reviewer: 'b-iris', decision: 'accepted', explanation: 'The draft matches the notes and states its assumptions.', createdAt: now()
          })
          row.content = '# Proposal\n\nThe proposal is grounded in the selected notes, with the assumptions stated explicitly.'
        }
        artifact.status = 'reviewed'
        Object.assign(run, { status: 'complete', endedAt: now(), budgets: { b1: 3, b7: 1, b10: { checksPassed: 1, checksTotal: 1, repairs: 0 } } })
        emit('journey:changed', { projectId })
      }, 2_800)
      return { ...run }
    },
    'projects:list-runs': ({ projectId, limit }) =>
      journeyRuns
        .filter((r) => r.projectId === projectId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit ?? 30),

    'dialog:open-files': ({ filters, directories }) => {
      if (directories) return ['C:\\Users\\sample\\Documents\\skills\\standup-notes']
      const wantsText = filters?.some((f) => f.extensions.includes('md'))
      return wantsText
        ? ['C:\\Users\\sample\\Documents\\skills\\meeting-notes.md']
        : ['C:\\Users\\sample\\Documents\\launch-brief.pdf', 'C:\\Users\\sample\\Documents\\signups.csv']
    }
  }

  return {
    async invoke(channel: InvokeChannel, req: unknown) {
      await sleep(25 + Math.random() * 40)
      const fn = handlers[channel] as (r: unknown) => unknown
      return clone(await fn(req))
    },
    on(channel: EventChannel, listener: (payload: unknown) => void) {
      let set = listeners.get(channel)
      if (!set) listeners.set(channel, (set = new Set()))
      set.add(listener)
      return () => set.delete(listener)
    }
  } as FaiBotsBridge
}
