import { parseSkillFile, stringField } from './frontmatter'

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILL_NAME = 64
export const MAX_SKILL_DESCRIPTION = 1024

/** "Weekly Report (v2)" -> "weekly-report-v2". Empty when nothing usable is left. */
export function slugifySkillName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_NAME)
    .replace(/-+$/, '')
}

/** First "# Heading" line of a Markdown body. */
export function firstHeading(body: string): string | undefined {
  return /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)?.[1]?.trim() || undefined
}

/** First prose paragraph, used as a description when an imported file has none. */
export function firstParagraph(body: string, max = 300): string | undefined {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim()
    if (!text || /^(#|```|---|\||<)/.test(text)) continue
    const flat = text.replace(/\s+/g, ' ')
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
  }
  return undefined
}

/**
 * Name for an imported file: frontmatter `name`, else the folder for SKILL.md, else the first
 * `# H1`, else the file name (BUILD-PLAN order).
 */
export function importName(filePath: string, text: string): string {
  const { data, body } = parseSkillFile(text)
  const candidates = [
    stringField(data, 'name'),
    fileName(filePath).toLowerCase() === 'skill.md' ? fileName(parentOf(filePath)) : undefined,
    firstHeading(body),
    fileName(filePath).replace(/\.[^.]*$/, '')
  ]
  for (const candidate of candidates) {
    const slug = candidate ? slugifySkillName(candidate) : ''
    if (slug) return slug
  }
  return 'skill'
}

// Separator-agnostic, so a Windows path names the same skill wherever the code runs.
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? ''
const parentOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '')

/** name, name-2, name-3 … until `taken` says no. */
export function uniqueName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${base.slice(0, MAX_SKILL_NAME - suffix.length).replace(/-+$/, '')}${suffix}`
    if (!taken(candidate)) return candidate
  }
}
