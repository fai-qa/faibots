import { Download, Maximize2, RotateCcw, Trash } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Bot } from '@shared/domain'
import { useData } from '../../store/data'
import { toast, useUi } from '../../store/ui'
import { attempt, updateBot } from '../../store/actions'
import { findDm } from '../../lib/bots'
import { useDraftValue } from '../../lib/hooks'
import { BotAvatar } from '../avatar/BotAvatar'
import { Button } from '../ui/Button'
import { Field, TextArea, TextInput } from '../ui/Field'
import { SettingRow, Toggle } from '../ui/Toggle'
import { Markdown } from '../chat/Markdown'
import { confirmDeleteBot, confirmReset } from '../sidebar/SidebarRow'
import { ModelPicker } from './ModelPicker'
import { SoulDialog } from './SoulDialog'

/** Number field for Bot.dailyRunLimit that saves on blur or Enter. */
function DailyLimitInput({ bot }: { bot: Bot }) {
  const [value, setValue] = useState(String(bot.dailyRunLimit))
  useEffect(() => setValue(String(bot.dailyRunLimit)), [bot.dailyRunLimit])
  const save = () => {
    const n = Math.max(0, Math.min(10_000, Math.round(Number(value) || 0)))
    setValue(String(n))
    if (n !== bot.dailyRunLimit) void updateBot(bot.id, { dailyRunLimit: n })
  }
  return (
    <TextInput
      type="number"
      min={0}
      max={10000}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      aria-label="Daily limit for automatic runs"
      className="!w-[76px] text-right tabular-nums"
    />
  )
}

/** A text field that saves on blur (and Enter for single-line fields). */
function BotTextField({
  bot,
  field,
  label,
  placeholder,
  hint,
  multiline,
  prefix
}: {
  bot: Bot
  field: 'name' | 'handle' | 'label' | 'description'
  label: string
  placeholder?: string
  hint?: string
  multiline?: boolean
  prefix?: string
}) {
  const [value, setValue] = useDraftValue(bot[field], bot.id)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const next = field === 'handle' ? value.trim().toLowerCase() : value.trim()
    if (next === bot[field]) return
    if (field === 'name' && !next) {
      setError('Name can’t be empty')
      return
    }
    setError(null)
    const saved = await updateBot(bot.id, { [field]: next })
    if (!saved) setValue(bot[field])
  }
  return (
    <Field label={label} hint={hint} error={error}>
      {multiline ? (
        <TextArea value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => void save()} placeholder={placeholder} rows={2} autoGrow className="min-h-[56px]" />
      ) : (
        <span className="relative block">
          {prefix && <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ui text-fg-4">{prefix}</span>}
          <TextInput
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            placeholder={placeholder}
            className={prefix ? 'pl-6' : undefined}
          />
        </span>
      )}
    </Field>
  )
}

function SoulEditor({ bot }: { bot: Bot }) {
  const [value, setValue, dirty] = useDraftValue(bot.soul, bot.id)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [preview, setPreview] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef(value)
  latest.current = value

  const save = async (text: string) => {
    clearTimeout(timer.current)
    if (text === useData.getState().botMap.get(bot.id)?.soul) return
    setStatus('saving')
    const saved = await updateBot(bot.id, { soul: text })
    setStatus(saved ? 'saved' : 'idle')
  }

  // Autosave a moment after you stop typing, and when you leave.
  useEffect(() => {
    if (!dirty) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(latest.current), 900)
    return () => clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  useEffect(() => () => void save(latest.current), [bot.id]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-fg-2">Soul</span>
        <span className="text-2xs text-fg-4">{status === 'saving' ? 'Saving…' : status === 'saved' && !dirty ? 'Saved' : dirty ? 'Unsaved' : ''}</span>
        <span className="flex-1" />
        <button type="button" onClick={() => setPreview((v) => !v)} className="rounded px-1.5 py-0.5 text-[12px] font-medium text-fg-3 hover:bg-hover hover:text-fg">
          {preview ? 'Edit' : 'Preview'}
        </button>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="Open the soul in a large editor"
          title="Open in a large editor"
          className="rounded p-1 text-fg-3 hover:bg-hover hover:text-fg"
        >
          <Maximize2 size={13} />
        </button>
      </div>
      {preview ? (
        <div className="min-h-[280px] rounded-lg border border-line-soft bg-sunken px-3 py-2.5">
          {value.trim() ? <Markdown text={value} className="!text-[13px]" /> : <p className="text-[12.5px] text-fg-4">Nothing written yet.</p>}
        </div>
      ) : (
        <TextArea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => void save(value)}
          placeholder={`# ${bot.name}\n\nWho ${bot.name} is, how it speaks, what it values and what it won't do.`}
          aria-label="Soul"
          spellCheck
          className="min-h-[280px] text-[13px] leading-[1.6]"
          rows={14}
        />
      )}
      <p className="mt-1.5 text-[12px] text-fg-3">{bot.name} reads its soul at the start of every turn. Other bots only see the description.</p>
      {expanded && (
        <SoulDialog
          name={bot.name}
          value={value}
          onChange={setValue}
          onClose={() => {
            setExpanded(false)
            void save(latest.current)
          }}
        />
      )}
    </div>
  )
}

export function ProfileTab({ bot }: { bot: Bot }) {
  const conversations = useData((s) => s.conversations)
  const dm = findDm(conversations, bot.id)

  const exportRecipe = async () => {
    const recipe = await attempt('bots:export-recipe', { id: bot.id }, "Couldn't export the bot.")
    if (!recipe) return
    const blob = new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${bot.handle}.faibots-bot.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast(`Exported ${bot.name}`, 'success')
  }

  return (
    <div className={`bot-${bot.avatar.color} space-y-5 p-4`}>
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          onClick={() => useUi.setState({ avatarEditorBotId: bot.id })}
          aria-label="Edit Bot avatar"
          title="Edit avatar"
          className="group relative rounded-[30%]"
        >
          <BotAvatar bot={bot} size={64} />
          <span className="absolute inset-x-0 -bottom-1 mx-auto w-fit rounded-full bg-elevated px-1.5 py-px text-2xs font-medium text-fg-2 opacity-0 shadow-pop transition-opacity group-hover:opacity-100">
            Edit
          </span>
        </button>
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold text-bot-fg">{bot.name}</div>
          <div className="truncate text-[12.5px] text-fg-3">@{bot.handle}</div>
        </div>
      </div>

      {!bot.isPrimary && (
        <div className="grid grid-cols-2 gap-3">
          <BotTextField bot={bot} field="name" label="Name" />
          <BotTextField bot={bot} field="handle" label="Handle" prefix="@" />
        </div>
      )}
      <BotTextField bot={bot} field="label" label="Label" placeholder="Add a label" hint="For example: Research, marketing, admin" />
      <BotTextField
        bot={bot}
        field="description"
        label="Description"
        placeholder="Add a description"
        multiline
        hint={`Other bots read this to decide when to ask ${bot.name} for help.`}
      />

      <SoulEditor bot={bot} />

      <ModelPicker bot={bot} />

      <div className="divide-y divide-line-soft rounded-xl border border-line-soft px-3">
        <SettingRow title="Notifications" description="Get notified when this Bot finishes or is waiting for you.">
          <Toggle label="Notifications" checked={bot.notify} onChange={(v) => void updateBot(bot.id, { notify: v })} />
        </SettingRow>
        <SettingRow
          title="Daily limit for automatic runs"
          description="Most routine runs and requests from other bots per day. Your own messages never count. 0 = no limit."
        >
          <DailyLimitInput bot={bot} />
        </SettingRow>
      </div>

      <div className="flex flex-wrap gap-2 border-t border-line-soft pt-4">
        <Button size="sm" icon={Download} onClick={() => void exportRecipe()}>
          Export recipe
        </Button>
        {dm && (
          <Button size="sm" icon={RotateCcw} onClick={() => void confirmReset(dm)}>
            Reset conversation
          </Button>
        )}
        {!bot.isPrimary && (
          <Button size="sm" variant="danger-ghost" icon={Trash} onClick={() => void confirmDeleteBot(bot)}>
            Delete Bot
          </Button>
        )}
      </div>
    </div>
  )
}
