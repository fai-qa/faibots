// Group members (add / remove) and the room settings: who answers, rounds, post budget.

import { MessageSquare, Minus, Plus, RotateCcw, Trash, UserMinus, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import { MAX_GROUP_BOTS, type Conversation, type GroupSettings, type GroupTurnPolicy } from '@shared/domain'
import { useData } from '../../store/data'
import { confirmDialog, openDetails } from '../../store/ui'
import { openBot, updateConversation } from '../../store/actions'
import { conversationTitle, membersOf } from '../../lib/bots'
import { useDraftValue } from '../../lib/hooks'
import { plural } from '../../lib/format'
import { BotAvatar, GroupAvatar } from '../avatar/BotAvatar'
import { Button, IconButton } from '../ui/Button'
import { Floating } from '../ui/Popover'
import { TextArea, TextInput } from '../ui/Field'
import { SettingRow, Segmented, Toggle } from '../ui/Toggle'
import { confirmDeleteGroup, confirmReset } from '../sidebar/SidebarRow'

const POLICY_HINTS: Record<GroupTurnPolicy, string> = {
  open: 'Every bot reads each message and replies, or passes when it has nothing to add.',
  mentions: 'Only @mentioned bots reply. With no mention, the primary bot answers.',
  router: 'A quick model call picks which bots should answer.'
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <IconButton size="sm" icon={Minus} label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)} />
      <span className="w-7 text-center text-ui font-semibold tabular-nums text-fg" aria-live="polite">
        {value}
      </span>
      <IconButton size="sm" icon={Plus} label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)} />
    </div>
  )
}

export function GroupPanel({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const botMap = useData((s) => s.botMap)
  const bots = useData((s) => s.bots)
  const members = membersOf(conv, botMap)
  const settings = conv.group
  const [title, setTitle] = useDraftValue(conv.title, conv.id)
  const [notes, setNotes] = useDraftValue(conv.notes, conv.id)
  const [picker, setPicker] = useState<DOMRect | null>(null)
  const candidates = bots.filter((b) => !conv.botIds.includes(b.id))
  const full = conv.botIds.length >= MAX_GROUP_BOTS

  const setGroup = (patch: Partial<GroupSettings>) => void updateConversation(conv.id, { group: patch })
  const remove = async (id: string) => {
    const name = botMap.get(id)?.name ?? 'this bot'
    const ok = await confirmDialog({ title: `Remove ${name} from this conversation?`, body: `${name} keeps its memory and its own chats.`, confirmLabel: 'Remove', danger: true })
    if (ok) await updateConversation(conv.id, { botIds: conv.botIds.filter((x) => x !== id) })
  }

  return (
    <>
      <header className="drag flex h-[52px] shrink-0 items-center gap-2 border-b border-line-soft px-4">
        <h2 className="flex-1 text-[13.5px] font-semibold text-fg">Members</h2>
        <IconButton icon={X} label="Close details" onClick={onClose} />
      </header>
      <div className="scroll-y min-h-0 flex-1 space-y-6 p-4">
        <div className="flex items-center gap-3">
          <GroupAvatar bots={members} size={48} />
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[12.5px] font-medium text-fg-2">Group name</span>
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() !== conv.title && void updateConversation(conv.id, { title: title.trim() })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              placeholder={conversationTitle({ ...conv, title: '' }, botMap)}
            />
          </label>
        </div>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-fg">{plural(members.length, 'member')}</h3>
            <Button size="sm" icon={UserPlus} disabled={full || candidates.length === 0} onClick={(e) => setPicker(e.currentTarget.getBoundingClientRect())} title={full ? `A group can have up to ${MAX_GROUP_BOTS} bots` : undefined}>
              Add members
            </Button>
          </div>
          <ul className="space-y-px">
            {members.map((b) => (
              <li key={b.id} className={`bot-${b.avatar.color} group flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-hover`}>
                <button type="button" onClick={() => openDetails('profile', b.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" title={`${b.name}'s profile`}>
                  <BotAvatar bot={b} size={30} />
                  <span className="min-w-0">
                    <span className="block truncate text-ui font-medium text-bot-fg">{b.name}</span>
                    <span className="block truncate text-[12px] text-fg-3">{b.label || `@${b.handle}`}</span>
                  </span>
                </button>
                <span className="flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton size="sm" icon={MessageSquare} label={`Open ${b.name}'s chat`} onClick={() => void openBot(b.id)} />
                  <IconButton size="sm" icon={UserMinus} label={`Remove ${b.name}`} tone="danger" onClick={() => void remove(b.id)} disabled={members.length <= 1} />
                </span>
              </li>
            ))}
          </ul>
          {candidates.length === 0 && <p className="mt-2 px-2 text-[12px] text-fg-3">Create more Bots to add them here.</p>}
        </section>

        {settings && (
          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-fg">Who answers</h3>
            <Segmented<GroupTurnPolicy>
              label="Who answers"
              value={settings.turnPolicy}
              onChange={(turnPolicy) => setGroup({ turnPolicy })}
              options={[
                { value: 'open', label: 'Everyone reads' },
                { value: 'mentions', label: 'Mentions only' },
                { value: 'router', label: 'Router' }
              ]}
            />
            <p className="mt-2 text-[12px] text-fg-3">{POLICY_HINTS[settings.turnPolicy]}</p>

            <div className="mt-3 divide-y divide-line-soft rounded-xl border border-line-soft px-3">
              <SettingRow title="Rounds" description="Each message starts up to this many rounds. Later rounds let bots answer each other.">
                <Stepper label="Rounds" value={settings.maxRounds} min={1} max={6} onChange={(maxRounds) => setGroup({ maxRounds })} />
              </SettingRow>
              <SettingRow title="Post budget" description="The most bot messages one message of yours can lead to.">
                <Stepper label="Posts" value={settings.maxBotPosts} min={1} max={30} onChange={(maxBotPosts) => setGroup({ maxBotPosts })} />
              </SettingRow>
              <SettingRow title="Bots reply to each other" description="Bot posts can start another round.">
                <Toggle label="Bots reply to each other" checked={settings.allowBotToBot} onChange={(allowBotToBot) => setGroup({ allowBotToBot })} />
              </SettingRow>
              <SettingRow title="Answer at the same time" description="Off: bots take turns, one after another.">
                <Toggle label="Answer at the same time" checked={settings.parallel} onChange={(parallel) => setGroup({ parallel })} />
              </SettingRow>
            </div>
          </section>
        )}

        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-fg">Group notes</h3>
          <p className="mb-2 text-[12px] text-fg-3">Shared notes every member can read and update.</p>
          <TextArea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== conv.notes && void updateConversation(conv.id, { notes })}
            rows={4}
            autoGrow
            placeholder="Goals, decisions, who owns what"
            aria-label="Group notes"
          />
        </section>

        <div className="flex flex-wrap gap-2 border-t border-line-soft pt-4">
          <Button size="sm" icon={RotateCcw} onClick={() => void confirmReset(conv)}>
            Reset conversation
          </Button>
          <Button size="sm" variant="danger-ghost" icon={Trash} onClick={() => void confirmDeleteGroup(conv)}>
            Delete group
          </Button>
        </div>
      </div>

      {picker && (
        <Floating anchor={picker} placement="bottom-end" onClose={() => setPicker(null)}>
          <div className="max-h-[320px] w-[260px] overflow-y-auto rounded-xl border border-line bg-elevated p-1 shadow-pop" role="menu" aria-label="Add members">
            {candidates.map((b) => (
              <button
                key={b.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setPicker(null)
                  void updateConversation(conv.id, { botIds: [...conv.botIds, b.id] })
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
              >
                <BotAvatar bot={b} size={24} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-fg">{b.name}</span>
                  {b.label && <span className="block truncate text-[12px] text-fg-3">{b.label}</span>}
                </span>
              </button>
            ))}
          </div>
        </Floating>
      )}
    </>
  )
}
