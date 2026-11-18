// Profile card that opens when you hover a bot's name, avatar or mention.

import { MessageSquare, Pencil } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Bot } from '@shared/domain'
import { botStatus, useData } from '../../store/data'
import { openDetails, useUi } from '../../store/ui'
import { openBot } from '../../store/actions'
import { findDm } from '../../lib/bots'
import { billingFor, routeLabel } from '../../lib/providers'
import { BotAvatar } from '../avatar/BotAvatar'
import { BillingBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Floating } from '../ui/Popover'

const OPEN_DELAY = 350
const CLOSE_DELAY = 200

export function BotHoverCard({ bot, children }: { bot: Bot; children: ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(
    () => () => {
      clearTimeout(openTimer.current)
      clearTimeout(closeTimer.current)
    },
    []
  )

  const enter = () => {
    clearTimeout(closeTimer.current)
    if (anchor) return
    openTimer.current = setTimeout(() => {
      if (ref.current) setAnchor(ref.current.getBoundingClientRect())
    }, OPEN_DELAY)
  }
  const leave = () => {
    clearTimeout(openTimer.current)
    closeTimer.current = setTimeout(() => setAnchor(null), CLOSE_DELAY)
  }

  return (
    <span ref={ref} onMouseEnter={enter} onMouseLeave={leave} className="inline">
      {children}
      {anchor && (
        <Floating anchor={anchor} placement="top-start" onMouseEnter={enter} onMouseLeave={leave}>
          <ProfileCard bot={bot} onDone={() => setAnchor(null)} />
        </Floating>
      )}
    </span>
  )
}

function ProfileCard({ bot, onDone }: { bot: Bot; onDone: () => void }) {
  const providers = useData((s) => s.providers)
  const tests = useData((s) => s.providerTests)
  const status = useData((s) => botStatus(s.live, bot.id))
  const provider = providers.find((p) => p.id === bot.model.providerId)

  const editProfile = () => {
    onDone()
    const { route } = useUi.getState()
    const conversations = useData.getState().conversations
    const current = route.kind === 'conversation' ? conversations.find((c) => c.id === route.id) : undefined
    if (current?.kind === 'group' && current.botIds.includes(bot.id)) return openDetails('profile', bot.id)
    const dm = findDm(conversations, bot.id)
    if (current && dm && current.id === dm.id) return openDetails('profile', null)
    void openBot(bot.id).then(() => openDetails('profile', null))
  }

  return (
    <div
      role="dialog"
      aria-label={`${bot.name} profile`}
      className={`bot-${bot.avatar.color} w-[264px] rounded-2xl border border-line bg-elevated p-4 text-left shadow-pop`}
    >
      <div className="flex items-start gap-3">
        <BotAvatar bot={bot} size={52} state={status?.phase} />
        <div className="min-w-0 pt-1">
          <div className="truncate text-[15px] font-semibold text-bot-fg">{bot.name}</div>
          <div className="truncate text-[12.5px] text-fg-3">@{bot.handle}</div>
          {bot.label && <div className="mt-0.5 truncate text-[12.5px] text-fg-2">{bot.label}</div>}
        </div>
      </div>
      {bot.description && <p className="mt-3 line-clamp-3 text-[12.5px] leading-relaxed text-fg-2">{bot.description}</p>}
      <div className="mt-3 flex items-center gap-2 text-2xs text-fg-3">
        <span className="min-w-0 truncate">{routeLabel(bot.model, providers)}</span>
        {provider && <BillingBadge route={billingFor(provider, tests[provider.id]?.billing)} />}
      </div>
      <div className="mt-3.5 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={MessageSquare}
          className="flex-1"
          onClick={() => {
            onDone()
            void openBot(bot.id)
          }}
        >
          Open chat
        </Button>
        <Button size="sm" icon={Pencil} className="flex-1" onClick={editProfile}>
          Edit Profile
        </Button>
      </div>
    </div>
  )
}
