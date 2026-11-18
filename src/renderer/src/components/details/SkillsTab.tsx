// Skills a bot can use: its own private skills plus ones assigned from the library.

import { BookOpen, FileUp, FolderUp, Lock, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { MAX_SKILLS_PER_BOT, type Bot, type Id, type Skill } from '@shared/domain'
import { invoke } from '../../lib/bridge'
import { useData } from '../../store/data'
import { confirmDialog, toast } from '../../store/ui'
import { reportError, run, updateBot } from '../../store/actions'
import { useAsync } from '../../lib/hooks'
import { plural } from '../../lib/format'
import { Badge, EmptyState, Spinner } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { SkillEditor } from './SkillEditor'

function SourceBadge({ skill }: { skill: Skill }) {
  if (skill.source === 'bot') return <Badge>Private</Badge>
  if (skill.source === 'external')
    return (
      <Badge title={skill.dir}>
        <Lock size={10} />
        Read-only
      </Badge>
    )
  return null
}

export function SkillsTab({ bot }: { bot: Bot }) {
  const version = useData((s) => s.versions.skills)
  const usable = useAsync(() => invoke('skills:list', { botId: bot.id }), [bot.id, version, bot.skillIds.join(',')])
  const all = useAsync(() => invoke('skills:list', {}), [version])
  const [editing, setEditing] = useState<Id | null | 'new'>(null)
  const [importing, setImporting] = useState(false)

  const usableIds = new Set((usable.data ?? []).map((s) => s.id))
  const library = (all.data ?? []).filter((s) => !usableIds.has(s.id) && s.source !== 'bot')

  const assign = (id: Id) => {
    if (bot.skillIds.length >= MAX_SKILLS_PER_BOT) return toast(`A bot can use up to ${MAX_SKILLS_PER_BOT} skills`, 'error')
    void updateBot(bot.id, { skillIds: [...bot.skillIds, id] })
  }
  const unassign = async (skill: Skill) => {
    if (skill.ownerBotId === bot.id) {
      const ok = await confirmDialog({
        title: `Delete ${skill.name}?`,
        body: `This skill is private to ${bot.name}, so removing it deletes it. This action cannot be undone.`,
        confirmLabel: 'Delete Skill',
        danger: true
      })
      if (ok) await run('skills:delete', { id: skill.id }, "Couldn't delete the skill.")
      return
    }
    void updateBot(bot.id, { skillIds: bot.skillIds.filter((x) => x !== skill.id) })
  }

  const importSkills = async (directories: boolean) => {
    try {
      const paths = await invoke(
        'dialog:open-files',
        directories
          ? { title: 'Import skill folders', directories: true }
          : { title: 'Import skills', filters: [{ name: 'Skills and text files', extensions: ['md', 'txt'] }] }
      )
      if (!paths.length) return
      setImporting(true)
      const added = await invoke('skills:import-files', { paths, assignToBotId: bot.id })
      toast(
        added.length ? `Added ${plural(added.length, 'skill')}` : 'Nothing to add. Pick SKILL.md, .md or .txt files, or folders that hold them.',
        added.length ? 'success' : 'info'
      )
      usable.reload()
    } catch (err) {
      reportError(err, 'The skill was not saved.')
    } finally {
      setImporting(false)
    }
  }

  const list = usable.data ?? []
  return (
    <div className="space-y-6 p-4">
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="flex-1 text-[13px] font-semibold text-fg">
            Skills {bot.name} can use {list.length > 0 && <span className="font-normal text-fg-4">{list.length}</span>}
          </h3>
          {(usable.loading || importing) && <Spinner size={12} className="text-fg-4" />}
        </div>
        <div className="mb-3 flex gap-2">
          <Button size="sm" variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            New skill
          </Button>
          <Button size="sm" icon={FileUp} onClick={() => void importSkills(false)} disabled={importing}>
            Import files
          </Button>
          <Button size="sm" icon={FolderUp} onClick={() => void importSkills(true)} disabled={importing} title="A skill folder with SKILL.md, or a folder of skills">
            Import folder
          </Button>
        </div>
        {list.length === 0 && !usable.loading ? (
          <EmptyState icon={BookOpen} title="No skills yet">
            Create one, import a SKILL.md, or ask {bot.name} to write one for you.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
            {list.map((s) => (
              <li key={s.id} className="group flex items-start gap-2.5 px-3 py-2.5">
                <BookOpen size={14} className="mt-0.5 shrink-0 text-fg-3" />
                <button type="button" onClick={() => setEditing(s.id)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[12.5px] font-medium text-fg">{s.name}</span>
                    <SourceBadge skill={s} />
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[12px] text-fg-3">{s.description}</span>
                </button>
                <IconButton
                  size="sm"
                  icon={X}
                  label={s.ownerBotId === bot.id ? `Delete ${s.name}` : `Remove ${s.name} from ${bot.name}`}
                  tone="danger"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => void unassign(s)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {library.length > 0 && (
        <section>
          <h3 className="mb-1 text-[13px] font-semibold text-fg">Add from your library</h3>
          <p className="mb-2 text-[12px] text-fg-3">Skills from your library and from ~/.claude, ~/.codex and ~/.agents.</p>
          <ul className="divide-y divide-line-soft rounded-xl border border-line-soft">
            {library.map((s) => (
              <li key={s.id} className="flex items-start gap-2.5 px-3 py-2.5">
                <button type="button" onClick={() => setEditing(s.id)} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-mono text-[12.5px] font-medium text-fg-2">{s.name}</span>
                    <SourceBadge skill={s} />
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[12px] text-fg-3">{s.description}</span>
                </button>
                <Button size="sm" icon={Plus} onClick={() => assign(s.id)}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {editing !== null && (
        <SkillEditor
          skillId={editing === 'new' ? null : editing}
          bot={bot}
          onClose={() => {
            setEditing(null)
            usable.reload()
            all.reload()
          }}
        />
      )}
    </div>
  )
}
