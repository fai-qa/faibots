// "To:" bar: pick one bot for a 1:1 chat, several for a group, or type a name to create a bot.
// The group is created when you send the first message (or press "Create group chat").

import clsx from 'clsx'
import { Plus, Users, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { MAX_GROUP_BOTS, type Bot, type Id } from '@shared/domain'
import { useData } from '../../store/data'
import { goBack, navigate, useUi, type Draft } from '../../store/ui'
import { attempt, createBot, createGroup, sendMessage } from '../../store/actions'
import { upsertConversation } from '../../store/data'
import { joinNames } from '../../lib/format'
import { BotAvatar } from '../avatar/BotAvatar'
import { Button, IconButton } from '../ui/Button'
import { TextInput } from '../ui/Field'
import { Composer } from '../composer/Composer'

type Option = { kind: 'bot'; bot: Bot } | { kind: 'create'; name: string }

export function NewChatView() {
  const bots = useData((s) => s.bots)
  const botMap = useData((s) => s.botMap)
  const [picked, setPicked] = useState<Id[]>([])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [groupName, setGroupName] = useState('')
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const pickedBots = picked.map((id) => botMap.get(id)).filter((b): b is Bot => !!b)
  const q = query.trim().toLowerCase()
  const options: Option[] = useMemo(() => {
    const list: Option[] = bots
      .filter((b) => !picked.includes(b.id))
      .filter((b) => !q || `${b.name} ${b.handle} ${b.label}`.toLowerCase().includes(q))
      .sort((a, b) => Number(a.hidden) - Number(b.hidden) || Number(b.isPrimary) - Number(a.isPrimary) || a.name.localeCompare(b.name))
      .map((bot) => ({ kind: 'bot', bot }))
    if (q && !bots.some((b) => b.name.toLowerCase() === q)) list.push({ kind: 'create', name: query.trim() })
    return list
  }, [bots, picked, q, query])

  const close = () => (useUi.getState().back.length ? goBack() : navigate({ kind: 'home' }))
  const tooMany = picked.length > MAX_GROUP_BOTS

  const choose = async (o: Option) => {
    if (o.kind === 'bot') setPicked((p) => [...p, o.bot.id])
    else {
      const bot = await createBot(o.name)
      if (bot) setPicked((p) => [...p, bot.id])
    }
    setQuery('')
    setActive(0)
    inputRef.current?.focus()
  }

  const openDmWith = async (bot: Bot) => {
    const conv = await attempt('conv:open-dm', { botId: bot.id }, "Couldn't open the chat.")
    if (conv) upsertConversation(conv)
    return conv
  }

  const start = async (draft?: Draft) => {
    if (creating || !pickedBots.length || tooMany) return
    setCreating(true)
    try {
      const conv = pickedBots.length === 1 ? await openDmWith(pickedBots[0]!) : await createGroup(picked, groupName.trim() || undefined)
      if (!conv) {
        // Keep the draft and recipients so nothing is lost.
        if (draft) useUi.setState((s) => ({ drafts: { ...s.drafts, 'new-chat': draft } }))
        return
      }
      navigate({ kind: 'conversation', id: conv.id })
      if (draft) await sendMessage(conv, draft, pickedBots)
    } finally {
      setCreating(false)
    }
  }

  const composerPlaceholder =
    pickedBots.length === 0 ? 'Pick who to talk to first' : pickedBots.length === 1 ? `Message ${pickedBots[0]!.name}` : `Message ${joinNames(pickedBots.map((b) => b.name))}`

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-pane" aria-label="New chat">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-line-soft px-4">
        <h1 className="flex-1 text-[14px] font-semibold text-fg">New chat</h1>
        <IconButton icon={X} label="Close new chat" onClick={close} />
      </header>

      <div className="border-b border-line-soft px-4 py-2.5">
        <div className="mx-auto flex max-w-[820px] flex-wrap items-center gap-1.5" role="group" aria-label="Recipients" onClick={() => inputRef.current?.focus()}>
          <span className="mr-1 text-ui font-medium text-fg-3">To:</span>
          {pickedBots.map((b) => (
            <span key={b.id} className={`bot-${b.avatar.color} inline-flex h-7 items-center gap-1.5 rounded-full bg-bot-soft pl-1 pr-1.5 text-[12.5px] font-medium text-bot-fg`}>
              <BotAvatar bot={b} size={20} />
              {b.name}
              <button type="button" aria-label={`Remove ${b.name}`} onClick={() => setPicked((p) => p.filter((x) => x !== b.id))} className="rounded-full p-0.5 hover:bg-hover">
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, options.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const o = options[active]
                if (q && o) void choose(o)
                else if (!q && pickedBots.length) useUi.setState((s) => ({ focusComposer: s.focusComposer + 1 }))
              } else if (e.key === 'Backspace' && !query && picked.length) {
                setPicked((p) => p.slice(0, -1))
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            placeholder={picked.length ? 'Add another bot' : 'Start a chat with…'}
            aria-label="Start a chat with"
            className="h-7 min-w-[160px] flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-4"
          />
        </div>
      </div>

      <div className="scroll-y min-h-0 flex-1">
        <div className="mx-auto max-w-[820px] px-4 py-3">
          {pickedBots.length >= 2 && (
            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-line-soft bg-sunken p-3">
              <label className="min-w-[220px] flex-1">
                <span className="mb-1.5 block text-[12.5px] font-medium text-fg-2">Group name</span>
                <TextInput value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder={joinNames(pickedBots.map((b) => b.name))} />
              </label>
              <Button variant="primary" icon={Users} disabled={creating || tooMany} onClick={() => void start()}>
                Create group chat
              </Button>
              {tooMany && <p className="w-full text-[12px] text-danger-fg">A group can have up to {MAX_GROUP_BOTS} bots.</p>}
              <p className="w-full text-[12px] text-fg-3">Group chats run every member on each message, so they use more of your model budget than a 1:1 chat.</p>
            </div>
          )}
          {pickedBots.length === 1 && !q && (
            <div className="mb-4 flex items-center gap-3 rounded-xl border border-line-soft bg-sunken p-3">
              <span className="flex-1 text-[12.5px] text-fg-2">Add more bots to make a group, or open the 1:1 chat.</span>
              <Button variant="primary" onClick={() => void start()} disabled={creating}>
                Open chat
              </Button>
            </div>
          )}

          <div className="px-1 pb-1.5 text-[12px] font-semibold text-fg-3">All Bots</div>
          <div role="listbox" aria-label="All Bots" className="flex flex-col gap-px">
            {options.map((o, i) =>
              o.kind === 'bot' ? (
                <button
                  key={o.bot.id}
                  type="button"
                  role="option"
                  aria-selected={i === active && !!q}
                  onClick={() => void choose(o)}
                  onMouseEnter={() => setActive(i)}
                  className={clsx('flex items-center gap-3 rounded-[10px] px-2 py-1.5 text-left', i === active && q ? 'bg-hover' : 'hover:bg-hover')}
                >
                  <BotAvatar bot={o.bot} size={30} />
                  <span className="min-w-0 flex-1">
                    <span className={`bot-${o.bot.avatar.color} block truncate text-ui font-medium text-bot-fg`}>{o.bot.name}</span>
                    <span className="block truncate text-[12px] text-fg-3">{o.bot.label || o.bot.description || `@${o.bot.handle}`}</span>
                  </span>
                  {o.bot.hidden && <span className="text-2xs text-fg-4">Hidden</span>}
                  <span className="text-2xs text-fg-4">{picked.length ? 'Add to group chat' : ''}</span>
                </button>
              ) : (
                <button
                  key="create"
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onClick={() => void choose(o)}
                  onMouseEnter={() => setActive(i)}
                  className={clsx('flex items-center gap-3 rounded-[10px] px-2 py-1.5 text-left', i === active ? 'bg-hover' : 'hover:bg-hover')}
                >
                  <span className="flex size-[30px] items-center justify-center rounded-[30%] border border-dashed border-line-strong text-fg-3">
                    <Plus size={15} />
                  </span>
                  <span className="text-ui font-medium text-fg">{picked.length ? `Add “${o.name}” as a new Bot` : `Create “${o.name}” Bot`}</span>
                </button>
              )
            )}
            {options.length === 0 && <p className="px-2 py-3 text-[12.5px] text-fg-3">No matching Bots</p>}
          </div>
          {!q && <p className="px-2 pt-3 text-[12px] text-fg-4">Type a name to create a Bot.</p>}
        </div>
      </div>

      <Composer
        draftKey="new-chat"
        placeholder={composerPlaceholder}
        members={pickedBots}
        allowEveryone={pickedBots.length > 1}
        disabled={!pickedBots.length || creating || tooMany}
        autoFocus={false}
        onSend={(draft) => start(draft)}
      />
    </section>
  )
}
