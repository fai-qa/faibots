import { describe, expect, it } from 'vitest'
import type { ApprovalInfo } from '@shared/domain'
import { approvalOutcome } from './tools'

describe('approvalOutcome', () => {
  const request = { approvalId: 'request', toolName: 'read_file', summary: 'Read a file', input: {} }

  it.each([
    ['pending', undefined, 'Needs your approval', false],
    ['expired', undefined, 'Approval expired', false],
    ['resolved', 'never', 'Never allowed', false],
    ['resolved', 'allow_once', 'Allowed once', true]
  ] satisfies [ApprovalInfo['status'], ApprovalInfo['decision'], string, boolean][])(
    'uses the recorded %s state in the sidebar and card',
    (status, decision, label, allowed) => {
      expect(approvalOutcome({ ...request, status, decision })).toEqual({ label, allowed })
    }
  )
})
