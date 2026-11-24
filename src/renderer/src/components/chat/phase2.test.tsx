/// <reference types="node" />
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, Conversation, Entry } from '@shared/domain'

const resolveApproval = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../store/actions', () => ({ resolveApproval }))

import { APPROVAL_EMPTY_COMMAND, ApprovalCard } from './ApprovalCard'
import { overviewGraph, overviewLines, WhoSaidWhatView } from './WhoSaidWhat'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..')
const AMBER = /#(?:f28a2e|b25e00|f2a15c|ffb35c|e6c24d|8f6c00|fbf5e2|5fc88a|ffb35c)|#fb6a00|#ff9c00|aui-amber|aui-orange|aui-warning|aui-green/i

function bot(partial: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    handle: partial.name.toLowerCase(),
    label: 'Research',
    description: '',
    soul: '',
    avatar: { shape: 'egg', color: 'violet' },
    model: { providerId: 'p', modelId: 'claude-opus-5-5' },
    isPrimary: false,
    toolPermissions: {},
    mcpServerIds: 'all',
    skillIds: [],
    notify: true,
    dailyRunLimit: 0,
    pinned: false,
    hidden: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial
  }
}

function approvalEntry(input: unknown): Entry {
  return {
    id: 'e-ap',
    conversationId: 'c1',
    seq: 1,
    kind: 'approval',
    author: { kind: 'bot', botId: 'b-fai' },
    text: 'Run the test suite before we ship.',
    mentions: [],
    mentionsEveryone: false,
    attachments: [],
    isStreaming: false,
    createdAt: 1,
    updatedAt: 1,
    approval: {
      approvalId: 'ap-1',
      toolName: 'shell',
      summary: 'Run the test suite before we ship.',
      input,
      status: 'pending'
    }
  }
}

const fai = bot({ id: 'b-fai', name: 'fai', label: 'Chief of staff', isPrimary: true, avatar: { shape: 'squircle', color: 'blue' } })
const iris = bot({ id: 'b-iris', name: 'Iris', label: 'Research' })
const juno = bot({ id: 'b-juno', name: 'Juno', label: 'Writing, marketing', avatar: { shape: 'cloud', color: 'orange' } })
const bots = new Map([[fai.id, fai], [iris.id, iris], [juno.id, juno]])
const conv: Conversation = {
  id: 'g1',
  kind: 'group',
  botIds: [fai.id, iris.id, juno.id],
  title: 'Launch crew',
  notes: '',
  lastEntryAt: 0,
  unreadCount: 0,
  createdAt: 0,
  updatedAt: 0
}

function message(id: string, author: Entry['author'], text: string): Entry {
  return {
    id,
    conversationId: conv.id,
    seq: 1,
    kind: 'message',
    author,
    text,
    mentions: [],
    mentionsEveryone: false,
    attachments: [],
    isStreaming: false,
    createdAt: 10,
    updatedAt: 10
  }
}

const entries: Entry[] = [
  message('m-you', { kind: 'user' }, "Quick sync: what's left before Thursday?"),
  message('m-fai', { kind: 'bot', botId: fai.id }, 'From my side the checklist is 7 of 10 done.'),
  {
    ...message('m-pass', { kind: 'bot', botId: juno.id }, 'Juno passed'),
    kind: 'event'
  }
]

describe('approval card', () => {
  beforeEach(() => resolveApproval.mockClear())

  it('shows only Allow once and Deny, and the real command', () => {
    const html = renderToStaticMarkup(<ApprovalCard entry={approvalEntry({ command: 'npm test', cwd: 'C:\\work' })} conversationBotIds={['b-fai']} />)
    expect(html).toContain('Allow once')
    expect(html).toContain('Deny')
    expect(html).toContain('npm test')
    expect(html).toContain('Running a command')
    expect(html).not.toContain('type="checkbox"')
    expect(html).not.toContain('Never allow')
    expect(html).not.toContain('>shell<')
    expect(html).not.toContain('exact command shown here')
  })

  it('says when the request has no command', () => {
    const html = renderToStaticMarkup(<ApprovalCard entry={approvalEntry({})} conversationBotIds={['b-fai']} />)
    expect(html).toContain(APPROVAL_EMPTY_COMMAND)
    expect(html).not.toContain('npm test')
    expect(html).not.toContain('exact command shown here')
  })

  it('calls the existing allow and deny handlers', async () => {
    const { installTestDom } = await import('./test-dom')
    installTestDom()
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const view = createRoot(host)
    await act(async () => {
      view.render(<ApprovalCard entry={approvalEntry({ command: 'npm test' })} conversationBotIds={['b-fai']} />)
    })
    const buttons = [...host.querySelectorAll('button')]
    const allow = buttons.find((button) => button.textContent?.includes('Allow once'))
    const deny = buttons.find((button) => button.textContent?.includes('Deny'))
    expect(allow).toBeTruthy()
    expect(deny).toBeTruthy()
    await act(async () => {
      allow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(resolveApproval).toHaveBeenCalledWith('ap-1', 'allow_once')
    await act(async () => {
      view.render(<ApprovalCard key="deny" entry={approvalEntry({ command: 'npm test' })} conversationBotIds={['b-fai']} />)
    })
    const denyAgain = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Deny'))
    await act(async () => {
      denyAgain?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(resolveApproval).toHaveBeenCalledWith('ap-1', 'deny')
    await act(async () => {
      view.unmount()
    })
  })
})

describe('who said what', () => {
  const lines = overviewLines(entries, bots)
  const graph = overviewGraph(conv, bots, entries, new Map())

  it('defaults to the list of real lines', () => {
    const html = renderToStaticMarkup(
      <WhoSaidWhatView title="Launch crew" lines={lines} graph={graph} onMap={() => undefined} onBack={() => undefined} />
    )
    expect(html).toContain('Who said what')
    expect(html).toContain('This conversation, in order.')
    expect(html).toContain('Show as map')
    expect(html).toContain('Quick sync:')
    expect(html).toContain('Thursday?')
    expect(html).toContain('Juno had nothing to add')
    expect(html).not.toContain('ui-aggc')
    expect(html).not.toContain('claude-opus')
    expect(html).not.toContain('send_to_agent')
    expect(html).not.toContain('passed')
  })

  it('shows the map of the real bots when asked', () => {
    const html = renderToStaticMarkup(
      <WhoSaidWhatView title="Launch crew" lines={lines} graph={graph} map onMap={() => undefined} onBack={() => undefined} />
    )
    expect(html).toContain('Show as list')
    expect(html).toContain('3 bots')
    expect(html).toContain('ui-aggc')
    expect(html).toContain('fai')
    expect(html).toContain('Iris')
    expect(html).toContain('Juno')
    expect(html).not.toContain('Nova')
    expect(graph.nodes.map((node) => node.name).sort()).toEqual(['Iris', 'Juno', 'You', 'fai'])
    expect(graph.calls.map((call) => call.label)).toEqual([
      "Quick sync: what's left before Thursday?",
      'From my side the checklist is 7 of 10 done.'
    ])
  })
})

describe('phase 2 affectUI files', () => {
  const css = readFileSync(resolve(root, 'src/renderer/src/index.css'), 'utf8')

  it('keeps the registry source plus the notice line', () => {
    for (const [file, contentHash] of [
      ['approval-card-clean.tsx', '577061d34c9e36592a8428b753ae3390097d7e5b8d3afd0aa3663596a6641d22'],
      ['agent-graph-clean.tsx', '45f29a28b3f039255efd8fac4d8616774b3b978398dd7804852dc2402142d1f6']
    ] as const) {
      const text = readFileSync(resolve(root, 'src/renderer/src/components/ui', file), 'utf8')
      const body = text.split('\n').slice(1).join('\n')
      expect(text.startsWith("// affectUI Pro – licensed under https://www.affectui.com/license")).toBe(true)
      expect(createHash('sha256').update(body).digest('hex')).toBe(contentHash)
    }
  })

  it('overrides amber and stops motion for the approval card and the graph', () => {
    for (const file of ['approval-card-clean.tsx', 'agent-graph-clean.tsx']) {
      const source = readFileSync(resolve(root, 'src/renderer/src/components/ui', file), 'utf8')
      expect(source).toContain('@media (prefers-reduced-motion: reduce)')
      for (const line of source.split('\n')) {
        if (!AMBER.test(line)) continue
        const assigned = /(--[\w-]+)\s*:/.exec(line)
        if (!assigned?.[1]) continue
        const rule = new RegExp(`${assigned[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+);`, 'g')
        const values = [...css.matchAll(rule)].map((match) => match[1] ?? '')
        expect(values.length, `${file} ${assigned[1]}`).toBeGreaterThan(0)
        expect(
          values.some((value) => !AMBER.test(value)),
          `${file} ${assigned[1]} ${values.join(' | ')}`
        ).toBe(true)
      }
    }
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/)
  })
})
