// A bot's routines: tasks it runs on its own, on a schedule, when you press Run, or when another
// app calls its webhook. Each run happens in the bot's chat; the history shows how runs went.

import clsx from 'clsx'
import { AlarmClock, Ban, ChevronDown, CircleCheck, CircleMinus, CircleX, Copy, Pencil, Play, Plus, Trash, Webhook } from 'lucide-react'
import { useRef, useState } from 'react'
import {
  MIN_ROUTINE_INTERVAL_MINUTES,
  type Bot,
  type Routine,
  type RoutineRun,
  type RoutineSchedule
} from '@shared/domain'
import { describeSchedule, EVERY_DAY, WEEKDAYS } from '@shared/routines'
import { invoke } from '../../lib/bridge'
import { duration, relative, upcoming } from '../../lib/format'
import { useAsync } from '../../lib/hooks'
import { attempt, openBot, run, saveSettings } from '../../store/actions'
import { modelSetupIssue } from '../../lib/providers'
import { ModelSetupPrompt } from './ModelPicker'
import { useData } from '../../store/data'
import { confirmDialog, toast, useUi } from '../../store/ui'
import { EmptyState, Spinner } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, Select, TextArea, TextInput } from '../ui/Field'
import { Segmented, Toggle } from '../ui/Toggle'

export function RoutinesTab({ bot }: { bot: Bot }) {
  const version = useData((s) => s.versions.routines[bot.id] ?? 0)
  const settings = useData((s) => s.settings)
  const routines = useAsync(() => invoke('routines:list', { botId: bot.id }), [bot.id, version])
  const providers = useData((s) => s.providers)
  const setup = modelSetupIssue(bot.model, providers)
  const [editing, setEditing] = useState<Routine | 'new' | null>(null)
  const list = routines.data ?? []

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12px] leading-relaxed text-fg-3">
          Tasks {bot.name} does on its own: on a schedule, when you press Run, or when another app calls it. Each run happens in {bot.name}'s chat.
        </p>
        <Button size="sm" icon={Plus} onClick={() => setEditing('new')} className="shrink-0">
          New
        </Button>
      </div>

      {setup && <ModelSetupPrompt key={bot.id} bot={bot} issue={setup} />}
      {settings && !settings.background.keepRunning && list.some((r) => r.enabled && r.schedule.kind !== 'manual') && (
        <Notice>
          Routines only run while faibots is open.{' '}
          <button
            type="button"
            className="font-medium text-fg underline underline-offset-2"
            onClick={() => void saveSettings({ background: { ...settings.background, keepRunning: true } })}
          >
            Keep it running in the tray
          </button>
        </Notice>
      )}
      {settings?.background.routinesPaused && (
        <Notice>
          All routines are paused.{' '}
          <button
            type="button"
            className="font-medium text-fg underline underline-offset-2"
            onClick={() => void saveSettings({ background: { ...settings.background, routinesPaused: false } })}
          >
            Resume
          </button>
        </Notice>
      )}

      {routines.error && <p className="text-[12px] text-danger-fg">Couldn't load routines: {routines.error}</p>}
      {list.length === 0 && !routines.loading ? (
        <EmptyState
          icon={AlarmClock}
          title="No routines yet"
          action={
            <Button size="sm" icon={Plus} onClick={() => setEditing('new')}>
              New routine
            </Button>
          }
        >
          For example a morning brief on weekdays at 08:00. You can also ask {bot.name} in the chat to schedule one.
        </EmptyState>
      ) : (
        <ul className="space-y-2.5">
          {list.map((r) => (
            <RoutineCard key={r.id} routine={r} bot={bot} ready={!setup} version={version} onEdit={() => setEditing(r)} onChanged={routines.reload} />
          ))}
        </ul>
      )}

      <p className="text-[11.5px] text-fg-4">
        {bot.dailyRunLimit > 0
          ? `${bot.name} does at most ${bot.dailyRunLimit} automatic runs a day. Change it in Profile.`
          : `No daily limit on automatic runs. Set one in ${bot.name}'s Profile to cap what routines can spend.`}
      </p>

      {editing && (
        <RoutineEditor
          bot={bot}
          ready={!setup}
          routine={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            routines.reload()
          }}
        />
      )}
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] text-fg-2">{children}</div>
}

// ---------------------------------------------------------------------------------------------
// One routine
// ---------------------------------------------------------------------------------------------

function RoutineCard({
  routine,
  bot,
  version,
  ready,
  onEdit,
  onChanged
}: {
  routine: Routine
  bot: Bot
  version: number
  ready: boolean
  onEdit: () => void
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [starting, setStarting] = useState(false)
  const runs = useAsync(() => invoke('routines:runs', { routineId: routine.id, limit: open ? 20 : 1 }), [routine.id, version, open])
  const last = runs.data?.[0]
  const running = last?.status === 'running'

  const toggle = async (enabled: boolean) => {
    if (await attempt('routines:save', { ...routine, enabled }, "Couldn't change the routine.")) onChanged()
  }
  const runNow = async () => {
    if (starting || running || !ready) return
    setStarting(true)
    try {
      const started = await attempt('routines:run-now', { id: routine.id }, "Couldn't start the run.")
      if (started) {
        runs.reload()
        toast('Routine started', 'success')
      }
    } finally {
      setStarting(false)
    }
  }
  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete “${routine.name}”?`,
      body: 'Its run history goes too. The messages in the chat stay.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (ok && (await run('routines:delete', { id: routine.id }, "Couldn't delete."))) onChanged()
  }

  const when =
    routine.schedule.kind === 'manual'
      ? routine.webhookEnabled
        ? 'Runs when started or called by its webhook'
        : 'Runs when you start it'
      : routine.enabled && routine.nextRunAt
        ? `${describeSchedule(routine.schedule)} · next ${upcoming(routine.nextRunAt)}`
        : `${describeSchedule(routine.schedule)} · off`

  return (
    <li className="rounded-xl border border-line-soft">
      <div className="px-3 pb-2 pt-2.5">
        <div className="flex items-center gap-2">
          <AlarmClock size={14} className="shrink-0 text-fg-3" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{routine.name}</span>
          {routine.webhookEnabled && <Webhook size={13} className="shrink-0 text-fg-4" aria-label="Webhook on" />}
          {routine.schedule.kind !== 'manual' && (
            <Toggle size="sm" label={`Schedule for ${routine.name}`} checked={routine.enabled} disabled={!ready && !routine.enabled} onChange={(v) => void toggle(v)} />
          )}
        </div>
        <p className="mt-0.5 pl-[22px] text-[11.5px] text-fg-3">{when}</p>
        <p className="mt-1.5 line-clamp-2 pl-[22px] text-[12px] leading-snug text-fg-2">{routine.prompt}</p>
        <div className="mt-2 flex items-center gap-1 pl-[18px]">
          <Button size="sm" variant="ghost" icon={Play} onClick={() => void runNow()} disabled={starting || running || !ready} aria-busy={starting}>
            {starting ? 'Starting…' : running ? 'Running…' : 'Run now'}
          </Button>
          <IconButton size="sm" icon={Pencil} label="Edit routine" onClick={onEdit} />
          <IconButton size="sm" icon={Trash} label="Delete routine" tone="danger" onClick={() => void remove()} />
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[11.5px] text-fg-3 hover:bg-hover hover:text-fg"
          >
            {last ? <RunStatusIcon status={last.status} /> : null}
            {last ? (last.status === 'running' ? 'Running' : `${STATUS_LABEL[last.status]} · ${relative(last.startedAt)}`) : 'No runs yet'}
            <ChevronDown size={12} className={clsx('transition-transform', open && 'rotate-180')} />
          </button>
        </div>
      </div>
      {routine.createdBy === 'bot' && !open && <p className="border-t border-line-soft px-3 py-1.5 text-[11px] text-fg-4">{bot.name} set this up in the chat.</p>}
      {open && <RunHistory runs={runs.data ?? []} loading={runs.loading} bot={bot} />}
    </li>
  )
}

const STATUS_LABEL: Record<RoutineRun['status'], string> = {
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Stopped'
}

const TRIGGER_LABEL: Record<RoutineRun['trigger'], string> = {
  schedule: 'on schedule',
  manual: 'started by you',
  webhook: 'by webhook',
  'catch-up': 'caught up after a restart'
}

function RunStatusIcon({ status }: { status: RoutineRun['status'] }) {
  if (status === 'running') return <Spinner size={11} className="text-fg-3" />
  if (status === 'done') return <CircleCheck size={12} className="text-success-fg" aria-label="Done" />
  if (status === 'error') return <CircleX size={12} className="text-danger-fg" aria-label="Failed" />
  if (status === 'cancelled') return <Ban size={12} className="text-fg-4" aria-label="Stopped" />
  return <CircleMinus size={12} className="text-fg-4" aria-label="Skipped" />
}

function RunHistory({ runs, loading, bot }: { runs: RoutineRun[]; loading: boolean; bot: Bot }) {
  if (runs.length === 0) {
    return <p className="border-t border-line-soft px-3 py-2.5 text-[12px] text-fg-3">{loading ? 'Loading…' : 'No runs yet. Press Run now to try it.'}</p>
  }
  return (
    <ul className="divide-y divide-line-soft border-t border-line-soft">
      {runs.map((r) => (
        <li key={r.id} className="px-3 py-2">
          <div className="flex items-center gap-1.5 text-[11.5px]">
            <RunStatusIcon status={r.status} />
            <span className="font-medium text-fg-2">{STATUS_LABEL[r.status]}</span>
            <span className="min-w-0 truncate text-fg-4">
              · {relative(r.startedAt)} · {TRIGGER_LABEL[r.trigger]}
              {r.endedAt && r.status !== 'skipped' ? ` · ${duration(r.endedAt - r.startedAt)}` : ''}
            </span>
            <span className="flex-1" />
            {r.conversationId && r.status !== 'skipped' && (
              <button type="button" className="shrink-0 whitespace-nowrap text-[11px] text-fg-3 hover:text-fg hover:underline" onClick={() => void openBot(bot.id)}>
                Open chat
              </button>
            )}
          </div>
          {(r.summary || r.error) && (
            <p className={clsx('mt-1 line-clamp-3 pl-[18px] text-[12px] leading-snug', r.status === 'error' ? 'text-danger-fg' : 'text-fg-3')}>
              {r.summary || r.error}
            </p>
          )}
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------

type Mode = 'daily' | 'interval' | 'manual'
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function RoutineEditor({ bot, routine, ready, onClose, onSaved }: { bot: Bot; routine?: Routine; ready: boolean; onClose: () => void; onSaved: () => void }) {
  const initial = routine?.schedule ?? { kind: 'daily', time: '08:00', days: WEEKDAYS }
  const [name, setName] = useState(routine?.name ?? '')
  const [prompt, setPrompt] = useState(routine?.prompt ?? '')
  const [mode, setMode] = useState<Mode>(initial.kind)
  const [time, setTime] = useState(initial.kind === 'daily' ? initial.time : '08:00')
  const [days, setDays] = useState<number[]>(initial.kind === 'daily' ? initial.days : WEEKDAYS)
  const [every, setEvery] = useState(() => (initial.kind === 'interval' ? (initial.everyMinutes % 60 === 0 ? initial.everyMinutes / 60 : initial.everyMinutes) : 1))
  const [unit, setUnit] = useState<'minutes' | 'hours'>(initial.kind === 'interval' && initial.everyMinutes % 60 !== 0 ? 'minutes' : 'hours')
  const [webhook, setWebhook] = useState(routine?.webhookEnabled ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<{ token: string; url: string } | null>(null)
  const savedId = useRef(routine?.id)
  const issuedToken = useRef<{ token: string; url: string } | null>(null)

  const schedule = (): RoutineSchedule =>
    mode === 'manual'
      ? { kind: 'manual' }
      : mode === 'interval'
        ? { kind: 'interval', everyMinutes: Math.round(every * (unit === 'hours' ? 60 : 1)) }
        : { kind: 'daily', time, days }

  let preview = ''
  try {
    preview = describeSchedule(schedule())
  } catch {
    preview = ''
  }

  const startsSchedule = mode !== 'manual' && (!routine || routine.schedule.kind === 'manual')
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const needsToken = webhook && !routine?.hasWebhookToken
      const input = {
        botId: bot.id,
        name,
        prompt,
        schedule: schedule(),
        webhookEnabled: webhook && !needsToken,
        enabled: startsSchedule && !ready ? false : (routine?.enabled ?? true)
      }
      const saved = await invoke('routines:save', { ...input, id: savedId.current })
      savedId.current = saved.id
      if (needsToken) {
        // Retain the record and any issued token across a retry of the enable step.
        issuedToken.current ??= await invoke('routines:webhook-token', { id: saved.id })
        await invoke('routines:save', { ...input, id: saved.id, webhookEnabled: true })
        setToken(issuedToken.current)
        return
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (token) return <WebhookTokenDialog name={name} token={token} onClose={onSaved} />

  return (
    <Dialog
      title={routine ? `Edit “${routine.name}”` : `New routine for ${bot.name}`}
      description={`${bot.name} gets the task in its chat on every run and answers with its own tools, memory and skills.`}
      onClose={onClose}
      width={540}
      footer={
        <>
          {error && <span className="mr-auto text-[12px] text-danger-fg">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={saving || !name.trim() || !prompt.trim()}>
            {saving ? 'Saving…' : routine ? 'Save' : 'Create routine'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!ready && startsSchedule && <Notice>This schedule will be saved off. Set up the bot’s model, then turn on its schedule.</Notice>}
        {!ready && !startsSchedule && mode !== 'manual' && routine?.enabled && (
          <Notice>This schedule is on. Set up the bot’s model so its runs can finish.</Notice>
        )}
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning brief" maxLength={80} autoFocus data-autofocus />
        </Field>
        <Field label="Task" hint="Write it so it stands on its own: on a run the bot sees its chat history, memory and skills, but nobody answers questions.">
          <TextArea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            autoGrow
            placeholder="Read my calendar and open issues. Give me the three things that matter most today, in one short list."
          />
        </Field>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-ui font-medium text-fg">When</span>
            <Segmented
              size="sm"
              label="When"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'daily', label: 'At a time' },
                { value: 'interval', label: 'Repeat' },
                { value: 'manual', label: 'Only when started' }
              ]}
            />
          </div>
          {mode === 'daily' && (
            <div className="space-y-3 rounded-xl border border-line-soft p-3">
              <div className="flex items-center gap-3">
                <TextInput type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Time" className="!w-[120px]" />
                <span className="flex gap-1">
                  {DAY_LETTERS.map((letter, d) => {
                    const on = days.includes(d)
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        aria-label={DAY_NAMES[d]}
                        title={DAY_NAMES[d]}
                        onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d].sort())}
                        className={clsx(
                          'h-7 w-7 rounded-full text-[11.5px] font-medium transition-colors',
                          on ? 'bg-ink text-on-ink' : 'bg-hover text-fg-3 hover:text-fg'
                        )}
                      >
                        {letter}
                      </button>
                    )
                  })}
                </span>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setDays(WEEKDAYS)}>
                  Weekdays
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDays(EVERY_DAY)}>
                  Every day
                </Button>
              </div>
            </div>
          )}
          {mode === 'interval' && (
            <div className="flex items-center gap-2 rounded-xl border border-line-soft p-3">
              <span className="text-ui text-fg-2">Every</span>
              <TextInput
                type="number"
                min={unit === 'hours' ? 1 : MIN_ROUTINE_INTERVAL_MINUTES}
                value={every}
                onChange={(e) => setEvery(Number(e.target.value))}
                aria-label="Interval"
                className="!w-[80px]"
              />
              <Select value={unit} onChange={(e) => setUnit(e.target.value as 'minutes' | 'hours')} aria-label="Unit" className="!w-[110px]">
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
              </Select>
            </div>
          )}
          {mode === 'manual' && (
            <p className="rounded-xl border border-line-soft p-3 text-[12px] text-fg-3">No schedule. It runs when you press Run now, or when another app calls its webhook.</p>
          )}
          {preview && mode !== 'manual' && <p className="mt-1.5 text-[11.5px] text-fg-4">{preview}, your local time.</p>}
        </div>

        <WebhookSetting checked={webhook} onChange={setWebhook} routine={routine} />
      </div>
    </Dialog>
  )
}

function WebhookSetting({ checked, onChange, routine }: { checked: boolean; onChange: (v: boolean) => void; routine?: Routine }) {
  const settings = useData((s) => s.settings)
  const [token, setToken] = useState<{ token: string; url: string } | null>(null)
  const serverOff = settings && !settings.webhooks.enabled

  const regenerate = async () => {
    if (!routine) return
    const ok = await confirmDialog({
      title: 'Make a new token?',
      body: 'Apps using the old token stop working until you give them the new one.',
      confirmLabel: 'Make new token'
    })
    if (!ok) return
    const t = await attempt('routines:webhook-token', { id: routine.id }, "Couldn't make a token.")
    if (t) setToken(t)
  }

  return (
    <div className="rounded-xl border border-line-soft p-3">
      <div className="flex items-start gap-3">
        <Webhook size={15} className="mt-0.5 shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-fg">Let other apps start it</div>
          <p className="mt-0.5 text-[12px] text-fg-3">
            A local web address with its own token, for n8n, scripts or a scheduled task on this computer. What they send reaches the bot as data, not as orders.
          </p>
          {checked && serverOff && (
            <p className="mt-1.5 text-[12px] text-warn-fg">
              Webhooks are off for the app.{' '}
              <button type="button" className="underline underline-offset-2" onClick={() => useUi.setState({ settingsSection: 'background' })}>
                Turn them on in Settings
              </button>
            </p>
          )}
          {checked && routine?.hasWebhookToken && routine.webhookEnabled && (
            <Button size="sm" variant="ghost" className="-ml-2 mt-1" onClick={() => void regenerate()}>
              Show address and make a new token
            </Button>
          )}
        </div>
        <Toggle label="Let other apps start it" checked={checked} onChange={onChange} />
      </div>
      {token && <WebhookTokenDialog name={routine?.name ?? ''} token={token} onClose={() => setToken(null)} />}
    </div>
  )
}

function WebhookTokenDialog({ name, token, onClose }: { name: string; token: { token: string; url: string }; onClose: () => void }) {
  const isWindows = useData((s) => s.appInfo?.platform === 'win32')
  const example = isWindows
    ? `curl.exe -X POST "${token.url}" -H "Authorization: Bearer ${token.token}" -H "Content-Type: application/json" -d "{\\"text\\": \\"Build 1432 failed\\"}"`
    : `curl -X POST '${token.url}' -H 'Authorization: Bearer ${token.token}' -H 'Content-Type: application/json' -d '{"text": "Build 1432 failed"}'`
  const copy = (text: string, what: string) => void navigator.clipboard?.writeText(text).then(() => toast(`Copied the ${what}`, 'success'))
  return (
    <Dialog
      title={`Webhook for “${name}”`}
      description="Copy the token now: faibots keeps only a fingerprint of it and cannot show it again."
      onClose={onClose}
      width={600}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-3">
        <CopyRow label="Address (POST)" value={token.url} onCopy={() => copy(token.url, 'address')} />
        <CopyRow label="Token (Authorization: Bearer …)" value={token.token} onCopy={() => copy(token.token, 'token')} secret />
        <Field label="Try it">
          <div className="flex items-start gap-2">
            <pre className="selectable min-w-0 flex-1 overflow-x-auto rounded-lg bg-hover px-3 py-2 font-mono text-[11.5px] text-fg-2">{example}</pre>
            <IconButton icon={Copy} label="Copy the example" onClick={() => copy(example, 'example')} />
          </div>
        </Field>
        <p className="text-[12px] text-fg-3">Only apps on this computer can reach it. Web pages are refused. At most 30 runs an hour.</p>
      </div>
    </Dialog>
  )
}

function CopyRow({ label, value, onCopy, secret }: { label: string; value: string; onCopy: () => void; secret?: boolean }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <code className={clsx('selectable min-w-0 flex-1 truncate rounded-lg bg-hover px-3 py-2 font-mono text-[12px]', secret ? 'text-fg' : 'text-fg-2')}>{value}</code>
        <IconButton icon={Copy} label={`Copy the ${label.split(' ')[0]!.toLowerCase()}`} onClick={onCopy} />
      </div>
    </Field>
  )
}
