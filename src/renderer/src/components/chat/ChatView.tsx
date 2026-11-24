import { ArrowLeft, Eye, PanelRight, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Bot, Conversation } from '@shared/domain'
import { liveFor, useData } from '../../store/data'
import { navigate, useUi } from '../../store/ui'
import { loadEntries, markRead, sendMessage, stopConversation } from '../../store/actions'
import { conversationTitle, mainBotRole, membersOf } from '../../lib/bots'
import { joinNames, modKey, plural } from '../../lib/format'
import { BotAvatar, GroupAvatar } from '../avatar/BotAvatar'
import { IconButton } from '../ui/Button'
import { Composer } from '../composer/Composer'
import { FindBar } from './FindBar'
import { PresenceLine } from './PresenceLine'
import { WorkBriefPanel } from './WorkBriefPanel'
import { Transcript } from './Transcript'
import { WhoSaidWhat } from './WhoSaidWhat'
import { SpecialistHandoff } from './SpecialistHandoff'
import { isMockBridge } from '../../lib/bridge'

export function ChatView({ conv }: { conv: Conversation }) {
  const botMap = useData((s) => s.botMap)
  const loaded = useData((s) => !!s.entries[conv.id])
  const busy = useData((s) => liveFor(s.live, conv.id).length > 0)
  const findOpen = useUi((s) => s.findOpen)
  const scrollRef = useRef<HTMLDivElement>(null)
  const members = useMemo(() => membersOf(conv, botMap), [conv, botMap])
  const readOnly = conv.kind === 'exchange'
  const [overview, setOverview] = useState(false)

  useEffect(() => {
    setOverview(false)
  }, [conv.id])

  useEffect(() => {
    if (!loaded) void loadEntries(conv.id)
  }, [conv.id, loaded])

  // Opening a chat (or coming back to the window) marks it read.
  useEffect(() => {
    if (document.hasFocus()) markRead(conv)
    const onFocus = () => {
      const current = useData.getState().conversations.find((c) => c.id === conv.id)
      if (current) markRead(current)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [conv])

  const placeholder =
    conv.kind === 'dm' ? `Message ${members[0]?.name ?? 'bot'}` : conv.kind === 'group' ? 'Message group' : ''

  const directBot = conv.kind === 'dm' ? members[0] : undefined
  const defaultGreeting = directBot?.isPrimary ? mainBotRole : 'Say hello, or ask for something specific.'
  const empty =
    conv.kind === 'dm' && members[0] ? (
      <div className="flex flex-col items-center text-center">
        <BotAvatar bot={members[0]} size={64} />
        <div className={`bot-${members[0].avatar.color} mt-3 text-[15px] font-semibold text-bot-fg`}>{members[0].name}</div>
        <p className="mt-1 max-w-[320px] text-[12.5px] text-fg-3">{members[0].description || (members[0].model.providerId ? defaultGreeting : 'Set up a model to start chatting.')}</p>
      </div>
    ) : conv.kind === 'group' ? (
      <div className="flex flex-col items-center text-center">
        <GroupAvatar bots={members} size={56} />
        <div className="mt-3 text-[15px] font-semibold text-fg">{conversationTitle(conv, botMap)}</div>
        <p className="mt-1 max-w-[340px] text-[12.5px] text-fg-3">
          Everyone here reads each message. @mention a bot to make sure it answers.
        </p>
      </div>
    ) : (
      <p className="text-[12.5px] text-fg-3">No messages from this bot yet</p>
    )

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-pane" aria-label={conversationTitle(conv, botMap)}>
      <ChatHeader conv={conv} onWho={conv.kind === 'group' ? () => setOverview(true) : undefined} />
      {conv.kind === 'dm' && members[0]?.isPrimary && <WorkBriefPanel key={conv.id} conversationId={conv.id} />}
      {!isMockBridge() && conv.kind === 'dm' && members[0] && !members[0].isPrimary && <SpecialistHandoff key={conv.id} conversationId={conv.id}/>}
      {readOnly && <ExchangeBanner conv={conv} />}
      {overview && conv.kind === 'group' ? (
        <WhoSaidWhat conv={conv} onBack={() => setOverview(false)} />
      ) : (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {findOpen && <FindBar scrollRef={scrollRef} conversationId={conv.id} />}
        <Transcript conv={conv} scrollRef={scrollRef} empty={empty} />
      </div>
      )}
      {!overview && <PresenceLine conversationId={conv.id} />}
      {!readOnly && !overview && (
        <Composer
          draftKey={conv.id}
          conversationId={conv.id}
          placeholder={placeholder}
          members={members}
          allowEveryone={conv.kind === 'group'}
          busy={busy}
          onStop={() => void stopConversation(conv.id)}
          onSend={(draft) => sendMessage(conv, draft, members)}
        />
      )}
    </section>
  )
}

/** The chat header shows the bot's role, not the model id. The id stays in the model picker. */
export function dmHeaderRole(bot: Pick<Bot, 'label' | 'isPrimary'>): string | undefined {
  const label = bot.label?.trim()
  if (!label) return undefined
  if (bot.isPrimary && label.toLowerCase() === 'main bot') return undefined
  return label
}

function ChatHeader({ conv, onWho }: { conv: Conversation; onWho?: () => void }) {
  const botMap = useData((s) => s.botMap)
  const detailsOpen = useUi((s) => s.detailsOpen)
  const findOpen = useUi((s) => s.findOpen)
  const members = membersOf(conv, botMap)
  const bot = conv.kind === 'dm' ? members[0] : undefined
  const role = bot ? dmHeaderRole(bot) : undefined
  const title = conv.kind === 'exchange' ? 'Bot exchange' : conversationTitle(conv, botMap)

  return (
    <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-line-soft px-4">
      {bot ? <BotAvatar bot={bot} size={28} /> : <GroupAvatar bots={members} size={28} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className={`truncate text-[14px] font-semibold text-fg`}>{title}</h1>
          {bot?.isPrimary && <span className="text-2xs font-medium text-fg-3">Main bot</span>}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-fg-3">
          {bot ? (
            role ? <span className="min-w-0 truncate">{role}</span> : null
          ) : conv.kind === 'group' ? (
            <span className="truncate">
              {plural(members.length, 'member')}: {joinNames(members.map((m) => m.name), 4)}
            </span>
          ) : (
            <span className="truncate">Bot exchange between {joinNames(members.map((m) => m.name))}</span>
          )}
        </div>
      </div>
      {onWho && (
        <button type="button" onClick={onWho} className="rounded-md px-2 py-1 text-[13px] text-fg-3 hover:bg-hover hover:text-fg">
          Who said what
        </button>
      )}
      <IconButton icon={Search} label={`Find in chat (${modKey}+F)`} active={findOpen} onClick={() => useUi.setState({ findOpen: !findOpen })} />
      <IconButton
        icon={PanelRight}
        label={`Toggle details (${modKey}+Alt+B)`}
        active={detailsOpen}
        onClick={() => useUi.setState({ detailsOpen: !detailsOpen })}
      />
    </header>
  )
}

function ExchangeBanner({ conv }: { conv: Conversation }) {
  const origin = useData((s) => (conv.origin ? s.conversations.find((c) => c.id === conv.origin!.conversationId) : undefined))
  const botMap = useData((s) => s.botMap)
  const back = useUi((s) => s.back)
  const originName = origin ? conversationTitle(origin, botMap) : undefined
  const goBack = () => {
    if (origin) navigate({ kind: 'conversation', id: origin.id })
    else if (back.length) useUi.setState({ route: back[back.length - 1]!, back: back.slice(0, -1) })
  }
  return (
    <div className="flex items-center gap-2 border-b border-line-soft bg-sunken px-4 py-2 text-[12.5px] text-fg-2">
      <Eye size={14} className="shrink-0 text-fg-3" />
      <span className="flex-1">This chat is view-only. The bots talk here on their own.</span>
      {(origin || back.length > 0) && (
        <button type="button" onClick={goBack} className="flex items-center gap-1 rounded-md px-2 py-1 font-medium text-fg hover:bg-hover">
          <ArrowLeft size={13} />
          {originName ? `Back to ${originName}` : 'Back'}
        </button>
      )}
    </div>
  )
}
