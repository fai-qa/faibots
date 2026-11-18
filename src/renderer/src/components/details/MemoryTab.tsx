// A bot's memory: the always-in-context profile document and searchable facts.

import clsx from 'clsx'
import { Brain, Pencil, Pin, PinOff, Plus, Search, Trash } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Bot, MemoryFact } from '@shared/domain'
import { invoke } from '../../lib/bridge'
import { useData } from '../../store/data'
import { confirmDialog } from '../../store/ui'
import { attempt, run } from '../../store/actions'
import { useAsync, useDebounced } from '../../lib/hooks'
import { relative } from '../../lib/format'
import { Button, IconButton } from '../ui/Button'
import { EmptyState, Spinner } from '../ui/Badge'
import { TextArea, TextInput } from '../ui/Field'

export function MemoryTab({ bot }: { bot: Bot }) {
  const version = useData((s) => s.versions.memory[bot.id] ?? 0)
  return (
    <div className="space-y-6 p-4">
      <ProfileDocument bot={bot} version={version} />
      <Facts bot={bot} version={version} />
    </div>
  )
}

function ProfileDocument({ bot, version }: { bot: Bot; version: number }) {
  const profile = useAsync(() => invoke('memory:get-profile', { botId: bot.id }), [bot.id, version])
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // Take the stored copy unless you are in the middle of editing it.
  useEffect(() => {
    if (profile.data && !dirty) setText(profile.data.content)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.data])
  useEffect(() => setDirty(false), [bot.id])

  const save = async () => {
    setSaving(true)
    const saved = await attempt('memory:set-profile', { botId: bot.id, content: text }, "Couldn't save the profile.")
    setSaving(false)
    if (saved) {
      setDirty(false)
      profile.setData(saved)
    }
  }

  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-fg">Profile</h3>
        <span className="text-2xs text-fg-4">{profile.data?.updatedAt ? `Updated ${relative(profile.data.updatedAt)}` : ''}</span>
      </div>
      <p className="mb-2 text-[12px] text-fg-3">What {bot.name} always keeps in mind about you and its work. It is part of every turn.</p>
      <TextArea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setDirty(true)
        }}
        placeholder={'## About you\n- …\n\n## Current work\n- …'}
        rows={7}
        autoGrow
        className="min-h-[140px] text-[13px]"
        aria-label="Memory profile"
      />
      {dirty && (
        <div className="mt-2 flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(profile.data?.content ?? '')
              setDirty(false)
            }}
          >
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </Button>
        </div>
      )}
    </section>
  )
}

function Facts({ bot, version }: { bot: Bot; version: number }) {
  const [query, setQuery] = useState('')
  const q = useDebounced(query.trim(), 200)
  const facts = useAsync(() => invoke('memory:list', { botId: bot.id, query: q || undefined, limit: 200 }), [bot.id, q, version])
  const [newText, setNewText] = useState('')

  const add = async () => {
    const text = newText.trim()
    if (!text) return
    const fact = await attempt('memory:add', { botId: bot.id, text }, "Couldn't add the memory.")
    if (fact) {
      setNewText('')
      facts.reload()
    }
  }

  const list = facts.data ?? []
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-fg">
          Memories {list.length > 0 && !q && <span className="font-normal text-fg-4">{list.length}</span>}
        </h3>
        {facts.loading && <Spinner size={12} className="text-fg-4" />}
      </div>
      <div className="mb-2 flex h-8 items-center gap-2 rounded-lg bg-hover px-2.5">
        <Search size={13} className="text-fg-3" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories"
          aria-label="Search memories"
          className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-4"
        />
      </div>
      <div className="mb-3 flex gap-2">
        <TextInput
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
          placeholder={`Add something ${bot.name} should remember`}
          aria-label="New memory"
        />
        <Button icon={Plus} onClick={() => void add()} disabled={!newText.trim()}>
          Add
        </Button>
      </div>

      {facts.error && <p className="text-[12px] text-danger-fg">Couldn't load memories: {facts.error}</p>}
      {list.length === 0 && !facts.loading ? (
        <EmptyState icon={Brain} title={q ? `No memories match “${q}”` : 'No memories yet'}>
          {q ? 'Try fewer words.' : `Things ${bot.name} learns show up here. You can add your own too.`}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
          {list.map((f) => (
            <FactRow key={f.id} fact={f} botName={bot.name} onChanged={facts.reload} />
          ))}
        </ul>
      )}
    </section>
  )
}

function FactRow({ fact, botName, onChanged }: { fact: MemoryFact; botName: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(fact.text)

  const save = async () => {
    if (!text.trim()) return
    if (await attempt('memory:update', { id: fact.id, patch: { text: text.trim() } }, "Couldn't save.")) {
      setEditing(false)
      onChanged()
    }
  }
  const togglePin = async () => {
    if (await attempt('memory:update', { id: fact.id, patch: { pinned: !fact.pinned } })) onChanged()
  }
  const remove = async () => {
    const ok = await confirmDialog({ title: 'Delete this memory?', body: `${botName} will no longer remember: “${fact.text}”`, confirmLabel: 'Delete', danger: true })
    if (ok && (await run('memory:delete', { id: fact.id }, "Couldn't delete."))) onChanged()
  }

  return (
    <li className="group px-3 py-2.5">
      {editing ? (
        <div className="space-y-2">
          <TextArea value={text} onChange={(e) => setText(e.target.value)} rows={2} autoGrow data-autofocus autoFocus aria-label="Memory text" />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(fact.text)
                setEditing(false)
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <p className="selectable text-[13px] leading-snug text-fg">
              {fact.pinned && <Pin size={11} className="mr-1 inline -translate-y-px fill-current text-fg-3" aria-label="Pinned" />}
              {fact.text}
            </p>
            <p className="mt-1 text-2xs text-fg-4">
              {fact.createdBy === 'bot' ? `Saved by ${botName}` : 'Added by you'}, {relative(fact.createdAt)}
            </p>
          </div>
          <div className={clsx('flex shrink-0 items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100')}>
            <IconButton size="sm" icon={fact.pinned ? PinOff : Pin} label={fact.pinned ? 'Unpin' : 'Pin'} onClick={() => void togglePin()} />
            <IconButton size="sm" icon={Pencil} label="Edit memory" onClick={() => setEditing(true)} />
            <IconButton size="sm" icon={Trash} label="Delete memory" tone="danger" onClick={() => void remove()} />
          </div>
        </div>
      )}
    </li>
  )
}
