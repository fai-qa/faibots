import clsx from 'clsx'
import { Ellipsis, Eye, EyeOff, MailOpen, Pencil, Pin, PinOff, RotateCcw, Settings2, Star, Trash } from 'lucide-react'
import { useState } from 'react'
import type { Bot, Conversation } from '@shared/domain'
import { botStatus, liveFor, useData } from '../../store/data'
import { confirmDialog, navigate, openDetails, useUi } from '../../store/ui'
import { deleteBot, deleteConversation, markRead, openBot, resetConversation, updateBot } from '../../store/actions'
import type { SidebarItem } from '../../lib/sidebar'
import { conversationTitle, membersOf } from '../../lib/bots'
import { plainPreview, shortWhen } from '../../lib/format'
import { approvalOutcome } from '../../lib/tools'
import { BotAvatar, GroupAvatar } from '../avatar/BotAvatar'
import { Menu, type Anchor, type MenuEntry } from '../ui/Popover'
import { RenameDialog } from './RenameDialog'

export function SidebarRow({ item, compact }: { item: SidebarItem; compact: boolean }) {
  const route = useUi((s) => s.route)
  const draft = useUi((s) => (item.conv ? s.drafts[item.conv.id] : undefined))
  const botMap = useData((s) => s.botMap)
  const live = useData((s) => s.live)
  const last = useData((s) => (item.conv ? s.lastEntry[item.conv.id] : undefined))
  const [menu, setMenu] = useState<Anchor | null>(null)
  const [renaming, setRenaming] = useState(false)

  const conv = item.conv
  const bot = item.bot
  const active = route.kind === 'conversation' && !!conv && route.id === conv.id
  const unread = conv?.unreadCount ?? 0
  const title = bot ? bot.name : conv ? conversationTitle(conv, botMap) : ''
  const members = item.kind === 'group' ? membersOf(conv, botMap) : []

  // Live status: a bot waiting on you beats one that is working.
  const status = bot
    ? botStatus(live, bot.id)
    : conv
      ? liveFor(live, conv.id).sort((a, b) => Number(b.phase === 'waiting') - Number(a.phase === 'waiting'))[0]
      : undefined
  const waiting = status?.phase === 'waiting'
  const statusText = waiting ? 'Waiting for you' : status ? 'Working' : undefined

  let preview = ''
  if (draft?.text) preview = `Draft: ${plainPreview(draft.text, 80)}`
  else if (last) {
    const who = last.author.kind === 'user' ? 'You: ' : item.kind === 'group' && last.author.kind === 'bot' ? `${botMap.get(last.author.botId)?.name ?? 'Bot'}: ` : ''
    const body =
      last.kind === 'tool-call'
        ? (last.toolCall?.title ?? 'Used a tool')
        : last.kind === 'approval'
          ? approvalOutcome(last.approval).label
          : last.text
    preview = last.kind === 'event' ? plainPreview(last.text, 80) : `${who}${plainPreview(body, 80)}`
  } else if (bot) preview = bot.label || 'Start a chat'

  const open = () => {
    if (conv) navigate({ kind: 'conversation', id: conv.id })
    else if (bot) void openBot(bot.id)
  }

  const items: MenuEntry[] = []
  if (bot) {
    if (!bot.isPrimary) {
      items.push({ label: bot.pinned ? 'Unpin' : 'Pin', icon: bot.pinned ? PinOff : Pin, onSelect: () => void updateBot(bot.id, { pinned: !bot.pinned }) })
    }
    items.push(
      ...(unread && conv ? [{ label: 'Mark as Read', icon: MailOpen, onSelect: () => markRead(conv) }] : []),
      {
        label: 'Bot settings',
        icon: Settings2,
        onSelect: () => {
          open()
          openDetails('profile', null)
        }
      }
    )
    if (!bot.isPrimary) {
      items.push({
        label: bot.hidden ? 'Show in sidebar' : 'Hide from sidebar',
        icon: bot.hidden ? Eye : EyeOff,
        onSelect: () => void updateBot(bot.id, { hidden: !bot.hidden, pinned: bot.hidden ? bot.pinned : false })
      })
    }
    if (conv) items.push({ label: 'Reset conversation', icon: RotateCcw, onSelect: () => void confirmReset(conv) })
    if (!bot.isPrimary) items.push('separator', { label: 'Delete Bot', icon: Trash, danger: true, onSelect: () => void confirmDeleteBot(bot) })
  } else if (conv) {
    items.push(
      { label: 'Rename chat', icon: Pencil, onSelect: () => setRenaming(true) },
      ...(unread ? [{ label: 'Mark as Read', icon: MailOpen, onSelect: () => markRead(conv) }] : []),
      { label: 'Reset conversation', icon: RotateCcw, onSelect: () => void confirmReset(conv) },
      'separator',
      { label: 'Delete group', icon: Trash, danger: true, onSelect: () => void confirmDeleteGroup(conv) }
    )
  }

  const avatar =
    item.kind === 'group' ? (
      <GroupAvatar bots={members} size={compact ? 34 : 30} />
    ) : bot ? (
      <BotAvatar bot={bot} size={compact ? 34 : 30} state={status?.phase} attention={waiting} />
    ) : null

  if (compact) {
    return (
      <>
        <button
          type="button"
          onClick={open}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY })
          }}
          title={statusText ? `${title}: ${statusText}` : title}
          aria-label={title}
          aria-current={active ? 'page' : undefined}
          className={clsx(
            'relative flex size-11 items-center justify-center rounded-control transition-[background-color,translate] duration-150 hover:-translate-y-[2px] hover:z-[1]',
            active ? 'bg-active' : 'hover:bg-hover'
          )}
        >
          {avatar}
          {unread > 0 && <span className="absolute right-0.5 top-0.5 size-2.5 rounded-full border-2 border-sidebar bg-danger" />}
        </button>
        {menu && <Menu anchor={menu} items={items} onClose={() => setMenu(null)} />}
        {renaming && conv && <RenameDialog conv={conv} onClose={() => setRenaming(false)} />}
      </>
    )
  }

  return (
    <div
      className={clsx(
        'group relative flex h-[50px] w-full items-center gap-2.5 rounded-control px-2 text-left transition-[background-color,translate] duration-150 hover:-translate-y-[2px] hover:z-[1]',
        active ? 'bg-active' : 'hover:bg-hover'
      )}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <button type="button" onClick={open} className="absolute inset-0 rounded-control" aria-label={`Open ${title}`} aria-current={active ? 'page' : undefined} />
      <span className={clsx('pointer-events-none relative', bot && `bot-${bot.avatar.color}`)}>{avatar}</span>
      <span className="pointer-events-none relative min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={clsx('truncate text-ui', unread ? 'font-semibold text-fg' : 'font-medium text-fg')}>{title}</span>
          {bot?.isPrimary && (
            <span role="img" aria-label="Main bot" title="Main bot" className="shrink-0">
              <Star size={11} className="fill-current text-fg-4" aria-hidden="true" />
            </span>
          )}
          <span className="ml-auto shrink-0 pl-1 text-2xs text-fg-4 group-focus-within:invisible group-hover:invisible">{conv?.lastEntryAt ? shortWhen(conv.lastEntryAt) : ''}</span>
        </span>
        <span className="flex items-center gap-1.5">
          {statusText ? (
            <span className={clsx('truncate text-[12px] font-medium', waiting ? 'text-warn-fg' : 'text-fg-2')}>{statusText}</span>
          ) : (
            <span className={clsx('truncate text-[12px]', unread ? 'text-fg-2' : 'text-fg-3', draft?.text && 'italic')}>{preview}</span>
          )}
          {unread > 0 && (
            <span className="ml-auto inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-ink px-1 text-[10.5px] font-semibold text-on-ink">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </span>
      </span>
      <button
        type="button"
        aria-label={`More actions for ${title}`}
        title="More actions"
        onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
        className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-control bg-sidebar text-fg-3 opacity-0 transition-colors duration-150 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Ellipsis size={15} />
      </button>
      {menu && <Menu anchor={menu} items={items} onClose={() => setMenu(null)} />}
      {renaming && conv && <RenameDialog conv={conv} onClose={() => setRenaming(false)} />}
    </div>
  )
}

async function confirmReset(conv: Conversation) {
  const ok = await confirmDialog({
    title: 'Reset this conversation?',
    body: "The conversation history starts over. The Bot's memory, skills and settings are kept.",
    confirmLabel: 'Reset',
    danger: true
  })
  if (ok) await resetConversation(conv.id)
}

async function confirmDeleteBot(bot: Bot) {
  const ok = await confirmDialog({
    title: `Delete ${bot.name}?`,
    body: 'This permanently deletes the Bot, its chat history, memory and private skills. This can’t be undone.',
    confirmLabel: 'Delete Bot',
    danger: true
  })
  if (ok) await deleteBot(bot.id)
}

export async function confirmDeleteGroup(conv: Conversation) {
  const ok = await confirmDialog({
    title: 'Delete this group?',
    body: 'This permanently deletes the group and its chat history. The Bots in it are not deleted and remain available individually. This can’t be undone.',
    confirmLabel: 'Delete group',
    danger: true
  })
  if (ok) await deleteConversation(conv.id)
}

export { confirmReset, confirmDeleteBot }
