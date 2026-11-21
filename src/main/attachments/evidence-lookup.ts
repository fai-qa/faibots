import type { EvidenceCitation, ProjectAnswer, SessionSource } from '@shared/project-sessions'

type Findings = Pick<ProjectAnswer, 'citations' | 'conflicts' | 'omissions' | 'status'>
const normalize = (text: string) =>
  text
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const COMMON = new Set(
  'what which when does is are the for and our this that please tell me about from have'.split(' ')
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
  const claims = new Map<string, Map<string, EvidenceCitation>>()
  const omissions: string[] = []
  for (const source of sources) {
    let contents: string
    try {
      contents = read(source)
    } catch {
      omissions.push(`${source.name} r${source.revision} could not be verified or read.`)
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
      if (claim) {
        const key = normalize(claim[1]!).replace(/^the\s+/, '')
        const value = normalize(claim[2]!)
        if (key && value) {
          const values = claims.get(key) ?? new Map<string, EvidenceCitation>()
          if (!values.has(value)) values.set(value, citation)
          claims.set(key, values)
        }
      }
      matches++
      if (matches <= 5) citations.push(citation)
    }
    if (matches > 5)
      omissions.push(
        `${source.name} has ${matches} matching lines. The first five and any conflicting values are cited.`
      )
  }
  const conflicts = [...claims]
    .filter(([, values]) => values.size > 1)
    .map(([key, values]) => {
      for (const citation of values.values()) if (!citations.includes(citation)) citations.push(citation)
      return `${key} has conflicting values: ${[...values.keys()].join(' / ')}.`
    })
  return {
    status: conflicts.length ? 'conflict' : citations.length ? 'found' : 'unavailable',
    citations,
    conflicts,
    omissions
  }
}
