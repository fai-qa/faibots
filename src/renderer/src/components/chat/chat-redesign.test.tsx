/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Bot, Entry, ToolCallInfo } from '@shared/domain'
import type { ExchangeMessage, ExchangeSummary } from '@shared/exchange-activity'
import { Composer } from '../composer/Composer'
import { TOOLS_TAB_STANDING_LINE, ToolsTab } from '../details/ToolsTab'
import { useData } from '../../store/data'
import { dmHeaderRole } from './ChatView'
import { ChatTrail } from './ChatTrail'
import { eventLineText, EventLine } from './EventLine'
import { RelayRow } from './ExchangeActivity'
import { installTestDom } from './test-dom'
import { ToolCallRow } from './ToolCallRow'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../..')
const RAW_TOOL = /update_memory|send_to_agent|pass_turn|mcp__|claude-opus-5-5|gpt-5/
const AMBER = /#(?:f28a2e|b25e00|f2a15c|ffb35c|f49b61|edc18c)|rgba\(\s*242\s*,\s*(?:138|161)\s*,\s*(?:46|92)/i
const PURPLE = /#(?:cfaff5|a651f0)/i

function bot(partial: Partial<Bot> & Pick<Bot, 'id' | 'name'>): Bot {
  return {
    handle: partial.name.toLowerCase(),
    label: 'Chief of staff',
    description: '',
    soul: '',
    avatar: { shape: 'squircle', color: 'blue' },
    model: { providerId: 'p-anthropic', modelId: 'claude-opus-5-5' },
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

function entry(partial: Partial<Entry> & Pick<Entry, 'kind' | 'author'>): Entry {
  return {
    id: 'e1',
    conversationId: 'c1',
    seq: 1,
    text: '',
    mentions: [],
    mentionsEveryone: false,
    attachments: [],
    isStreaming: false,
    createdAt: 1_000,
    updatedAt: 6_000,
    ...partial
  }
}

const fai = bot({ id: 'b-fai', name: 'fai', handle: 'fai', isPrimary: true, avatar: { shape: 'squircle', color: 'blue' } })
const iris = bot({ id: 'b-iris', name: 'Iris', handle: 'iris', label: 'Research', avatar: { shape: 'egg', color: 'violet' } })
const juno = bot({ id: 'b-juno', name: 'Juno', label: 'Writing, marketing', avatar: { shape: 'cloud', color: 'orange' } })

const question = 'What did you find on competitor pricing for the launch? Alex wants a short summary.'
const answer = 'Short version:\n\n- Northwind: $10 per seat.\n\nTwo of three charge per seat.'
const resultText = 'Two of the three charge per seat; one charges per workspace. Median price is $12 per seat per month.'

const call: ToolCallInfo = {
  callId: 'call-x-1',
  toolName: 'send_to_agent',
  title: 'Messaged Iris',
  input: { to: '@iris', message: question },
  status: 'done',
  resultText
}

const summary: ExchangeSummary = {
  anchorId: 'e-call',
  callerId: fai.id,
  botIds: [fai.id, iris.id],
  messageCount: 2,
  active: false
}

const messages: ExchangeMessage[] = [
  { id: 'm1', conversationId: 'x1', authorId: fai.id, recipientId: iris.id, text: question, createdAt: 1, isStreaming: false },
  { id: 'm2', conversationId: 'x1', authorId: iris.id, recipientId: fai.id, text: answer, createdAt: 2, isStreaming: false }
]

const bots = new Map([[fai.id, fai], [iris.id, iris], [juno.id, juno]])

function relay(open: boolean) {
  return renderToStaticMarkup(
    <RelayRow row={summary} bots={bots} call={call} messages={messages} defaultOpen={open} />
  )
}

describe('exchange relay', () => {
  it('stays about a message tall and uses only the real summary when collapsed', () => {
    const html = relay(false)
    expect(html).toContain('fai')
    expect(html).toContain('to')
    expect(html).toContain('Iris')
    expect(html).toContain('2 messages with Iris')
    expect(html).toContain('Messaged Iris')
    expect(html).toContain('Two of the three charge per seat; one charges per workspace.')
    expect(html).not.toContain('Short version')
    expect(html).not.toContain(question)
    expect(html).not.toContain('Idle')
    expect(html).not.toContain('Ready for a task')
    expect(html).not.toContain('lost')
    expect(html).not.toMatch(RAW_TOOL)
    expect(html).toContain('aria-label="Open bot conversation: 2 messages with Iris"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Show')
  })

  it('expands to the real question and answer and nothing else', () => {
    const html = relay(true)
    expect(html).toContain(question)
    expect(html).toContain('Northwind')
    expect(html).toContain('Two of three charge per seat.')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Hide')
    expect(html).toContain('aria-label="Hide the messages with Iris"')
    const items = html.match(/data-relay-line/g) ?? []
    expect(items).toHaveLength(2)
    expect(html).not.toContain('Idle')
    expect(html).not.toContain('Ready for a task')
    expect(html).not.toMatch(RAW_TOOL)
  })

  it('closes on Escape and returns focus to the toggle', async () => {
    installTestDom()
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const rootNode = createRoot(host)
    await act(async () => {
      rootNode.render(<RelayRow row={summary} bots={bots} call={call} messages={messages} />)
    })
    const button = host.querySelector('button')
    expect(button).toBeTruthy()
    button?.focus()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(button?.getAttribute('aria-expanded')).toBe('true')
    const region = host.querySelector('[role="region"]')
    expect(region?.textContent).toContain(question)
    expect(region?.textContent).toContain('Northwind')
    ;(region as HTMLElement | null)?.focus()
    expect(document.activeElement).toBe(region)
    await act(async () => {
      region?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(button?.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button)
    expect(host.textContent).not.toContain(question)
    await act(async () => {
      rootNode.unmount()
    })
  })
})

describe('chat copy', () => {
  it('says a bot had nothing to add', async () => {
    useData.setState({ bots: [juno], botMap: new Map([[juno.id, juno]]) })
    const passed = entry({
      kind: 'event',
      author: { kind: 'bot', botId: juno.id },
      text: 'Juno passed'
    })
    expect(eventLineText(passed, 'Juno')).toBe('Juno had nothing to add')
    const tool = entry({
      kind: 'tool-call',
      author: { kind: 'bot', botId: juno.id },
      text: 'Juno passed',
      toolCall: { callId: 'p1', toolName: 'pass_turn', title: 'Passing', input: {}, status: 'done' }
    })
    expect(eventLineText(tool, 'Juno')).toBe('Juno had nothing to add')
    installTestDom()
    const { createRoot } = await import('react-dom/client')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const rootNode = createRoot(host)
    await act(async () => {
      rootNode.render(<EventLine entry={passed} />)
    })
    expect(host.textContent).toContain('Juno had nothing to add')
    expect(host.textContent).not.toContain('passed')
    await act(async () => {
      rootNode.render(<EventLine entry={tool} />)
    })
    expect(host.textContent).toContain('Juno had nothing to add')
    expect(host.textContent).not.toMatch(RAW_TOOL)
    await act(async () => {
      rootNode.unmount()
    })
  })

  it('tells people where Always allow and Never allow live', () => {
    const html = renderToStaticMarkup(<ToolsTab bot={fai} />)
    expect(html).toContain(TOOLS_TAB_STANDING_LINE)
    expect(TOOLS_TAB_STANDING_LINE).toBe('Choose Always allow or Never allow here. It applies to this bot only.')
  })

  it('keeps the Send control as an icon button named Send message', () => {
    const html = renderToStaticMarkup(
      <Composer draftKey="t" placeholder="Message fai" members={[]} allowEveryone={false} onSend={() => undefined} />
    )
    expect(html).toContain('aria-label="Send message"')
    expect(html).not.toContain('>Send<')
  })

  it('shows a bot role in the header and no model id on a tool card or trail', () => {
    expect(dmHeaderRole(fai)).toBe('Chief of staff')
    expect(dmHeaderRole({ ...fai, label: 'Main bot' })).toBeUndefined()
    const memory = entry({
      kind: 'tool-call',
      author: { kind: 'bot', botId: fai.id },
      toolCall: {
        callId: 'mem',
        toolName: 'update_memory',
        title: 'Saved to memory',
        input: { content: 'Launch is planned for Thursday.' },
        status: 'done',
        resultText: 'Saved: Launch is planned for Thursday.'
      }
    })
    const card = renderToStaticMarkup(<ToolCallRow entry={memory} />)
    expect(card).toContain('Saved to memory')
    expect(card).not.toMatch(RAW_TOOL)
    const trail = renderToStaticMarkup(
      <ChatTrail bot={fai} entries={[memory]} title="Can you keep an eye on the launch checklist this week?" />
    )
    expect(trail).toContain('Saved to memory')
    expect(trail).toContain('fai')
    expect(trail).toContain('Can you keep an eye on the launch checklist this week?')
    expect(trail).not.toMatch(RAW_TOOL)
  })
})

describe('dark affectUI theme', () => {
  const css = readFileSync(resolve(root, 'src/renderer/src/index.css'), 'utf8')
  const card = readFileSync(resolve(root, 'src/renderer/src/components/ui/tool-call-card-clean.tsx'), 'utf8')
  const trail = readFileSync(resolve(root, 'src/renderer/src/components/ui/agent-trail-clean.tsx'), 'utf8')

  it('overrides every amber, orange or purple affectUI token used in dark mode', () => {
    const names = new Set<string>()
    for (const source of [card, trail]) {
      for (const line of source.split('\n')) {
        if (!AMBER.test(line) && !PURPLE.test(line) && !line.includes('--aui-orange') && !line.includes('--aui-warning')) continue
        const assigned = /(--[\w-]+)\s*:/.exec(line)
        if (assigned?.[1]) names.add(assigned[1])
      }
    }
    expect(names.size).toBeGreaterThan(0)
    expect(css).toMatch(/--aui-orange:\s*#2868f0/)
    expect(css).toMatch(/--aui-warning:\s*#8eb3ff/)
    for (const name of names) {
      const rule = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*([^;]+);`, 'g')
      const values = [...css.matchAll(rule)].map((match) => match[1] ?? '')
      expect(values.length, name).toBeGreaterThan(0)
      expect(values.some((value) => !AMBER.test(value) && !PURPLE.test(value) && !value.includes('--aui-orange') && !value.includes('--aui-warning')), name).toBe(true)
    }
  })

  it('turns the new relay motion off when reduced motion is requested', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.handoff-relay\s*\{\s*animation:\s*none/)
    expect(card).toContain('@media (prefers-reduced-motion: reduce)')
    expect(trail).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

describe('tool call card registry', () => {
  it('matches the fetched affectUI file byte for byte', () => {
    const file = readFileSync(resolve(root, 'src/renderer/src/components/ui/tool-call-card-clean.tsx'))
    expect(createHash('sha256').update(file).digest('hex')).toBe('cc8f4c7a581e0c7fd7d05faa63122d06d01542e71c4df75dd0a88f1365c839ff')
  })
})
