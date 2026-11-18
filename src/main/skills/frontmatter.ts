// SKILL.md = YAML frontmatter (name, description, plus any keys other tools use) + Markdown body.
// Rewrites go through yaml's Document so unknown keys and comments survive.

import { Document, isMap, parseDocument } from 'yaml'

export interface ParsedSkill {
  /** Frontmatter as plain data; empty when there is none or it does not parse. */
  data: Record<string, unknown>
  body: string
  /** Raw frontmatter text, kept for rewriting. */
  frontmatter?: string
}

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function parseSkillFile(text: string): ParsedSkill {
  const match = FRONTMATTER.exec(text)
  if (!match) return { data: {}, body: text.replace(/^﻿/, '') }
  const frontmatter = match[1]!
  const body = text.slice(match[0].length).replace(/^\r?\n/, '')
  try {
    const doc = parseDocument(frontmatter)
    const data = doc.errors.length === 0 && isMap(doc.contents) ? (doc.toJS() as Record<string, unknown>) : {}
    return { data, body, frontmatter }
  } catch {
    return { data: {}, body, frontmatter }
  }
}

/** Render SKILL.md, keeping the existing frontmatter's other keys when rewriting. */
export function renderSkillFile(input: { name: string; description: string; body: string; previous?: string }): string {
  let doc: Document | undefined
  if (input.previous !== undefined) {
    const old = parseSkillFile(input.previous)
    if (old.frontmatter !== undefined) {
      const parsed = parseDocument(old.frontmatter)
      if (parsed.errors.length === 0 && isMap(parsed.contents)) doc = parsed
    }
  }
  if (doc) {
    doc.set('name', input.name)
    doc.set('description', input.description)
  } else {
    doc = new Document({ name: input.name, description: input.description })
  }
  const yaml = doc.toString({ lineWidth: 0 }).trimEnd()
  const body = input.body.replace(/^\s*\n/, '').trimEnd()
  return `---\n${yaml}\n---\n\n${body}\n`
}

export const stringField = (data: Record<string, unknown>, key: string): string | undefined => {
  const value = data[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
