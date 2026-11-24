import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { seedMockData } from '../../lib/mock-seed'
import { Composer } from './Composer'

it('shows direct-model setup for a DM and leaves a one-member group composer available', () => {
  const props = {
    draftKey: 'fixture',
    members: [seedMockData(0).bots[0]!],
    placeholder: 'Write a message',
    onSend: () => {}
  }

  const direct = renderToStaticMarkup(createElement(Composer, { ...props, allowEveryone: false }))
  const group = renderToStaticMarkup(createElement(Composer, { ...props, allowEveryone: true }))

  expect(direct).toContain('Open provider settings')
  expect(group).not.toContain('Open provider settings')
  expect(group).toContain('Write a message')
})
