import { expect, it } from 'vitest'
import type { SessionSource } from '@shared/project-sessions'
import { lookupEvidence } from './evidence-lookup'

it('matches a spoken Arabic price question to selected notes and preserves the original quotation', () => {
  const pin: SessionSource = { itemId: 'i', sourceId: 's', name: 'ملاحظات.txt', revision: 1, sha256: 'a'.repeat(64) }
  const same = 'السِّعـر: ٤٨٠ QAR\nالسعر: 480 QAR\nما تبقى: قرار لاحق'
  const lookup = (text: string) => lookupEvidence('يعني ما هو السعر؟', [pin], () => text)
  const result = lookup(same)
  expect(result.status).toBe('found')
  expect(result.citations.map(c => c.excerpt)).toEqual(same.split('\n').slice(0, 2))
  expect(lookup(same + '\nالسعر: ٤٩٠ QAR').status).toBe('conflict')
  expect(lookup('موعد اللقاء: الأربعاء').status).toBe('unavailable')
})
