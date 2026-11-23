import type { EvidenceCitation, EvidenceRelationship, ProjectAnswer, SessionSource } from '@shared/project-sessions'
import { UnreadablePdf } from './pdf-text'

type Findings = Pick<ProjectAnswer, 'citations' | 'conflicts' | 'omissions' | 'status'> & {relationships:EvidenceRelationship[]}
const fold = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize('NFKC')
    // Ignore Arabic vocalization and elongation for lookup. Keep original quotes for citations.
    .replace(/[\u0640\u064b-\u0652\u0670]/gu, '')
    .replace(/[٠-٩]/gu, (digit) => String(digit.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/gu, (digit) => String(digit.charCodeAt(0) - 0x6f0))
const normalize = (text: string) => fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
// Preserve signs, decimal points, currency, percentages and dates when comparing values.
const normalizedValue = (text: string) => fold(text).replace(/\s+/gu,' ').trim()
const COMMON = new Set(
  'what which when does is are the for and our this that please tell me about from have ما ماذا متى كيف هل هو هي في من عن يعني'.split(' ')
)

/** Search checked snapshots. A disagreement needs an identifiable shared field, never just a different excerpt. */
export function lookupEvidence(
  query: string,
  sources: SessionSource[],
  read: (source: SessionSource) => string
): Findings {
  const terms = [
    ...new Set(
      normalize(query)
        .split(' ')
        .filter((t) => t && !COMMON.has(t))
    )
  ]
  const citations: EvidenceCitation[] = []
  const claims = new Map<string, Map<string, Map<string,EvidenceCitation>>>()
  const omissions: string[] = []
  for (const source of sources) {
    let contents: string
    try {
      contents = read(source)
    } catch (error) {
      omissions.push(error instanceof UnreadablePdf ? `${source.name} r${source.revision}: ${error.message}` :
        `${source.name} r${source.revision} could not be verified or read.`)
      continue
    }
    const lines = contents.split(/\r?\n/)
    let matches = 0
    for (const [index, line] of lines.entries()) {
      const excerpt = line.trim()
      if (!excerpt) continue
      const normalized = normalize(excerpt)
      const words = new Set(normalized.split(' '))
      if (!terms.some((t) => words.has(t))) continue
      const citation = { source, line: index + 1, excerpt: excerpt.slice(0, 600) }
      const claim =
        /^\s*[-*#>\s]*([^:=]{1,100}?)\s*[:=]\s*(.+)$/u.exec(excerpt) ??
        /^(?:the\s+)?(.{1,100}?)\s+(?:is|will be|was set to)\s+(.+)$/iu.exec(excerpt)
      if (claim && excerpt.length > 600 && matches < 5)
        omissions.push(`${source.name} r${source.revision} line ${index+1} is longer than the quoted excerpt. Its full value was excluded from comparison.`)
      if (claim && excerpt.length <= 600) {
        const key = normalize(claim[1]!).replace(/^the\s+/, '')
        const value = normalizedValue(claim[2]!)
        if (key && value) {
          const values = claims.get(key) ?? new Map<string, Map<string,EvidenceCitation>>()
          const sources = values.get(value) ?? new Map<string,EvidenceCitation>()
          if (!sources.has(source.sourceId)) sources.set(source.sourceId,citation)
          values.set(value,sources)
          claims.set(key, values)
        }
      }
      matches++
      if (matches <= 5) citations.push(citation)
    }
    if (matches > 5)
      omissions.push(
        `${source.name} has ${matches} matching lines. The first five and lines linking recorded values are cited.`
      )
  }
  const conflicts: string[] = []
  const relationships: EvidenceRelationship[] = []
  const indexes = new Map(citations.map((citation,index)=>[citation,index]))
  for (const [field,values] of claims) {
    if (values.size === 1 && [...values.values()][0]!.size < 2) continue
    if (values.size > 1) conflicts.push(`${field} has conflicting values: ${[...values.keys()].join(' / ')}.`)
    relationships.push({field,values:[...values].map(([value,sources])=>({
      value, citationIndexes:[...sources.values()].map(citation=>{
        const found = indexes.get(citation)
        if (found !== undefined) return found
        const index = citations.push(citation)-1
        indexes.set(citation,index)
        return index
      })
    }))})
  }
  return {
    status: conflicts.length ? 'conflict' : citations.length ? 'found' : 'unavailable',
    citations,
    conflicts,
    relationships,
    omissions
  }
}
