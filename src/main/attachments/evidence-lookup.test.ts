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

it('links the lines recording the same value across documents, retaining a different sign as a disagreement',()=>{
  const sources = ['estimate','ledger','adjustment'].map((name,i)=>({name,itemId:name,sourceId:name,revision:1,sha256:String(i).repeat(64)}))
  const evidence = ['Balance: 20 QAR','Balance: ٢٠ QAR','Balance: -20 QAR']
  const answer = lookupEvidence('balance',sources,s=>evidence[sources.indexOf(s)]!)
  expect(answer.relationships).toEqual([{field:'balance',values:[{value:'20 qar',citationIndexes:[0,1]},{value:'-20 qar',citationIndexes:[2]}]}])
  expect(answer.citations.map(c=>[c.source.name,c.line])).toEqual([['estimate',1],['ledger',1],['adjustment',1]])
})
