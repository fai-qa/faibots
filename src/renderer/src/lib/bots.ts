// Helpers about bots and conversations that several components share.

import type { Bot, BotColor, AvatarShape, Conversation, Id } from '@shared/domain'
import { joinNames } from './format'

export const COLOR_LABELS: Record<BotColor, string> = {
  black: 'Black',
  brown: 'Brown',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  cyan: 'Cyan',
  blue: 'Blue',
  violet: 'Violet',
  magenta: 'Magenta',
  gray: 'Gray'
}

export const SHAPE_LABELS: Record<AvatarShape, string> = {
  blob: 'Blob',
  pebble: 'Pebble',
  bean: 'Bean',
  egg: 'Egg',
  squircle: 'Squircle',
  capsule: 'Capsule',
  hex: 'Hex',
  gem: 'Gem',
  shield: 'Shield',
  dome: 'Dome',
  cloud: 'Cloud',
  teardrop: 'Teardrop',
  leaf: 'Leaf',
  square: 'Square',
  sparkle: 'Sparkle',
  clover: 'Clover',
  flower: 'Flower',
  heart: 'Heart',
  star: 'Star'
}

/** Class that sets --bot / --bot-fg for a colour (see index.css). */
export function botClass(color: BotColor | undefined): string {
  return `bot-${color ?? 'gray'}`
}

export function findDm(conversations: Conversation[], botId: Id): Conversation | undefined {
  return conversations.find((c) => c.kind === 'dm' && c.botIds[0] === botId)
}

/** Title for a conversation: the bot for a dm, the group name, or "A and B" for an exchange. */
export function conversationTitle(conv: Conversation, bots: Map<Id, Bot>): string {
  if (conv.kind === 'dm') return bots.get(conv.botIds[0] ?? '')?.name ?? conv.title ?? 'Chat'
  if (conv.title.trim()) return conv.title
  const names = conv.botIds.map((id) => bots.get(id)?.name).filter((n): n is string => !!n)
  return names.length ? joinNames(names) : 'Group'
}

export function membersOf(conv: Conversation | undefined, bots: Map<Id, Bot>): Bot[] {
  if (!conv) return []
  return conv.botIds.map((id) => bots.get(id)).filter((b): b is Bot => !!b)
}

/** Names a bot answers to in @mentions: handle, full name, name without spaces, first word. */
function mentionKeys(bot: Bot): string[] {
  const name = bot.name.toLowerCase().trim()
  return [bot.handle.toLowerCase(), name, name.replace(/\s+/g, ''), name.split(/\s+/)[0] ?? name]
}

/** Resolve @mentions in text against candidates. Ambiguous names match nobody. */
export function resolveMentions(text: string, candidates: Bot[]): { ids: Id[]; everyone: boolean } {
  const ids = new Set<Id>()
  let everyone = false
  for (const match of text.matchAll(/(^|[^\w@])@([\w][\w.-]*)/g)) {
    const word = (match[2] ?? '').toLowerCase().replace(/[.-]+$/, '')
    if (word === 'everyone' || word === 'all') {
      everyone = true
      continue
    }
    const hits = candidates.filter((b) => mentionKeys(b).includes(word))
    if (hits.length === 1 && hits[0]) ids.add(hits[0].id)
  }
  return { ids: [...ids], everyone }
}

/** Find a bot by "@handle" or name, as used in send_to_agent's `to`. */
export function findBotByRef(ref: unknown, bots: Bot[]): Bot | undefined {
  if (typeof ref !== 'string') return undefined
  const word = ref.replace(/^@/, '').toLowerCase().trim()
  return bots.find((b) => b.id === ref) ?? bots.find((b) => mentionKeys(b).includes(word))
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?'
}
