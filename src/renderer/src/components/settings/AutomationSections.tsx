// Settings for the phase 2 features: keeping FaiBots running for routines, local webhooks, an
// overview of every routine, and usage from the turn log.

import { AlarmClock, CircleCheck, CircleX } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Id, UsageRow } from '@shared/domain'
import { describeSchedule } from '@shared/routines'
import { invoke } from '../../lib/bridge'
import { billingFor } from '../../lib/providers'
import { compactNumber, upcoming } from '../../lib/format'
import { useAsync } from '../../lib/hooks'
import { openBot, saveSettings } from '../../store/actions'
import { useData } from '../../store/data'
import { openDetails, useUi } from '../../store/ui'
import { BotAvatar } from '../avatar/BotAvatar'
import { BillingBadge, EmptyState } from '../ui/Badge'
import { TextInput } from '../ui/Field'
import { Segmented, SettingRow, Toggle } from '../ui/Toggle'

// ---------------------------------------------------------------------------------------------
// Background & routines
// ---------------------------------------------------------------------------------------------

export function BackgroundSection() {
  const s = useData((st) => st.settings)
  if (!s) return null
  const bg = s.background
  return (
    <div className="max-w-[680px] space-y-6">
      <div className="divide-y divide-line-soft rounded-xl border border-line-soft px-4">
        <SettingRow
          title="Keep running in the tray"
          description="Closing the window hides faibots next to the clock, so routines and webhooks keep working. Quit from the tray icon."
        >
          <Toggle label="Keep running in the tray" checked={bg.keepRunning} onChange={(keepRunning) => void saveSettings({ background: { ...bg, keepRunning } })} />
        </SettingRow>
        <SettingRow title="Start when you sign in" description="Opens faibots in the tray when you sign in to this computer. Works in the installed app.">
          <Toggle
            label="Start when you sign in"
            checked={bg.openAtLogin}
            disabled={!bg.keepRunning}
            onChange={(openAtLogin) => void saveSettings({ background: { ...bg, openAtLogin } })}
          />
        </SettingRow>
        <SettingRow title="Pause all routines" description="Planned runs are skipped until you turn this off. Run now and webhooks still work.">
          <Toggle label="Pause all routines" checked={bg.routinesPaused} onChange={(routinesPaused) => void saveSettings({ background: { ...bg, routinesPaused } })} />
        </SettingRow>
      </div>

      <WebhookSettings />
      <AllRoutines />
    </div>
  )
}

function WebhookSettings() {
  const s = useData((st) => st.settings)!
  const status = useAsync(() => invoke('routines:webhook-status', undefined), [s.webhooks.enabled, s.webhooks.port])
  const [port, setPort] = useState(String(s.webhooks.port))
  useEffect(() => setPort(String(s.webhooks.port)), [s.webhooks.port])
  // The server starts a moment after the setting saves; look again shortly after.
  useEffect(() => {
    const t = setTimeout(() => status.reload(), 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.webhooks.enabled, s.webhooks.port])

  const savePort = () => {
    const n = Math.round(Number(port))
    if (n === s.webhooks.port) return
    void saveSettings({ webhooks: { ...s.webhooks, port: n } })
  }

  const st = status.data
  return (
    <section>
      <div className="mb-1 text-ui font-medium text-fg">Webhooks</div>
      <p className="mb-3 text-[12.5px] text-fg-3">
        Let apps on this computer (n8n, scripts, a scheduled task) start a routine. Each routine has its own address and token, set in the routine. Only this computer can reach it, and web pages are refused.
      </p>
      <div className="divide-y divide-line-soft rounded-xl border border-line-soft px-4">
        <SettingRow title="Accept webhook calls" description="Listens on 127.0.0.1 only.">
          <Toggle label="Accept webhook calls" checked={s.webhooks.enabled} onChange={(enabled) => void saveSettings({ webhooks: { ...s.webhooks, enabled } })} />
        </SettingRow>
        <SettingRow title="Port" description="Change it if another app already uses this one.">
          <TextInput
            type="number"
            min={1024}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            onBlur={savePort}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            aria-label="Webhook port"
            className="!w-[96px] text-right tabular-nums"
            mono
          />
        </SettingRow>
      </div>
      {s.webhooks.enabled && st && (
        <p className="mt-2 flex items-center gap-1.5 text-[12px]">
          {st.listening ? (
            <>
              <CircleCheck size={13} className="text-success-fg" />
              <span className="text-fg-2">
                Listening on <code className="font-mono">http://127.0.0.1:{st.port}</code>
              </span>
            </>
          ) : (
            <>
              <CircleX size={13} className="text-danger-fg" />
              <span className="text-danger-fg">{st.error ?? 'Not listening yet.'}</span>
            </>
          )}
        </p>
      )}
    </section>
  )
}

function AllRoutines() {
  const botMap = useData((st) => st.botMap)
  const versions = useData((st) => st.versions.routines)
  const total = Object.values(versions).reduce((a, b) => a + b, 0)
  const routines = useAsync(() => invoke('routines:list', {}), [total])
  const list = routines.data ?? []
  const go = (botId: Id) => {
    useUi.setState({ settingsSection: null })
    void openBot(botId).then(() => openDetails('routines'))
  }
  return (
    <section>
      <div className="mb-1 text-ui font-medium text-fg">All routines</div>
      <p className="mb-3 text-[12.5px] text-fg-3">Every task your bots run on their own. Create and edit them in a bot's Routines tab, or ask a bot in its chat.</p>
      {list.length === 0 ? (
        <EmptyState icon={AlarmClock} title="No routines yet">
          Open a bot, then its Routines tab.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
          {list.map((r) => {
            const bot = botMap.get(r.botId)
            return (
              <li key={r.id}>
                <button type="button" onClick={() => go(r.botId)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-hover">
                  {bot && <BotAvatar bot={bot} size={24} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-ui font-medium text-fg">{r.name}</span>
                    <span className="block truncate text-[12px] text-fg-3">
                      {bot?.name ?? 'A bot'} · {describeSchedule(r.schedule)}
                    </span>
                  </span>
                  <span className="shrink-0 text-[12px] text-fg-3">
                    {r.schedule.kind === 'manual' ? 'When started' : r.enabled && r.nextRunAt ? `Next ${upcoming(r.nextRunAt)}` : 'Off'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------------------------

type Range = '1' | '7' | '30'

interface BotTotals {
  botId: Id
  turns: number
  automaticTurns: number
  errors: number
  inputTokens: number
  outputTokens: number
  unreportedTurns: number
  providerIds: Set<Id>
}

function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function UsageSection() {
  const [range, setRange] = useState<Range>('7')
  const days = Number(range)
  const usage = useAsync(() => invoke('usage:summary', { days }), [days])
  const botMap = useData((st) => st.botMap)
  const providers = useData((st) => st.providers)
  const rows: UsageRow[] = usage.data?.rows ?? []

  const totals = useMemo(() => {
    const t = { turns: 0, automaticTurns: 0, inputTokens: 0, outputTokens: 0, errors: 0, unreportedTurns: 0, legacyCodexTurns: 0 }
    for (const r of rows) {
      t.turns += r.turns
      t.automaticTurns += r.automaticTurns
      t.inputTokens += r.inputTokens
      t.outputTokens += r.outputTokens
      t.errors += r.errors
      t.unreportedTurns += r.unreportedTurns ?? 0
      t.legacyCodexTurns += r.legacyCodexTurns ?? 0
    }
    return t
  }, [rows])

  const perBot = useMemo(() => {
    const map = new Map<Id, BotTotals>()
    for (const r of rows) {
      const b = map.get(r.botId) ?? { botId: r.botId, turns: 0, automaticTurns: 0, errors: 0, inputTokens: 0, outputTokens: 0, unreportedTurns: 0, providerIds: new Set<Id>() }
      b.turns += r.turns
      b.automaticTurns += r.automaticTurns
      b.errors += r.errors
      b.unreportedTurns += r.unreportedTurns ?? 0
      b.inputTokens += r.inputTokens
      b.outputTokens += r.outputTokens
      if (r.providerId) b.providerIds.add(r.providerId)
      map.set(r.botId, b)
    }
    return [...map.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
  }, [rows])

  const daily = useMemo(() => {
    const out: { day: string; label: string; tokens: number; turns: number }[] = []
    const today = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
      const key = localDay(d.getTime())
      const dayRows = rows.filter((r) => r.day === key)
      out.push({
        day: key,
        label: d.toLocaleDateString(undefined, days > 7 ? { day: 'numeric' } : { weekday: 'short' }),
        tokens: dayRows.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0),
        turns: dayRows.reduce((n, r) => n + r.turns, 0)
      })
    }
    return out
  }, [rows, days])

  const routeOf = (providerIds: Set<Id>) => {
    const kinds = [...providerIds].map((id) => providers.find((p) => p.id === id)).filter((p) => !!p)
    return kinds.length === 1 ? billingFor(kinds[0]!) : kinds.length > 1 ? 'mixed' : 'unknown'
  }

  return (
    <div className="max-w-[720px] space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-fg-3">Every bot turn that reached a model, with its tokens. Subscription and local routes cost no extra money; API keys bill per token.</p>
        <Segmented
          label="Period"
          size="sm"
          value={range}
          onChange={setRange}
          options={[
            { value: '1', label: 'Today' },
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' }
          ]}
        />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <Stat label="Turns" value={totals.turns.toLocaleString()} />
        <Stat label="Automatic runs" value={totals.automaticTurns.toLocaleString()} hint="Routines and bot-to-bot" />
        <Stat label="Tokens in" value={totals.turns && totals.unreportedTurns === totals.turns ? 'Unknown' : compactNumber(totals.inputTokens)} />
        <Stat label="Tokens out" value={totals.turns && totals.unreportedTurns === totals.turns ? 'Unknown' : compactNumber(totals.outputTokens)} />
      </div>

      {totals.unreportedTurns > 0 && <p className="text-xs text-fg-3">Token totals exclude unreported usage from {totals.unreportedTurns} turns.</p>}
      {totals.legacyCodexTurns > 0 && <p className="text-xs text-fg-3">Historical Codex counts from {totals.legacyCodexTurns} turns may include earlier tokens from the same chat.</p>}
      {days > 1 && <DailyBars data={daily} />}

      {usage.error && <p className="text-[12px] text-danger-fg">Couldn't load usage: {usage.error}</p>}
      {perBot.length === 0 && !usage.loading ? (
        <EmptyState title="Nothing yet">Usage shows up here after your bots answer.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line-soft">
          <table className="w-full text-ui">
            <thead className="bg-hover/60 text-left text-[11.5px] text-fg-3">
              <tr>
                <th className="px-3 py-2 font-medium">Bot</th>
                <th className="px-3 py-2 font-medium">Route</th>
                <th className="px-3 py-2 text-right font-medium">Turns</th>
                <th className="px-3 py-2 text-right font-medium">Automatic</th>
                <th className="px-3 py-2 text-right font-medium">Tokens in</th>
                <th className="px-3 py-2 text-right font-medium">Tokens out</th>
                <th className="px-3 py-2 text-right font-medium">Errors</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {perBot.map((b) => {
                const bot = botMap.get(b.botId)
                const route = routeOf(b.providerIds)
                return (
                  <tr key={b.botId}>
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        {bot && <BotAvatar bot={bot} size={20} />}
                        <span className="truncate text-fg">{bot?.name ?? 'A deleted bot'}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2">{route === 'mixed' ? <span className="text-[12px] text-fg-3">Several</span> : <BillingBadge route={route} />}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg">{b.turns.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg-2">{b.automaticTurns.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg-2" title={b.inputTokens.toLocaleString()}>
                      {b.unreportedTurns === b.turns ? 'Unknown' : compactNumber(b.inputTokens)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg-2" title={b.outputTokens.toLocaleString()}>
                      {b.unreportedTurns === b.turns ? 'Unknown' : compactNumber(b.outputTokens)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-fg-3">{b.errors || '–'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line-soft px-3.5 py-3" title={hint}>
      <div className="text-[11.5px] text-fg-3">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tabular-nums tracking-[-0.01em] text-fg">{value}</div>
    </div>
  )
}

/** Tokens per day: one series, so one ink colour and no legend; the title names it. */
function DailyBars({ data }: { data: { day: string; label: string; tokens: number; turns: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...data.map((d) => d.tokens))
  const H = 96
  const shown = hover !== null ? data[hover] : undefined
  return (
    <figure>
      <figcaption className="mb-2 flex items-baseline justify-between text-[12px]">
        <span className="font-medium text-fg-2">Tokens per day</span>
        <span className="tabular-nums text-fg-3">
          {shown ? `${new Date(shown.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}: ${shown.tokens.toLocaleString()} tokens, ${shown.turns} turns` : `Peak ${compactNumber(max)}`}
        </span>
      </figcaption>
      <div className="flex items-end gap-[2px] border-b border-line-soft" style={{ height: H }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div
            key={d.day}
            className="flex h-full min-w-0 flex-1 cursor-default items-end"
            onMouseEnter={() => setHover(i)}
            aria-label={`${d.day}: ${d.tokens} tokens`}
          >
            <div
              className="mx-auto w-full max-w-[28px] rounded-t-[4px] bg-fg-2 transition-opacity"
              style={{ height: d.tokens ? Math.max(2, (d.tokens / max) * (H - 4)) : 0, opacity: hover === null || hover === i ? 0.85 : 0.35 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10.5px] text-fg-4">
        {data.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 truncate text-center">
            {data.length <= 7 || i % 5 === 0 || i === data.length - 1 ? d.label : ''}
          </span>
        ))}
      </div>
    </figure>
  )
}
