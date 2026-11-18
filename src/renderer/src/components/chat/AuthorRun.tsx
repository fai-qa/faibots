// Consecutive entries from one author: the name (in the bot's colour) at the start,
// the avatar in the left gutter next to the last entry.

import clsx from 'clsx'
import type { Author, Conversation, Entry } from '@shared/domain'
import { useData } from '../../store/data'
import { openBot } from '../../store/actions'
import { formatTime } from '../../lib/format'
import { BotAvatar } from '../avatar/BotAvatar'
import { ApprovalCard } from './ApprovalCard'
import { BotHoverCard } from './BotHoverCard'
import { MessageBubble } from './MessageBubble'
import { ToolCallRow } from './ToolCallRow'

function EntryView({ entry, conv, first, colored }: { entry: Entry; conv: Conversation; first: boolean; colored?: string }) {
  switch (entry.kind) {
    case 'tool-call':
      return <ToolCallRow entry={entry} />
    case 'approval':
      return <ApprovalCard entry={entry} conversationBotIds={conv.botIds} />
    default:
      return <MessageBubble entry={entry} conv={conv} first={first} colored={colored} />
  }
}

export function AuthorRun({ author, entries, conv }: { author: Author; entries: Entry[]; conv: Conversation }) {
  const bot = useData((s) => (author.kind === 'bot' ? s.botMap.get(author.botId) : undefined))
  const live = useData((s) => (author.kind === 'bot' ? s.live[`${conv.id}:${author.botId}`] : undefined))
  const botColorInChat = useData((s) => s.settings?.botColorInChat ?? false)
  const firstAt = entries[0]?.createdAt ?? 0

  if (author.kind === 'user') {
    const dmBot = conv.kind === 'dm' ? useData.getState().botMap.get(conv.botIds[0] ?? '') : undefined
    const colored = botColorInChat && dmBot ? `bot-${dmBot.avatar.color}` : undefined
    return (
      <div className="flex flex-col items-end gap-1 py-1.5 pl-12" aria-label="Your message">
        <span className="mr-1 text-2xs text-fg-4">{formatTime(firstAt)}</span>
        {entries.map((e, i) => (
          <EntryView key={e.id} entry={e} conv={conv} first={i === 0} colored={colored} />
        ))}
      </div>
    )
  }

  const name = bot?.name ?? 'Deleted bot'
  return (
    <div className={clsx('flex gap-2.5 py-1.5 pr-10', bot && `bot-${bot.avatar.color}`)} aria-label={`${name} message`}>
      <div className="flex w-8 shrink-0 flex-col justify-end pb-0.5">
        {bot ? (
          <BotHoverCard bot={bot}>
            <button type="button" onClick={() => void openBot(bot.id)} aria-label={`Open ${name}'s chat`} className="block rounded-[30%]">
              <BotAvatar bot={bot} size={32} state={live?.phase} />
            </button>
          </BotHoverCard>
        ) : (
          <span className="size-8 rounded-[30%] bg-active" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <div className="flex items-baseline gap-2 pl-1">
          {bot ? (
            <BotHoverCard bot={bot}>
              <button type="button" onClick={() => void openBot(bot.id)} className="text-[13px] font-semibold text-bot-fg hover:underline">
                {name}
              </button>
            </BotHoverCard>
          ) : (
            <span className="text-[13px] font-semibold text-fg-3">{name}</span>
          )}
          {bot?.label && conv.kind !== 'dm' && <span className="truncate text-[12px] text-fg-3">{bot.label}</span>}
          <span className="text-2xs text-fg-4">{formatTime(firstAt)}</span>
        </div>
        {entries.map((e, i) => (
          <div key={e.id} className="w-full">
            <EntryView entry={e} conv={conv} first={i === 0} />
          </div>
        ))}
      </div>
    </div>
  )
}
