import { AlarmClock, Rocket } from 'lucide-react'
import { useState } from 'react'
import type { Entry, EntryTrigger, RoutineRunTrigger } from '@shared/domain'
import { useData } from '../../store/data'
import { navigate, openDetails } from '../../store/ui'
import { formatFull, formatTime } from '../../lib/format'
import { Character } from '../avatar/BotAvatar'
import { Markdown } from './Markdown'

/** Centred system line: "Juno passed", "Iris was added to the chat", "Stopped". */
export function EventLine({ entry }: { entry: Entry }) {
  const bot = useData((s) => (entry.author.kind === 'bot' ? s.botMap.get(entry.author.botId) : undefined))
  if (entry.trigger) return <TriggerTask entry={entry} trigger={entry.trigger} />
  const passed = entry.kind === 'tool-call' && entry.toolCall?.toolName === 'pass_turn'
  const text = passed ? `${bot?.name ?? 'A bot'} passed` : entry.text
  const isMessage = entry.kind === 'message'
  return (
    <div className="flex justify-center px-4 py-1.5" title={formatFull(entry.createdAt)}>
      <div className="flex max-w-[560px] items-center gap-1.5 text-[12px] text-fg-3">
        {bot && <Character shape={bot.avatar.shape} color={bot.avatar.color} size={15} seed={bot.id} />}
        {isMessage ? <Markdown text={text} className="!text-[12px] !leading-snug" /> : <span className="selectable">{text}</span>}
      </div>
    </div>
  )
}

const STARTED: Record<RoutineRunTrigger, string> = {
  schedule: 'on schedule',
  manual: 'started by you',
  webhook: 'started by a webhook',
  'catch-up': 'caught up after a restart'
}

/** The task FaiBots posted for a routine or mission run: who it is for, how it started, and the task itself. */
function TriggerTask({ entry, trigger }: { entry: Entry; trigger: EntryTrigger }) {
  const [open, setOpen] = useState(false)
  const long = entry.text.length > 220 || entry.text.split('\n').length > 3
  const mission = trigger.kind === 'mission'
  const label = mission ? 'Mission' : 'Routine'
  const name = mission ? trigger.projectName : trigger.routineName
  const detail = mission ? 'run by faibots' : `Routine, ${STARTED[trigger.via]}`
  return (
    <div className="flex justify-center px-4 py-2" title={formatFull(entry.createdAt)}>
      <div className="w-full max-w-[560px] rounded-xl border border-line-soft bg-pane px-3.5 py-2.5">
        <div className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
          {mission ? <Rocket size={13} className="shrink-0" /> : <AlarmClock size={13} className="shrink-0" />}
          <button
            type="button"
            className="font-semibold text-fg-2 hover:text-fg hover:underline"
            onClick={() => (mission ? navigate({ kind: 'project', id: trigger.projectId }) : openDetails('routines'))}
            title={mission ? 'Open the project' : 'Open the routine'}
          >
            {name}
          </button>
          <span>
            · {label}, {detail} at {formatTime(entry.createdAt)}
          </span>
        </div>
        <div className={long && !open ? 'line-clamp-3' : undefined}>
          <Markdown text={entry.text} className="mt-1 !text-[12.5px] !leading-snug text-fg-2" />
        </div>
        {long && (
          <button type="button" className="mt-0.5 text-[11.5px] text-fg-3 hover:text-fg" onClick={() => setOpen((v) => !v)}>
            {open ? 'Show less' : 'Show the whole task'}
          </button>
        )}
      </div>
    </div>
  )
}
