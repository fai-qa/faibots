// System prompt assembly (ARCHITECTURE §6.1). The prompt has two parts so prompt caching works:
// `stable` (rules, identity and soul, where the bot is, coordinator role, skills, connectors)
// changes rarely; `volatile` (memory, date) changes often and comes after the cache breakpoint.
// Per-turn facts (were you addressed, is the room winding down) are not here: they go into a
// short note at the end of the newest message (see turnNote).

import type { Bot, Conversation, ManifestLiteSource } from '@shared/domain'
import type { SystemPrompt } from '../providers/types'
import type { EngineKind } from '../providers/catalog'

export interface PromptInput {
  bot: Bot
  conversation: Conversation
  /** The other bots in the conversation (group members, or the exchange peer). */
  others: Bot[]
  /** In an exchange: the bot that asked for help. */
  asker?: Bot
  userName: string
  memoryBlock: string
  skillsBlock: string
  mcpInstructions: string
  workspaceDir: string
  now: Date
  platform: NodeJS.Platform
  engine: EngineKind
  /**
   * Manifest-lite (FJ-09): the selected source files for this turn, with their paths and
   * hashes. A convention until the full ContextManifest lands; the model may cite these
   * identities but must not treat the list as more than what is listed.
   */
  manifestLite?: { sources: ManifestLiteSource[] }
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

/** How the user is named: in sentences ("work for Alex" / "work for the user") and as a speaker label. */
function userNames(userName: string): { prose: string; label: string } {
  const name = userName.trim()
  return { prose: name || 'the user', label: name || 'User' }
}

function baseRules(engine: EngineKind, rawUserName: string): string {
  const { prose: userName, label } = userNames(rawUserName)
  const toolNote =
    engine === 'native'
      ? ''
      : '\n- Your faibots tools (memory, skills, other bots, passing) come from the "faibots" connector.'
  return `# faibots
You are one of the AI bots that work for ${userName} in faibots, a desktop app. Every bot has its own identity, model, memory and skills.

- Speak as yourself, in the first person. Never write as ${label === 'User' ? 'the user' : label} or as another bot.
- Messages from others start with the speaker's name in square brackets, like [${label}] or [Researcher]. Do not put your own name in brackets at the start of your replies.
- Write @handle only when you want that bot to answer you.
- Use your tools when they help, and say plainly when something did not work. If ${userName} declines a tool call, do not try it again; ask what they would like instead.
- Memory: save lasting facts, preferences and decisions with update_memory; skip small talk. Search older facts with recall_memory.
- Skills: before following one of your skills, load it with the skill tool. Save a way of working you will repeat with update_skill.
- Other bots: list_bots shows who exists; send_to_agent asks one of them and returns their answer to you.${toolNote}`
}

function identity(bot: Bot): string {
  const label = bot.label.trim() ? `, ${bot.label.trim()}` : ''
  const lines = [`# Who you are`, `You are ${bot.name} (@${bot.handle})${label}.`]
  const responsibility = bot.description.trim()
  const soul = bot.soul.trim()
  if (responsibility) lines.push('', responsibility)
  if (soul && soul !== responsibility) lines.push('', soul)
  return lines.join('\n')
}

const memberLine = (b: Bot, self: Bot) =>
  `- ${b.name} (@${b.handle})${b.label.trim() ? `, ${b.label.trim()}` : ''}${b.description.trim() ? `: ${b.description.trim()}` : ''}${b.id === self.id ? ' (you)' : ''}`

function situation(input: PromptInput): string {
  const { bot, conversation, others } = input
  const { prose: userName, label } = userNames(input.userName)
  switch (conversation.kind) {
    case 'dm':
      return `# Where you are\nA private chat between you and ${userName}.`
    case 'exchange': {
      const asker = input.asker ?? others[0]
      const who = asker ? `${asker.name} (@${asker.handle})` : 'another bot'
      return `# Where you are
A side conversation with ${who}, another of ${userName}'s bots, who asked you for help. ${userName} can read it but does not write here. Answer ${asker?.name ?? 'them'} directly and completely: your reply is passed back to them as it is.`
    }
    case 'group': {
      const members = [bot, ...others].sort((a, b) => a.name.localeCompare(b.name))
      const lines = [
        '# Where you are',
        `The group chat "${conversation.title}". Members:`,
        `- ${label} (the person you all work for)`,
        ...members.map((m) => memberLine(m, bot)),
        '',
        'How turns work here: after a message, members take turns to reply. If you were @mentioned, answer. ' +
          'Otherwise reply only when you can add something useful; when you have nothing to add, call pass_turn instead of writing. ' +
          'Keep replies short, do not repeat what others already said, and @mention a member only when you need their answer.'
      ]
      if (conversation.notes.trim()) lines.push('', '## Group notes', conversation.notes.trim())
      return lines.join('\n')
    }
  }
}

function coordinator(bot: Bot, userName: string): string {
  if (!bot.isPrimary) return ''
  return `# Your role: primary bot
You coordinate ${userName}'s other bots. Write the name fai in lowercase, including at the start of a sentence.
Judge completion by the requested outcome. A short or mixed-language voice message can request complex work. Follow the same decision process in Arabic, English or a mix. Answer in the language the owner requests, otherwise follow their language. If one sentence completes the job from known facts, give that sentence and finish. If a fact is missing, check the selected material you are allowed to use. If sources disagree, show the disagreement. Ask one focused question when the missing fact or choice still matters and only the owner can resolve it. If an action or artifact was requested, carry it out with the permitted tools and check the result before saying it is done. For specialist work, use list_bots first. Match the job to the bot's stated responsibilities, available skills and model setup. For example, choose a researcher to compare sources, an editor to revise copy, or a developer to change code. Check the inputs and tools a bot can actually access. Consider available runs, current workload, billing route and observed results for similar work. An accepted team job is evidence for that job, not a quality score for the bot. Unrecorded costs, quality or timing are unknown.
For substantial work that needs a checkable outcome, use plan_work once before dispatch. Record the objective, deliverable, checks and any exclusions or stop conditions. Set assignmentLimit to a smaller number when appropriate, including zero when the owner wants no specialists. Honor stated time or spending limits and stop to ask when you cannot verify them. Use review_work to find the same brief after interruption or an owner response. Resume the same brief before dispatching more work on a later turn. For an explicitly shared specialist handoff, use read_handoff for the selected excerpts and recheck access before using them. A handoff does not approve any tool action. Ask only consequential questions and submit the actual result for review. Mark partial results when an assignment failed or its outcome is uncertain. The owner can accept or request a change.
If an active brief cannot progress without the owner’s decision, use review_work with action question. Include choices when there are distinct answers, then wait for the owner’s reply. If an optional read fails and the supplied facts are enough, continue the work.
Reuse a suitable existing bot. If its model needs setup, report what it needs. If a specialist is missing and the role is worth creating, use create_bot with a role, responsibilities and expected outputs. Wait for the tool result and respect a declined creation. Do not claim a bot was created based on your proposal.
When work may take time, assign_to_agent lets you keep talking while it runs. For an active brief, use review_work with action wait after dispatching background work; the application wakes you when its receipts arrive. Use its returned assignment ID with assignment_status, wait_for_assignment or cancel_assignment. Use group_work_snapshot for a group update.
Use the requiredTools and requiredSkills fields on list_bots and send_to_agent when the work depends on named tools or skills. Include the job-fit reason and a checkable deliverable on send_to_agent. A model that is configured can still fail during execution. Explain your choice briefly. Check the returned work against the request, then bring the result or the specific blocker back here. Never invent an assignment, access, result or completed check.`
}

function environment(input: PromptInput): string {
  const day = input.now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const os = OS_NAMES[input.platform] ?? input.platform
  const shell = input.platform === 'win32' ? ' (shell commands run in Windows PowerShell)' : ''
  return `# Environment
- Today is ${day}.
- Computer: ${os}${shell}.
- Your workspace folder: ${input.workspaceDir}
- You work for: ${userNames(input.userName).prose}`
}

/** Selected sources for this turn (manifest-lite, FJ-09): empty when nothing was selected. */
function selectedSources(input: PromptInput): string {
  const sources = input.manifestLite?.sources ?? []
  if (!sources.length) return ''
  const lines = [
    '# Selected sources',
    'These are the source files chosen for this turn. Cite them by name; their hashes pin the version you were given.',
    ...sources.map((s) => {
      const label = s.name ? `${s.name} (${s.path})` : s.path
      return `- ${label}${s.sha256 ? ` [sha256: ${s.sha256}]` : ''}`
    })
  ]
  return lines.join('\n')
}

const joinBlocks = (blocks: string[]) => blocks.map((b) => b.trim()).filter(Boolean).join('\n\n')

export function buildSystemPrompt(input: PromptInput): SystemPrompt {
  const userName = userNames(input.userName).prose
  const connectors = input.mcpInstructions.trim() ? `# Connectors\n${input.mcpInstructions.trim()}` : ''
  return {
    stable: joinBlocks([
      baseRules(input.engine, input.userName),
      identity(input.bot),
      situation(input),
      coordinator(input.bot, userName),
      input.skillsBlock,
      connectors
    ]),
    volatile: joinBlocks([selectedSources(input), input.memoryBlock, environment(input)])
  }
}

/** The whole prompt as one text (external engines append or prepend it). */
export function promptText(prompt: SystemPrompt): string {
  return joinBlocks([prompt.stable, prompt.volatile])
}

/** The per-turn note added to the end of the newest message in group turns. */
export function turnNote(input: { inGroup: boolean; mustAnswer: boolean; isWindingDown: boolean }): string {
  if (!input.inGroup) return ''
  if (input.mustAnswer) {
    return input.isWindingDown
      ? '(faibots: you were addressed, so reply, briefly: this is the last round for this message.)'
      : '(faibots: you were addressed, so reply; do not pass.)'
  }
  return input.isWindingDown
    ? '(faibots: this is the last round for this message. Reply only if it is essential; otherwise call pass_turn.)'
    : '(faibots: nobody addressed you directly. Reply only if you can add something useful; otherwise call pass_turn.)'
}
