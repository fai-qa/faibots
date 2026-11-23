// How tool calls and approvals read in the UI.

import {
  BookOpen,
  Brain,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  MessagesSquare,
  Plug,
  SkipForward,
  Terminal,
  UserPlus,
  Users,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { ApprovalDecision, ApprovalInfo } from '@shared/domain'

const APPROVAL_RESULTS: Record<ApprovalDecision, { label: string; allowed: boolean }> = {
  allow_once: { label: 'Allowed once', allowed: true },
  always: { label: 'Always allowed', allowed: true },
  deny: { label: 'Denied', allowed: false },
  never: { label: 'Never allowed', allowed: false }
}

export function approvalOutcome(approval?: ApprovalInfo): { label: string; allowed: boolean } {
  if (!approval) return { label: 'Approval request', allowed: false }
  if (approval.status === 'pending') return { label: 'Needs your approval', allowed: false }
  if (approval.status === 'expired') return { label: 'Approval expired', allowed: false }
  return (approval.decision && APPROVAL_RESULTS[approval.decision]) || { label: 'Answered', allowed: false }
}

export function parseMcpName(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? { server: m[1] ?? '', tool: m[2] ?? '' } : undefined
}

export function toolIcon(name: string): LucideIcon {
  if (name.startsWith('mcp__')) return Plug
  switch (name) {
    case 'shell':
      return Terminal
    case 'read_file':
      return FileText
    case 'list_dir':
      return FolderOpen
    case 'write_file':
    case 'edit_file':
      return FilePen
    case 'web_fetch':
      return Globe
    case 'update_memory':
    case 'recall_memory':
      return Brain
    case 'skill':
    case 'update_skill':
      return BookOpen
    case 'send_to_agent':
      return MessagesSquare
    case 'list_bots':
      return Users
    case 'create_bot':
      return UserPlus
    case 'pass_turn':
      return SkipForward
    default:
      return Wrench
  }
}

/**
 * The words a person sees for a tool call. A stored title wins. Otherwise the
 * plain catalogue title. Never the raw id (`update_memory`, `mcp__…`).
 */
export function visibleToolLabel(toolName: string, title?: string): string {
  const given = title?.trim()
  if (given && given !== toolName && !given.startsWith('mcp__')) return given
  const fallback = toolTitle(toolName)
  if (!fallback || fallback === toolName || fallback.startsWith('mcp__')) return 'Using a tool'
  return fallback
}

/** Fallback title when a tool-call entry has none. */
export function toolTitle(name: string): string {
  const mcp = parseMcpName(name)
  if (mcp) return `Using ${mcp.server}`
  const titles: Record<string, string> = {
    shell: 'Running a command',
    read_file: 'Reading a file',
    list_dir: 'Looking in a folder',
    write_file: 'Writing a file',
    edit_file: 'Editing a file',
    web_fetch: 'Reading a web page',
    update_memory: 'Updating memory',
    recall_memory: 'Searching memory',
    skill: 'Loading a skill',
    update_skill: 'Saving a skill',
    send_to_agent: 'Messaging a bot',
    list_bots: 'Looking up bots',
    create_bot: 'Creating a bot',
    pass_turn: 'Passing'
  }
  return titles[name] ?? name
}

/** "Allow Atlas to …?" */
export function approvalQuestion(botName: string, toolName: string): string {
  const mcp = parseMcpName(toolName)
  if (mcp) return `Allow ${botName} to use ${mcp.server}?`
  switch (toolName) {
    case 'shell':
      return `Allow ${botName} to run a command on your computer?`
    case 'write_file':
    case 'edit_file':
      return `Allow ${botName} to change a file?`
    case 'read_file':
    case 'list_dir':
      return `Allow ${botName} to look outside its workspace?`
    case 'create_bot':
      return `Allow ${botName} to create a new bot?`
    case 'web_fetch':
      return `Allow ${botName} to open a web page?`
    default:
      return `Allow ${botName} to do this?`
  }
}

export const PERMISSION_LABELS = {
  always: 'Always',
  ask: 'Ask',
  never: 'Never'
} as const

export const TOOL_GROUP_LABELS = {
  builtin: 'On your computer',
  faibots: 'faibots',
  mcp: 'Connectors'
} as const

/** Pretty JSON for tool inputs, tolerant of anything. */
export function prettyJson(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** The command for a shell call, if the input has one. */
export function commandOf(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'command' in input) {
    const c = (input as { command: unknown }).command
    return typeof c === 'string' ? c : undefined
  }
  return undefined
}
