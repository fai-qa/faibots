// Right pane: the bot's profile, memory, skills, tools and connectors, or the group's
// members and settings.

import clsx from 'clsx'
import { ArrowLeft, MessageSquare, X } from 'lucide-react'
import type { Bot, Conversation } from '@shared/domain'
import { botStatus, useData } from '../../store/data'
import { openDetails, useUi, type DetailsTab } from '../../store/ui'
import { openBot } from '../../store/actions'
import { membersOf } from '../../lib/bots'
import { useCurrentConversation } from '../../lib/hooks'
import { BotAvatar } from '../avatar/BotAvatar'
import { IconButton } from '../ui/Button'
import { ConnectorsTab } from './ConnectorsTab'
import { GroupPanel } from './GroupPanel'
import { MemoryTab } from './MemoryTab'
import { ProfileTab } from './ProfileTab'
import { RoutinesTab } from './RoutinesTab'
import { SkillsTab } from './SkillsTab'
import { ToolsTab } from './ToolsTab'

const TABS: { id: DetailsTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'memory', label: 'Memory' },
  { id: 'skills', label: 'Skills' },
  { id: 'routines', label: 'Routines' },
  { id: 'tools', label: 'Tools' },
  { id: 'connectors', label: 'Connectors' }
]

export function DetailsPane() {
  const conv = useCurrentConversation()
  const detailsBotId = useUi((s) => s.detailsBotId)
  const botMap = useData((s) => s.botMap)
  if (!conv) return null

  const close = () => useUi.setState({ detailsOpen: false })
  let body: React.ReactNode
  if (conv.kind === 'dm') {
    const bot = botMap.get(conv.botIds[0] ?? '')
    body = bot ? <BotPanel bot={bot} onClose={close} /> : null
  } else {
    const member = detailsBotId ? botMap.get(detailsBotId) : undefined
    body = member ? (
      <BotPanel bot={member} onClose={close} backLabel={conv.kind === 'group' ? 'Back to group' : 'Back to exchange'} onBack={() => openDetails(undefined, null)} />
    ) : conv.kind === 'group' ? (
      <GroupPanel conv={conv} onClose={close} />
    ) : (
      <ExchangePanel conv={conv} onClose={close} />
    )
  }

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-line-soft bg-pane" aria-label="Details">
      {body}
    </aside>
  )
}

function BotPanel({ bot, onClose, backLabel, onBack }: { bot: Bot; onClose: () => void; backLabel?: string; onBack?: () => void }) {
  const tab = useUi((s) => s.detailsTab)
  const status = useData((s) => botStatus(s.live, bot.id))
  return (
    <>
      <header className={`bot-${bot.avatar.color} drag flex h-[52px] shrink-0 items-center gap-2.5 px-3`}>
        {onBack ? <IconButton icon={ArrowLeft} label={backLabel ?? 'Back'} onClick={onBack} /> : null}
        <BotAvatar bot={bot} size={26} state={status?.phase} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-fg">{bot.name}</div>
        </div>
        <IconButton icon={X} label="Close details" onClick={onClose} />
      </header>
      {/* Six tabs fill the 360px pane; on tight font metrics the row scrolls instead of clipping. */}
      <nav className="flex shrink-0 overflow-x-auto border-b border-line-soft px-1.5 [scrollbar-width:none]" role="tablist" aria-label={`${bot.name} settings`}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => useUi.setState({ detailsTab: t.id })}
            className={clsx(
              'relative h-9 shrink-0 whitespace-nowrap rounded-t-md px-[7px] text-[12.5px] font-medium transition-colors',
              tab === t.id ? 'text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-[2px] after:rounded-full after:bg-ink' : 'text-fg-3 hover:text-fg'
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="scroll-y min-h-0 flex-1" role="tabpanel">
        {tab === 'profile' && <ProfileTab bot={bot} />}
        {tab === 'memory' && <MemoryTab bot={bot} />}
        {tab === 'skills' && <SkillsTab bot={bot} />}
        {tab === 'routines' && <RoutinesTab bot={bot} />}
        {tab === 'tools' && <ToolsTab bot={bot} />}
        {tab === 'connectors' && <ConnectorsTab bot={bot} />}
      </div>
    </>
  )
}

function ExchangePanel({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const botMap = useData((s) => s.botMap)
  const members = membersOf(conv, botMap)
  return (
    <>
      <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-line-soft px-4">
        <h2 className="flex-1 text-[13.5px] font-semibold text-fg">Bots in this exchange</h2>
        <IconButton icon={X} label="Close details" onClick={onClose} />
      </header>
      <div className="scroll-y flex-1 p-3">
        {members.map((b) => (
          <div key={b.id} className={`bot-${b.avatar.color} flex items-center gap-3 rounded-[10px] px-2 py-2 hover:bg-hover`}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => openDetails('profile', b.id)}>
              <BotAvatar bot={b} size={32} />
              <span className="min-w-0">
                <span className="block truncate text-ui font-medium text-bot-fg">{b.name}</span>
                <span className="block truncate text-[12px] text-fg-3">{b.label || `@${b.handle}`}</span>
              </span>
            </button>
            <IconButton icon={MessageSquare} label={`Open ${b.name}'s chat`} onClick={() => void openBot(b.id)} />
          </div>
        ))}
        <p className="px-2 pt-3 text-[12px] text-fg-3">
          Bots open an exchange when one asks another for help. Each one answers with its own soul, memory and model.
        </p>
      </div>
    </>
  )
}
