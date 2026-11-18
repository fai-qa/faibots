// New / edit skill: Name, "Use when…", Markdown instructions.

import { Trash } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Bot, Id, SkillWithBody } from '@shared/domain'
import { errorMessage, invoke } from '../../lib/bridge'
import { useData } from '../../store/data'
import { confirmDialog, toast } from '../../store/ui'
import { run, updateBot } from '../../store/actions'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextArea, TextInput } from '../ui/Field'
import { Spinner } from '../ui/Badge'
import { Toggle } from '../ui/Toggle'

function slugPreview(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function SkillEditor({ skillId, bot, onClose }: { skillId: Id | null; bot?: Bot; onClose: () => void }) {
  const [loaded, setLoaded] = useState<SkillWithBody | null>(null)
  const [loading, setLoading] = useState(!!skillId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [body, setBody] = useState('')
  const [isPrivate, setPrivate] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!skillId) return
    invoke('skills:get', { id: skillId }).then(
      (s) => {
        setLoaded(s)
        setName(s.name)
        setDescription(s.description)
        setBody(s.body)
        setLoading(false)
      },
      (err: unknown) => {
        setError(errorMessage(err))
        setLoading(false)
      }
    )
  }, [skillId])

  const readOnly = !!loaded?.readOnly
  const slug = slugPreview(name)

  const save = async () => {
    setError(null)
    if (!slug) return setError('Use at least one letter (a–z) or number')
    if (!description.trim()) return setError('Required. Describe when to use this skill.')
    if (!body.trim()) return setError('Write the instructions the Bot follows.')
    setSaving(true)
    try {
      const saved = await invoke('skills:save', {
        id: loaded?.id,
        name,
        description: description.trim(),
        body,
        ownerBotId: loaded ? loaded.ownerBotId : isPrivate ? bot?.id : undefined
      })
      // A new library skill made from a bot's tab is assigned to that bot straight away.
      if (!loaded && bot && !isPrivate) {
        const current = useData.getState().botMap.get(bot.id)
        if (current && !current.skillIds.includes(saved.id)) await updateBot(bot.id, { skillIds: [...current.skillIds, saved.id] })
      }
      toast(loaded ? `Saved ${saved.name}` : `Added ${saved.name}`, 'success')
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!loaded) return
    const ok = await confirmDialog({ title: 'Delete this skill?', body: 'This action cannot be undone.', confirmLabel: 'Delete Skill', danger: true })
    if (ok && (await run('skills:delete', { id: loaded.id }, "Couldn't delete the skill."))) onClose()
  }

  return (
    <Dialog
      title={loaded ? (readOnly ? loaded.name : 'Edit skill') : 'Add new skill'}
      description={
        readOnly ? `Read-only. Found in ${loaded?.dir}` : 'Describe a repeatable way of working so the Bot completes the task the same way every time.'
      }
      onClose={onClose}
      width={680}
      footer={
        readOnly ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            {loaded && (
              <Button variant="danger-ghost" icon={Trash} onClick={() => void remove()}>
                Delete Skill
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving || loading}>
              {saving ? 'Saving…' : 'Save skill'}
            </Button>
          </>
        )
      }
    >
      {loading ? (
        <div className="flex justify-center py-10 text-fg-3">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Name" hint={slug && slug !== name ? `Saved as ${slug}` : 'Lowercase words with dashes, like weekly-report'}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} placeholder="weekly-report" mono data-autofocus />
          </Field>
          <Field label="Use when…" hint="Required. Describe when to use this skill.">
            <TextInput
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={readOnly}
              placeholder="Use when writing the Friday status report"
            />
          </Field>
          <Field label="Instructions" hint="Markdown instructions the Bot follows when it runs this skill.">
            <TextArea value={body} onChange={(e) => setBody(e.target.value)} disabled={readOnly} rows={14} mono className="min-h-[260px]" placeholder={'# Weekly report\n\n1. …'} />
          </Field>
          {loaded && loaded.resources.length > 0 && (
            <div>
              <div className="mb-1 text-[12.5px] font-medium text-fg-2">Files in this skill</div>
              <ul className="space-y-0.5 font-mono text-[12px] text-fg-3">
                {loaded.resources.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {!loaded && bot && (
            <label className="flex items-center justify-between gap-4 rounded-lg border border-line-soft px-3 py-2.5">
              <span>
                <span className="block text-ui font-medium text-fg">Keep it private to {bot.name}</span>
                <span className="block text-[12px] text-fg-3">Off: it goes in your library, and {bot.name} can use it now.</span>
              </span>
              <Toggle label={`Private to ${bot.name}`} checked={isPrivate} onChange={setPrivate} />
            </label>
          )}
          {error && <p className="text-[12.5px] text-danger-fg">{error}</p>}
        </div>
      )}
    </Dialog>
  )
}
