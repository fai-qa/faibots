import { expect, it } from 'vitest'
import { createMockBridge } from './mock-bridge'

it('shows the recorded research reason on the seeded assignment question only', async () => {
  const bridge = createMockBridge()
  const conversationId = 'c-atlas'
  const { entries } = await bridge.invoke('conv:entries', { conversationId })
  const anchor = entries.find(entry => entry.toolCall?.toolName === 'send_to_agent')!
  const scope = { conversationId, entryIds: [anchor.id] }
  const [summary] = await bridge.invoke('conv:exchange-summaries', scope)
  expect(summary?.messageCount).toBe(2)
  expect(summary).not.toHaveProperty('selectionReason')
  const { messages } = await bridge.invoke('conv:exchange-messages', scope)
  expect(messages.map(message => [message.recipientId, message.selectionReason])).toEqual([
    ['b-iris', 'Iris researched competitor pricing for this launch.'], ['b-atlas', undefined]
  ])
  expect(await bridge.invoke('conv:exchange-messages', { ...scope, conversationId: 'x-atlas-iris' })).toEqual({ messages: [] })
})
