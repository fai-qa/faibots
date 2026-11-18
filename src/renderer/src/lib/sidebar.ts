// The sidebar's sections and order, shared by the sidebar and the hotkeys
// (mod+1…9, Alt+↑/↓) so both agree on what "the third bot" is.

import type { Bot, Conversation } from '@shared/domain'
import { conversationTitle, findDm } from './bots'

export interface SidebarItem {
  key: string
  kind: 'bot' | 'group'
  bot?: Bot
  conv?: Conversation
}

export interface SidebarSections {
  pinned: SidebarItem[]
  bots: SidebarItem[]
  groups: SidebarItem[]
  hidden: SidebarItem[]
}

export function sidebarSections(bots: Bot[], conversations: Conversation[], query = ''): SidebarSections {
  const q = query.trim().toLowerCase()
  const matches = (text: string) => !q || text.toLowerCase().includes(q)
  const botItem = (bot: Bot): SidebarItem => ({ key: `bot:${bot.id}`, kind: 'bot', bot, conv: findDm(conversations, bot.id) })
  // Stable order: primary first, then by creation, so mod+1…9 does not jump around.
  const ordered = [...bots].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.createdAt - b.createdAt)
  const visible = ordered.filter((b) => matches(`${b.name} ${b.handle} ${b.label}`))
  const map = new Map(bots.map((b) => [b.id, b]))
  const groups = conversations
    .filter((c) => c.kind === 'group')
    .filter((c) => matches(conversationTitle(c, map)))
    .sort((a, b) => b.lastEntryAt - a.lastEntryAt || b.createdAt - a.createdAt)
    .map((conv): SidebarItem => ({ key: `group:${conv.id}`, kind: 'group', conv }))
  return {
    pinned: visible.filter((b) => b.pinned && !b.hidden).map(botItem),
    bots: visible.filter((b) => !b.pinned && !b.hidden).map(botItem),
    groups,
    hidden: visible.filter((b) => b.hidden).map(botItem)
  }
}

/** Flat list in on-screen order, without hidden bots. */
export function sidebarOrder(bots: Bot[], conversations: Conversation[]): SidebarItem[] {
  const s = sidebarSections(bots, conversations)
  return [...s.pinned, ...s.bots, ...s.groups]
}
