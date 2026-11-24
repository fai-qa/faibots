// Sample data for the mock bridge: a small team of bots with history, memory, skills,
// connectors and providers. Only used when the app runs without the real backend.

import {
  DEFAULT_GROUP_SETTINGS,
  type AppSettings,
  type Bot,
  type BotLiveState,
  type BotMemoryProfile,
  type Conversation,
  type Entry,
  type Id,
  type McpServerConfig,
  type McpServerStatus,
  type MemoryFact,
  type PermissionMode,
  type ProviderConfig,
  type Routine,
  type RoutineRun,
  type SecretInfo,
  type SkillWithBody,
  type ToolInfo,
  type UsageRow
} from '@shared/domain'
import { nextRunAfter } from '@shared/routines'

export type MockTool = Omit<ToolInfo, 'effectivePermission'>

export interface MockMcp {
  server: McpServerConfig
  status: McpServerStatus
  tools: { name: string; description: string }[]
}

export interface MockDb {
  settings: AppSettings
  bots: Bot[]
  conversations: Conversation[]
  entries: Entry[]
  exchangeAnchorByMessage: Map<Id, Id>
  facts: MemoryFact[]
  profiles: Record<Id, BotMemoryProfile>
  skills: SkillWithBody[]
  tools: MockTool[]
  mcp: MockMcp[]
  providers: ProviderConfig[]
  secrets: SecretInfo[]
  routines: Routine[]
  runs: RoutineRun[]
  /** Usage per bot and day, newest days last (the mock's turn log). */
  usage: UsageRow[]
  live: Map<string, BotLiveState>
}

const MIN = 60_000
const HOUR = 60 * MIN

export const WORKSPACE_ROOT = 'C:\\Users\\sample\\faibots\\workspaces'
export const DATA_DIR = 'C:\\Users\\sample\\AppData\\Roaming\\faibots'

const FAI_SOUL = `# fai

You are fai, Alex's chief of staff. You keep the big picture and make sure nothing falls through the cracks.

## Voice
- Calm, brief and concrete. Lead with the answer, then the next step.
- Plain words. No hype, no filler.

## How you work
- Break work into small steps and say who owns each one.
- Delegate research to @iris and writing to @juno with \`send_to_agent\`.
- Check in before anything leaves the building (emails, posts, purchases).

## Boundaries
- Never run destructive commands without asking.
- If you are unsure, say so and suggest how to find out.`

const IRIS_SOUL = `# Iris

You are Iris, a careful researcher. You find good sources, compare options fairly and summarise what matters.

## Voice
- Curious and precise. Short paragraphs, tables when comparing.
- Always say how confident you are and why.

## Habits
- Cite sources with links.
- Separate facts from your opinion.`

const JUNO_SOUL = `# Juno

You are Juno, a writer who drafts in Alex's voice: warm, direct and a little playful.

- Offer two or three options, never ten.
- Keep headlines under eight words.
- Ask about the audience before writing anything long.`

const REX_SOUL = `# Rex

You review code like a kind senior engineer. Point out risk first, style last.

- Run the tests before you approve anything.
- Explain *why* a change is risky, with a small example.`

const PIXEL_SOUL = `# Pixel

You are Pixel, a product designer. You care about calm, readable interfaces.

- Sketch with words first: layout, hierarchy, then colour.
- Prefer one strong idea over many small decorations.`

function makeBot(p: Partial<Bot> & Pick<Bot, 'id' | 'name' | 'handle'>, at: number): Bot {
  return {
    label: '',
    description: '',
    soul: '',
    avatar: { shape: 'blob', color: 'gray' },
    model: { providerId: 'p-anthropic', modelId: 'claude-opus-5-5' },
    isPrimary: false,
    toolPermissions: {},
    mcpServerIds: 'all',
    skillIds: [],
    notify: true,
    dailyRunLimit: 0,
    pinned: false,
    hidden: false,
    createdAt: at,
    updatedAt: at,
    ...p
  }
}

function makeConv(p: Partial<Conversation> & Pick<Conversation, 'id' | 'kind' | 'botIds'>, at: number): Conversation {
  return { title: '', notes: '', lastEntryAt: 0, unreadCount: 0, createdAt: at, updatedAt: at, ...p }
}

export function seedMockData(now = Date.now()): MockDb {
  const weekAgo = now - 7 * 24 * HOUR
  const yesterday = now - 24 * HOUR

  const bots: Bot[] = [
    makeBot(
      {
        id: 'b-atlas',
        name: 'fai',
        handle: 'fai',
        label: 'Chief of staff',
        description: 'Coordinates your other bots, keeps plans and checklists, and checks in on what needs you.',
        soul: FAI_SOUL,
        avatar: { shape: 'squircle', color: 'blue' },
        model: { providerId: 'p-anthropic', modelId: 'claude-opus-5-5', effort: 'high' },
        isPrimary: true,
        pinned: true,
        dailyRunLimit: 10,
        skillIds: ['s-weekly-report', 's-release-checklist']
      },
      weekAgo
    ),
    makeBot(
      {
        id: 'b-iris',
        name: 'Iris',
        handle: 'iris',
        label: 'Research',
        description: 'Finds sources, compares options and summarises what matters, with links.',
        soul: IRIS_SOUL,
        avatar: { shape: 'egg', color: 'violet' },
        model: { providerId: 'p-claude-code', modelId: 'default' },
        dailyRunLimit: 6,
        skillIds: ['s-weekly-report']
      },
      weekAgo + MIN
    ),
    makeBot(
      {
        id: 'b-juno',
        name: 'Juno',
        handle: 'juno',
        label: 'Writing, marketing',
        description: 'Drafts announcements, posts and emails in your voice.',
        soul: JUNO_SOUL,
        avatar: { shape: 'cloud', color: 'orange' },
        model: { providerId: 'p-anthropic', modelId: 'claude-opus-5-5', effort: 'medium' }
      },
      weekAgo + 2 * MIN
    ),
    makeBot(
      {
        id: 'b-rex',
        name: 'Rex',
        handle: 'rex',
        label: 'Code review',
        description: 'Reviews diffs, runs tests and points out risky changes before you ship.',
        soul: REX_SOUL,
        avatar: { shape: 'shield', color: 'green' },
        model: { providerId: 'p-ollama', modelId: 'qwen3-coder' },
        toolPermissions: { shell: 'ask' }
      },
      weekAgo + 3 * MIN
    ),
    makeBot(
      {
        id: 'b-pixel',
        name: 'Pixel',
        handle: 'pixel',
        label: 'Design',
        description: 'Sketches layouts, picks colours and writes interface copy.',
        soul: PIXEL_SOUL,
        avatar: { shape: 'flower', color: 'magenta' },
        model: { providerId: 'p-codex', modelId: '' }
      },
      weekAgo + 4 * MIN
    ),
    makeBot(
      {
        id: 'b-ledger',
        name: 'Ledger',
        handle: 'ledger',
        label: 'Finance',
        description: 'Tracks spend and invoices.',
        avatar: { shape: 'hex', color: 'yellow' },
        hidden: true
      },
      weekAgo + 5 * MIN
    )
  ]

  const conversations: Conversation[] = [
    makeConv({ id: 'c-atlas', kind: 'dm', botIds: ['b-atlas'], title: 'fai' }, weekAgo),
    makeConv({ id: 'c-iris', kind: 'dm', botIds: ['b-iris'], title: 'Iris' }, weekAgo),
    makeConv({ id: 'c-juno', kind: 'dm', botIds: ['b-juno'], title: 'Juno' }, weekAgo),
    makeConv({ id: 'c-rex', kind: 'dm', botIds: ['b-rex'], title: 'Rex' }, weekAgo),
    makeConv(
      {
        id: 'g-launch',
        kind: 'group',
        botIds: ['b-atlas', 'b-iris', 'b-juno'],
        title: 'Launch crew',
        group: { ...DEFAULT_GROUP_SETTINGS },
        notes: 'Launch: Thursday. Owner of the checklist: fai.'
      },
      yesterday
    ),
    makeConv(
      {
        id: 'x-atlas-iris',
        kind: 'exchange',
        botIds: ['b-atlas', 'b-iris'],
        title: 'fai and Iris',
        origin: { conversationId: 'c-atlas', entryId: 'e-atlas-5', fromBotId: 'b-atlas' }
      },
      now - 39 * MIN
    )
  ]

  const entries: Entry[] = []
  const seqs = new Map<Id, number>()
  const add = (conversationId: Id, at: number, p: Partial<Entry> & Pick<Entry, 'kind' | 'author'>): Entry => {
    const seq = (seqs.get(conversationId) ?? 0) + 1
    seqs.set(conversationId, seq)
    const entry: Entry = {
      id: `e-${conversationId.replace(/^[a-z]-/, '')}-${seq}`,
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
    entries.push(entry)
    return entry
  }
  const user = { kind: 'user' } as const
  const by = (botId: Id) => ({ kind: 'bot', botId }) as const

  // --- fai dm ---------------------------------------------------------------
  add('c-atlas', yesterday - 3 * HOUR, {
    kind: 'message',
    author: user,
    text: 'Can you keep an eye on the launch checklist this week? Thursday is the date.'
  })
  add('c-atlas', yesterday - 3 * HOUR + MIN, {
    kind: 'tool-call',
    author: by('b-atlas'),
    toolCall: {
      callId: 'call-mem-1',
      toolName: 'update_memory',
      title: 'Saved to memory',
      input: { action: 'write', tier: 'log', content: 'Launch is planned for Thursday.' },
      status: 'done',
      resultText: 'Saved: Launch is planned for Thursday.'
    }
  })
  add('c-atlas', yesterday - 3 * HOUR + MIN + 5000, {
    kind: 'message',
    author: by('b-atlas'),
    text: "Will do. I saved **Thursday** as the launch date and I'll check in each morning with what's left.",
    meta: { providerId: 'p-anthropic', modelId: 'claude-opus-5-5' }
  })
  add('c-atlas', now - 40 * MIN, {
    kind: 'message',
    author: user,
    text: 'Morning! What did Iris find on competitor pricing?'
  })
  const pricingCall = add('c-atlas', now - 39 * MIN, {
    kind: 'tool-call',
    author: by('b-atlas'),
    toolCall: {
      callId: 'call-x-1',
      toolName: 'send_to_agent',
      title: 'Messaged Iris',
      input: { to: '@iris', message: 'What did you find on competitor pricing for the launch? Alex wants a short summary.',
        reason: 'Iris researched competitor pricing for this launch.' },
      status: 'done',
      resultText: 'Two of the three charge per seat; one charges per workspace. Median price is $12 per seat per month.',
      exchangeConversationId: 'x-atlas-iris'
    }
  })
  add('c-atlas', now - 37 * MIN, {
    kind: 'message',
    author: by('b-atlas'),
    text: [
      'Here is the short version from @iris:',
      '',
      '| Product | Pricing | Free tier |',
      '|---|---|---|',
      '| Northwind | $10 per seat | Yes, 3 seats |',
      '| Contoso | $14 per seat | No |',
      '| Fabrikam | $49 per workspace | 14-day trial |',
      '',
      'Where that leaves the checklist:',
      '',
      '- [x] Landing page copy',
      '- [x] Pricing research',
      '- [ ] Release notes (Juno is drafting)',
      '- [ ] Final test run',
      '',
      'Want me to run the tests now?'
    ].join('\n'),
    mentions: ['b-iris'],
    meta: { providerId: 'p-anthropic', modelId: 'claude-opus-5-5' }
  })
  add('c-atlas', now - 6 * MIN, {
    kind: 'message',
    author: user,
    text: 'Great. Run the test suite before we ship.'
  })
  add('c-atlas', now - 5 * MIN, {
    kind: 'approval',
    author: by('b-atlas'),
    text: 'Run the test suite before we ship.',
    approval: {
      approvalId: 'ap-seed-empty',
      toolName: 'shell',
      summary: 'Run the test suite before we ship.',
      input: {},
      status: 'pending'
    }
  })

  // --- Exchange fai <-> Iris ------------------------------------------------
  const pricingQuestion = add('x-atlas-iris', now - 39 * MIN, {
    kind: 'message',
    author: by('b-atlas'),
    text: 'What did you find on competitor pricing for the launch? Alex wants a short summary.'
  })
  const pricingAnswer = add('x-atlas-iris', now - 38 * MIN, {
    kind: 'message',
    author: by('b-iris'),
    text: [
      'Short version:',
      '',
      '- **Northwind**: $10 per seat, free for up to 3 seats.',
      '- **Contoso**: $14 per seat, no free tier.',
      '- **Fabrikam**: $49 per workspace, 14-day trial.',
      '',
      'Two of three charge per seat, so per-seat pricing will feel familiar. Confidence: medium, the Contoso page was updated last month.'
    ].join('\n')
  })

  // --- Iris dm ----------------------------------------------------------------
  add('c-iris', yesterday - 5 * HOUR, {
    kind: 'message',
    author: user,
    text: 'Find me two good reads on local-first software.'
  })
  add('c-iris', yesterday - 5 * HOUR + 2 * MIN, {
    kind: 'tool-call',
    author: by('b-iris'),
    toolCall: {
      callId: 'call-web-1',
      toolName: 'web_fetch',
      title: 'Read a web page',
      input: { url: 'https://www.inkandswitch.com/local-first/' },
      status: 'done',
      resultText: 'Local-first software: You own your data, in spite of the cloud (12,400 words)'
    }
  })
  add('c-iris', yesterday - 5 * HOUR + 3 * MIN, {
    kind: 'message',
    author: by('b-iris'),
    text: [
      'Two worth your time:',
      '',
      '1. [Local-first software](https://www.inkandswitch.com/local-first/) by Ink & Switch. The original essay; the seven ideals are the useful part.',
      '2. A follow-up talk on CRDTs in practice, if you want the engineering side.',
      '',
      "I'd start with the first one. It takes about 40 minutes."
    ].join('\n')
  })

  // --- Juno dm (unread) -------------------------------------------------------
  add('c-juno', now - 15 * MIN, {
    kind: 'message',
    author: by('b-juno'),
    text: 'I drafted the launch post. Want the short version or the long one first?'
  })

  // --- Group ------------------------------------------------------------------
  add('g-launch', yesterday, { kind: 'event', author: { kind: 'system' }, text: 'Juno was added to the chat' })
  add('g-launch', now - 2 * HOUR, {
    kind: 'message',
    author: user,
    text: "Quick sync: what's left before Thursday?"
  })
  add('g-launch', now - 2 * HOUR + 20_000, {
    kind: 'message',
    author: by('b-atlas'),
    text: 'From my side the checklist is 7 of 10 done. Open items: release notes, the pricing page and a final test run.'
  })
  add('g-launch', now - 2 * HOUR + 32_000, {
    kind: 'message',
    author: by('b-iris'),
    text: "Pricing page: I'll have the competitor comparison ready by tonight."
  })
  add('g-launch', now - 2 * HOUR + 40_000, { kind: 'event', author: by('b-juno'), text: 'Juno passed' })

  for (const conv of conversations) {
    const last = entries.filter((e) => e.conversationId === conv.id).pop()
    if (last) conv.lastEntryAt = last.createdAt
  }
  conversations.find((c) => c.id === 'c-juno')!.unreadCount = 1

  const facts: MemoryFact[] = [
    fact('f-1', 'b-atlas', 'Launch is planned for Thursday.', true, 'bot', yesterday - 3 * HOUR),
    fact('f-2', 'b-atlas', 'Alex prefers bullet points over long paragraphs.', false, 'user', weekAgo + HOUR),
    fact('f-3', 'b-atlas', 'Works on Windows 11 with PowerShell 7.', false, 'bot', weekAgo + 2 * HOUR),
    fact('f-4', 'b-atlas', 'Weekly report goes out on Fridays before 4 pm.', true, 'bot', weekAgo + 3 * HOUR),
    fact('f-5', 'b-iris', 'Alex likes sources with a confidence note.', false, 'bot', yesterday),
    fact('f-6', 'b-juno', 'Headlines: under eight words, no exclamation marks.', true, 'user', weekAgo)
  ]

  const profiles: Record<Id, BotMemoryProfile> = {
    'b-atlas': {
      botId: 'b-atlas',
      content:
        '## About Alex\n- Building faibots, a local multi-bot app.\n- Likes short answers with a clear next step.\n\n## Current work\n- Launch on Thursday. I own the checklist.',
      updatedAt: yesterday
    }
  }

  const skills: SkillWithBody[] = [
    skill('s-weekly-report', 'weekly-report', 'Use when writing the Friday status report for the team.', 'library', yesterday, {
      body: '# Weekly report\n\n1. List what shipped this week, one line each.\n2. List what is blocked and who can unblock it.\n3. End with the top three priorities for next week.\n\nKeep it under 200 words.'
    }),
    skill('s-release-checklist', 'release-checklist', 'Use when preparing a release or a launch.', 'library', weekAgo, {
      body: '# Release checklist\n\n- [ ] Tests pass\n- [ ] Release notes written\n- [ ] Version bumped\n- [ ] Announcement scheduled',
      resources: ['template.md']
    }),
    skill('s-competitor-scan', 'competitor-scan', "Use when asked to compare competitors' pricing or features.", 'bot', yesterday, {
      ownerBotId: 'b-iris',
      body: '# Competitor scan\n\nCompare at most five products. Use a table: product, price, free tier, notes. Add a confidence line.'
    }),
    skill('s-pdf', 'pdf-tools', 'Use when reading, splitting or filling PDF files.', 'external', weekAgo, {
      readOnly: true,
      dir: 'C:\\Users\\sample\\.claude\\skills\\pdf-tools',
      body: '# PDF tools\n\nUse the bundled scripts to extract text and fill forms.',
      resources: ['scripts/extract.py', 'scripts/fill.py']
    })
  ]

  const tools: MockTool[] = [
    tool('shell', 'Run a command in PowerShell (Windows) or bash, in your workspace by default.', 'builtin', 'ask'),
    tool('read_file', 'Read a text file. Relative paths start at your workspace.', 'builtin', 'ask', true),
    tool('list_dir', 'List the files and folders in a folder.', 'builtin', 'ask', true),
    tool('write_file', 'Create or overwrite a text file with the given content.', 'builtin', 'ask', true),
    tool('edit_file', 'Replace text in a file.', 'builtin', 'ask', true),
    tool('web_fetch', 'Fetch a web page and read it as Markdown.', 'builtin', 'always'),
    tool('update_memory', 'Write, edit or delete your long-term memory.', 'faibots', 'always'),
    tool('recall_memory', 'Search your own long-term memory for facts you saved earlier.', 'faibots', 'always'),
    tool('skill', 'Load one of your skills by name and get its full instructions.', 'faibots', 'always'),
    tool('update_skill', 'Create, update or delete a skill you own.', 'faibots', 'always'),
    tool('send_to_agent', 'Ask another bot for help and wait for its answer.', 'faibots', 'always'),
    tool('list_bots', 'See the other bots you can ask for help.', 'faibots', 'always'),
    tool('create_bot', 'Propose a new bot. The user is asked first.', 'faibots', 'ask'),
    tool('pass_turn', 'In a group, stay quiet this round when you have nothing to add.', 'faibots', 'always')
  ]

  const mcp: MockMcp[] = [
    {
      server: mcpServer('m-fs', 'filesystem', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\sample\\Documents'],
        disabledTools: ['write_file']
      }, weekAgo),
      status: { state: 'ready', toolCount: 4 },
      tools: [
        { name: 'read_text_file', description: 'Read a file as text.' },
        { name: 'list_directory', description: 'List a directory.' },
        { name: 'search_files', description: 'Search for files by name.' },
        { name: 'write_file', description: 'Write a file.' }
      ]
    },
    {
      server: mcpServer('m-github', 'github', {
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' }
      }, weekAgo),
      status: { state: 'error', message: '401 Unauthorized. Check the Authorization header.' },
      tools: [
        { name: 'create_issue', description: 'Open an issue.' },
        { name: 'search_code', description: 'Search code across repositories.' }
      ]
    },
    {
      server: mcpServer('m-notion', 'notion', {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        enabled: false
      }, weekAgo),
      status: { state: 'stopped' },
      tools: [{ name: 'search', description: 'Search pages.' }]
    }
  ]

  const providers: ProviderConfig[] = [
    provider('p-anthropic', 'anthropic', 'Anthropic', { hasApiKey: true, defaultModelId: 'claude-opus-5-5' }, weekAgo),
    provider('p-claude-code', 'claude-code', 'Claude Code', { defaultModelId: 'default' }, weekAgo),
    provider('p-codex', 'codex', 'Codex', { defaultModelId: '' }, weekAgo),
    provider('p-ollama', 'openai-compatible', 'Ollama', { baseUrl: 'http://localhost:11434/v1', defaultModelId: 'qwen3-coder' }, weekAgo)
  ]

  const secrets: SecretInfo[] = [
    {
      id: 'sec-1',
      name: 'GITHUB_TOKEN',
      description: 'Open issues and pull requests on the faibots repo',
      botId: 'b-atlas',
      createdAt: weekAgo,
      updatedAt: weekAgo
    }
  ]

  const settings: AppSettings = {
    theme: 'system',
    botColorInChat: false,
    defaultModel: { providerId: 'p-anthropic', modelId: 'claude-opus-5-5' },
    toolPermissions: {},
    workspaceRoot: WORKSPACE_ROOT,
    notifications: { enabled: true, sound: true },
    compactAt: 0.7,
    userName: 'Alex',
    background: { keepRunning: true, openAtLogin: false, routinesPaused: false },
    webhooks: { enabled: false, port: 47821 }
  }

  const { routines, runs } = seedRoutines(now, weekAgo)
  const usage = seedUsage(now, bots)

  const exchangeAnchorByMessage = new Map([[pricingQuestion.id, pricingCall.id], [pricingAnswer.id, pricingCall.id]])
  return { settings, bots, conversations, entries, exchangeAnchorByMessage, facts, profiles, skills, tools, mcp, providers, secrets, routines, runs, usage, live: new Map() }
}

function seedRoutines(now: number, at: number): { routines: Routine[]; runs: RoutineRun[] } {
  const routine = (p: Partial<Routine> & Pick<Routine, 'id' | 'botId' | 'name' | 'prompt' | 'schedule'>): Routine => {
    const enabled = p.enabled ?? true
    const nextRunAt = enabled ? nextRunAfter(p.schedule, now) : undefined
    return {
      enabled,
      webhookEnabled: false,
      hasWebhookToken: false,
      createdBy: 'user',
      createdAt: at,
      updatedAt: at,
      ...(nextRunAt !== undefined && { nextRunAt }),
      ...p
    }
  }
  const routines = [
    routine({
      id: 'r-brief',
      botId: 'b-atlas',
      name: 'Morning brief',
      prompt: 'Read my calendar and the open issues on the faibots repo. Give me the three things that matter most today, in one short list.',
      schedule: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] },
      lastRunAt: now - 26 * HOUR
    }),
    routine({
      id: 'r-digest',
      botId: 'b-iris',
      name: 'Weekly research digest',
      prompt: 'Summarise what changed this week in local-first AI agents: new releases, papers and launches. Five bullets with links.',
      schedule: { kind: 'daily', time: '16:00', days: [5] },
      createdBy: 'bot'
    }),
    routine({
      id: 'r-ci',
      botId: 'b-rex',
      name: 'Check a failed build',
      prompt: 'A CI build failed. Read the log in the data below, find the first real error and suggest the smallest fix.',
      schedule: { kind: 'manual' },
      webhookEnabled: true,
      hasWebhookToken: true
    })
  ]
  const run = (id: string, daysAgo: number, status: RoutineRun['status'], summary: string, trigger: RoutineRun['trigger'] = 'schedule'): RoutineRun => {
    const startedAt = now - daysAgo * 24 * HOUR - 2 * HOUR
    return { id, routineId: 'r-brief', botId: 'b-atlas', trigger, status, startedAt, endedAt: startedAt + 48_000, conversationId: 'c-atlas', summary }
  }
  const runs: RoutineRun[] = [
    run('run-1', 1, 'done', '1. Ship the routines PR. 2. Reply to the two open issues about Windows paths. 3. Prepare the demo for Thursday.'),
    run('run-2', 2, 'done', '1. Review the Codex sandbox fix. 2. Draft the README demo section. 3. Book the meeting with the design partner.'),
    run('run-3', 3, 'skipped', 'Missed: faibots was not running at the planned time.', 'catch-up'),
    run('run-4', 4, 'error', 'The GitHub connector did not answer in time.')
  ]
  return { routines, runs }
}

function seedUsage(now: number, bots: Bot[]): UsageRow[] {
  const rows: UsageRow[] = []
  const pattern: Record<string, [number, number, number]> = {
    // turns per day, automatic share, tokens per turn
    'b-atlas': [9, 0.4, 5200],
    'b-iris': [5, 0.2, 7400],
    'b-rex': [4, 0.25, 6100],
    'b-juno': [2, 0, 3300]
  }
  for (let d = 6; d >= 0; d--) {
    const date = new Date(now - d * 24 * HOUR)
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    for (const bot of bots) {
      const p = pattern[bot.id]
      if (!p) continue
      const wobble = ((d * 7 + bot.id.length * 3) % 5) - 2
      const turns = Math.max(1, p[0] + wobble)
      rows.push({
        botId: bot.id,
        day,
        providerId: bot.model.providerId,
        modelId: bot.model.modelId,
        turns,
        automaticTurns: Math.round(turns * p[1]),
        errors: d === 4 && bot.id === 'b-atlas' ? 1 : 0,
        inputTokens: turns * p[2],
        outputTokens: Math.round(turns * p[2] * 0.12)
      })
    }
  }
  return rows
}

function fact(id: Id, botId: Id, text: string, pinned: boolean, createdBy: 'bot' | 'user', at: number): MemoryFact {
  return { id, botId, tier: 'log', text, pinned, createdBy, createdAt: at, updatedAt: at }
}

function skill(
  id: Id,
  name: string,
  description: string,
  source: SkillWithBody['source'],
  at: number,
  extra: Partial<SkillWithBody> & { body: string }
): SkillWithBody {
  return {
    id,
    name,
    description,
    source,
    dir: `${DATA_DIR}\\skills\\${name}`,
    readOnly: false,
    updatedAt: at,
    resources: [],
    ...extra
  }
}

function tool(
  name: string,
  description: string,
  source: MockTool['source'],
  defaultPermission: PermissionMode,
  autoAllowedInWorkspace = false
): MockTool {
  return { name, description, source, defaultPermission, ...(autoAllowedInWorkspace && { autoAllowedInWorkspace: true }) }
}

function mcpServer(id: Id, name: string, p: Partial<McpServerConfig> & Pick<McpServerConfig, 'transport'>, at: number): McpServerConfig {
  return { id, name, enabled: true, disabledTools: [], customInstructions: '', createdAt: at, updatedAt: at, ...p }
}

function provider(id: Id, kind: ProviderConfig['kind'], label: string, p: Partial<ProviderConfig>, at: number): ProviderConfig {
  return { id, kind, label, hasApiKey: false, defaultModelId: '', enabled: true, createdAt: at, updatedAt: at, ...p }
}
