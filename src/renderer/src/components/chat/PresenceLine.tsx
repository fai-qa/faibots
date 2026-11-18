// "Atlas and Iris are typing · Writing a reply" under the transcript, with each bot's
// character showing what it is doing.

import { useMemo } from 'react'
import type { Bot, BotLiveState, BotPhase } from '@shared/domain'
import { liveFor, useData } from '../../store/data'
import { PHASE_RANK } from '../../lib/activity'
import { joinNames } from '../../lib/format'
import { Character } from '../avatar/BotAvatar'
import { ThinkingLoader } from '../ui/thinking-loader-clean'

type Kind = 'waiting' | 'typing' | 'working' | 'reading'

const kindOf = (phase: BotPhase): Kind =>
  phase === 'waiting' ? 'waiting' : phase === 'typing' ? 'typing' : phase === 'reading' ? 'reading' : 'working'

function sentence(kind: Kind, names: string[]): string {
  const subject = joinNames(names)
  const plural = names.length > 1
  switch (kind) {
    case 'waiting':
      return `${subject} ${plural ? 'are' : 'is'} waiting for you`
    case 'typing':
      return `${subject} ${plural ? 'are' : 'is'} typing`
    case 'reading':
      return `${subject} ${plural ? 'are' : 'is'} reading`
    case 'working':
      return `${subject} ${plural ? 'are' : 'is'} working`
  }
}

export function PresenceLine({ conversationId }: { conversationId: string }) {
  const live = useData((s) => s.live)
  const botMap = useData((s) => s.botMap)
  const states = useMemo(
    () =>
      liveFor(live, conversationId)
        .filter((s) => botMap.has(s.botId))
        .sort((a, b) => PHASE_RANK[b.phase] - PHASE_RANK[a.phase]),
    [live, conversationId, botMap]
  )
  const top = states[0]
  const topKind = top ? kindOf(top.phase) : undefined
  const sameKind = states.filter((s) => topKind && kindOf(s.phase) === topKind)
  const names = sameKind.map((s) => botMap.get(s.botId)!.name)
  const activity = top?.activity?.trim()

  return (
    <div className="mx-auto flex h-7 w-full max-w-[820px] items-center gap-2 overflow-hidden px-6 text-[12.5px]">
      {top && topKind && (
        <>
          <span className="flex -space-x-1">
            {states.slice(0, 4).map((s: BotLiveState) => {
              const b = botMap.get(s.botId) as Bot
              return <Character key={s.botId} shape={b.avatar.shape} color={b.avatar.color} size={18} state={s.phase} seed={b.id} />
            })}
          </span>
          {topKind === 'waiting' || topKind === 'typing' ? (
            <span role="status" className={topKind === 'waiting' ? 'truncate font-medium text-warn-fg' : 'truncate font-medium text-fg-2'}>
              {sentence(topKind, names)}
            </span>
          ) : (
            <>
              <span className="min-w-0 truncate font-medium text-fg-2">{joinNames(names)}</span>
              <ThinkingLoader
                phases={[activity || (topKind === 'reading' ? 'Reading' : 'Working')]}
                phase={0}
                size="sm"
                variant="plain"
                className="min-w-0 shrink overflow-hidden"
              />
            </>
          )}
        </>
      )}
    </div>
  )
}
