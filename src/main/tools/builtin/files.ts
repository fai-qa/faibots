// read_file, list_dir, write_file, edit_file. Inside the bot's workspace they run without asking;
// elsewhere they follow the tool's resolved permission (default ask). Reads are also free inside
// the folders of skills the bot can use, so it can open a skill's resource files.

import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../../contracts'
import { defineTool, errorResult, textResult } from '../define'
import { isReallyInside, resolveToolPath } from '../paths'

const DEFAULT_LINE_LIMIT = 2000
const MAX_LINE_CHARS = 2000
const MAX_TEXT_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_DIR_ENTRIES = 500
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'
}

export interface FileToolDeps {
  homeDir: string
  /** Folders of the skills this bot can use. */
  skillDirsForBot(botId: string): string[]
}

const where = (p: string, ctx: ToolContext, homeDir: string) => resolveToolPath(p, ctx.workspaceDir, homeDir)
const inWorkspace = (path: string, ctx: ToolContext) => isReallyInside(path, ctx.workspaceDir)

function looksBinary(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

const countLines = (text: string) => (text === '' ? 0 : text.split(/\r?\n/).length)

export function fileTools(deps: FileToolDeps) {
  const readable = (path: string, ctx: ToolContext) =>
    inWorkspace(path, ctx) || deps.skillDirsForBot(ctx.bot.id).some((dir) => isReallyInside(path, dir))

  const readFile = defineTool({
    name: 'read_file',
    description:
      'Read a text file (or an image) from the user\'s computer. Relative paths start at your workspace. ' +
      `Returns up to ${DEFAULT_LINE_LIMIT} lines; use offset and limit for long files.`,
    schema: z.object({
      path: z.string().min(1).describe('File path; relative paths start at your workspace, ~ is the home folder'),
      offset: z.number().int().min(1).optional().describe('First line to return (1-based)'),
      limit: z.number().int().min(1).max(10_000).optional().describe('How many lines to return')
    }),
    source: 'builtin',
    defaultPermission: 'ask',
    autoAllowedInWorkspace: true,
    activityLabel: 'Reading a file',
    summarize: (input, ctx) => `Read ${where(input.path, ctx, deps.homeDir)}`,
    autoAllow: (input, ctx) => readable(where(input.path, ctx, deps.homeDir), ctx),
    async execute(input, ctx) {
      const path = where(input.path, ctx, deps.homeDir)
      if (!existsSync(path)) return errorResult(`${path} does not exist.`)
      const stat = statSync(path)
      if (stat.isDirectory()) return errorResult(`${path} is a folder; use list_dir.`)

      const imageType = IMAGE_TYPES[extname(path).toLowerCase()]
      if (imageType) {
        if (stat.size > MAX_IMAGE_BYTES) return errorResult(`${path} is an image of ${stat.size} bytes; the limit is ${MAX_IMAGE_BYTES}.`)
        return {
          content: [
            { type: 'text', text: `Image ${path} (${stat.size} bytes)` },
            { type: 'image', mediaType: imageType, dataBase64: readFileSync(path).toString('base64') }
          ]
        }
      }
      if (stat.size > MAX_TEXT_BYTES) return errorResult(`${path} is ${stat.size} bytes; too big to read here. Use shell to look at parts of it.`)
      if (looksBinary(path)) return errorResult(`${path} is a binary file (${stat.size} bytes) and cannot be shown as text.`)

      const lines = readFileSync(path, 'utf8').replace(/^﻿/, '').split(/\r?\n/)
      const start = (input.offset ?? 1) - 1
      if (start >= lines.length && lines.length > 0) return errorResult(`${path} has only ${lines.length} lines.`)
      const slice = lines.slice(start, start + (input.limit ?? DEFAULT_LINE_LIMIT))
        .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… (line cut)` : line))
      const end = start + slice.length
      const header = end < lines.length || start > 0
        ? `${path} (lines ${start + 1}-${end} of ${lines.length})`
        : `${path} (${lines.length} lines)`
      return textResult(`${header}\n${slice.join('\n')}`)
    }
  })

  const listDir = defineTool({
    name: 'list_dir',
    description: 'List the files and folders in a folder. Relative paths start at your workspace; "." is the workspace itself.',
    schema: z.object({ path: z.string().min(1).describe('Folder path') }),
    source: 'builtin',
    defaultPermission: 'ask',
    autoAllowedInWorkspace: true,
    activityLabel: 'Looking through files',
    summarize: (input, ctx) => `List ${where(input.path, ctx, deps.homeDir)}`,
    autoAllow: (input, ctx) => readable(where(input.path, ctx, deps.homeDir), ctx),
    async execute(input, ctx) {
      const path = where(input.path, ctx, deps.homeDir)
      if (path === ctx.workspaceDir) mkdirSync(path, { recursive: true })
      if (!existsSync(path)) return errorResult(`${path} does not exist.`)
      if (!statSync(path).isDirectory()) return errorResult(`${path} is a file; use read_file.`)
      const entries = readdirSync(path, { withFileTypes: true })
        .map((e) => {
          if (e.isDirectory()) return { name: `${e.name}/`, dir: true }
          let size = ''
          try {
            size = ` (${statSync(join(path, e.name)).size} bytes)`
          } catch {
            // broken link or no access
          }
          return { name: `${e.name}${size}`, dir: false }
        })
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      if (entries.length === 0) return textResult(`${path} is empty.`)
      const shown = entries.slice(0, MAX_DIR_ENTRIES).map((e) => e.name)
      const more = entries.length > MAX_DIR_ENTRIES ? `\n… and ${entries.length - MAX_DIR_ENTRIES} more` : ''
      return textResult(`${path}\n${shown.join('\n')}${more}`)
    }
  })

  const writeFile = defineTool({
    name: 'write_file',
    description: 'Create or overwrite a text file with the given content. Missing folders are created. Relative paths start at your workspace.',
    schema: z.object({
      path: z.string().min(1).describe('File path'),
      content: z.string().describe('The complete new content of the file')
    }),
    source: 'builtin',
    defaultPermission: 'ask',
    autoAllowedInWorkspace: true,
    activityLabel: 'Writing a file',
    summarize: (input, ctx) => {
      const path = where(input.path, ctx, deps.homeDir)
      return `${existsSync(path) ? 'Overwrite' : 'Create'} ${path} (${countLines(input.content)} lines)`
    },
    autoAllow: (input, ctx) => inWorkspace(where(input.path, ctx, deps.homeDir), ctx),
    async execute(input, ctx) {
      const path = where(input.path, ctx, deps.homeDir)
      if (existsSync(path) && statSync(path).isDirectory()) return errorResult(`${path} is a folder.`)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, input.content, 'utf8')
      return textResult(`Wrote ${countLines(input.content)} lines (${Buffer.byteLength(input.content)} bytes) to ${path}.`)
    }
  })

  const editFile = defineTool({
    name: 'edit_file',
    description:
      'Replace exact text in a file. old_text must match the file exactly (including spaces) and be unique, ' +
      'unless replace_all is true. Read the file first.',
    schema: z.object({
      path: z.string().min(1).describe('File path'),
      old_text: z.string().min(1).describe('Exact text to find'),
      new_text: z.string().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace every occurrence instead of exactly one')
    }),
    source: 'builtin',
    defaultPermission: 'ask',
    autoAllowedInWorkspace: true,
    activityLabel: 'Editing a file',
    summarize: (input, ctx) => {
      const path = where(input.path, ctx, deps.homeDir)
      const preview = input.old_text.length > 80 ? `${input.old_text.slice(0, 80)}…` : input.old_text
      return `Edit ${path}: replace ${input.replace_all ? 'every' : 'one'} "${preview}"`
    },
    autoAllow: (input, ctx) => inWorkspace(where(input.path, ctx, deps.homeDir), ctx),
    async execute(input, ctx) {
      const path = where(input.path, ctx, deps.homeDir)
      if (!existsSync(path) || statSync(path).isDirectory()) return errorResult(`${path} is not a file.`)
      if (input.old_text === input.new_text) return errorResult('old_text and new_text are the same.')
      const original = readFileSync(path, 'utf8')

      let oldText = input.old_text
      let newText = input.new_text
      // Models write \n; Windows files often use \r\n.
      if (!original.includes(oldText) && original.includes('\r\n') && !oldText.includes('\r\n')) {
        oldText = oldText.replace(/\n/g, '\r\n')
        newText = newText.replace(/\r?\n/g, '\r\n')
      }
      const count = original.split(oldText).length - 1
      if (count === 0) return errorResult(`old_text was not found in ${path}. Read the file and copy the text exactly.`)
      if (count > 1 && !input.replace_all) {
        return errorResult(`old_text appears ${count} times in ${path}. Include more surrounding text, or set replace_all.`)
      }
      const updated = input.replace_all ? original.split(oldText).join(newText) : original.replace(oldText, () => newText)
      writeFileSync(path, updated, 'utf8')
      return textResult(`Replaced ${input.replace_all ? count : 1} occurrence${count > 1 && input.replace_all ? 's' : ''} in ${path}.`)
    }
  })

  return [readFile, listDir, writeFile, editFile]
}
