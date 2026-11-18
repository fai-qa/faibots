import clsx from 'clsx'
import { Users } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { Bot } from '@shared/domain'
import { BotAvatar } from '../avatar/BotAvatar'

export type MentionOption = { kind: 'everyone' } | { kind: 'bot'; bot: Bot }

export function mentionOptions(query: string, members: Bot[], allowEveryone: boolean): MentionOption[] {
  const q = query.toLowerCase()
  const bots = members
    .filter((b) => !q || b.handle.startsWith(q) || b.name.toLowerCase().includes(q))
    .map((bot): MentionOption => ({ kind: 'bot', bot }))
  const everyone = allowEveryone && (!q || 'everyone'.startsWith(q) || 'all'.startsWith(q)) ? [{ kind: 'everyone' } as const] : []
  return [...everyone, ...bots].slice(0, 9)
}

export function MentionMenu({ options, active, onPick, onHover }: { options: MentionOption[]; active: number; onPick: (o: MentionOption) => void; onHover: (i: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <div ref={ref} role="listbox" aria-label="Mention" className="pop-in absolute bottom-full left-0 z-30 mb-2 w-[300px] rounded-inner border border-line bg-elevated p-1 shadow-pop">
      <div className="px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-fg-3">Mention</div>
      {options.length === 0 && <div className="px-2.5 py-2 text-[12.5px] text-fg-3">Nothing to mention yet</div>}
      {options.map((o, i) => (
        <button
          key={o.kind === 'bot' ? o.bot.id : 'everyone'}
          type="button"
          role="option"
          aria-selected={i === active}
          data-index={i}
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(o)
          }}
          onMouseEnter={() => onHover(i)}
          className={clsx('flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left', i === active && 'bg-hover')}
        >
          {o.kind === 'everyone' ? (
            <>
              <span className="flex size-6 items-center justify-center rounded-[30%] bg-active text-fg-2">
                <Users size={14} />
              </span>
              <span className="text-ui font-medium text-fg">@everyone</span>
              <span className="truncate text-[12px] text-fg-3">Every bot in this group</span>
            </>
          ) : (
            <>
              <BotAvatar bot={o.bot} size={24} />
              <span className={`bot-${o.bot.avatar.color} text-ui font-medium text-bot-fg`}>{o.bot.name}</span>
              <span className="truncate text-[12px] text-fg-3">@{o.bot.handle}</span>
            </>
          )}
        </button>
      ))}
    </div>
  )
}
