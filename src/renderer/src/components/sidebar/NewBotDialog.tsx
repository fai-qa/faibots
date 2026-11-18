import { Shuffle } from 'lucide-react'
import { useRef, useState } from 'react'
import { AVATAR_SHAPES, BOT_COLORS, type BotAvatar as Avatar } from '@shared/domain'
import { openDetails, useUi } from '../../store/ui'
import { createBot, openBot } from '../../store/actions'
import { Character } from '../avatar/BotAvatar'
import { Button, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextArea, TextInput } from '../ui/Field'

function randomAvatar(): Avatar {
  const colors = BOT_COLORS.filter((c) => c !== 'black' && c !== 'gray')
  return {
    shape: AVATAR_SHAPES[Math.floor(Math.random() * AVATAR_SHAPES.length)]!,
    color: colors[Math.floor(Math.random() * colors.length)]!
  }
}

export function NewBotDialogHost() {
  const open = useUi((s) => s.newBotOpen)
  return open ? <NewBotDialog /> : null
}

function NewBotDialog() {
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState(randomAvatar)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const creating = useRef(false)
  const close = () => useUi.setState({ newBotOpen: false })

  const create = async () => {
    // Keyboard submits can arrive before React commits the disabled button.
    if (creating.current) return
    if (!name.trim()) return setError('Name can’t be empty')
    creating.current = true
    setBusy(true)
    try {
      const bot = await createBot(name.trim(), { label: label.trim(), description: description.trim(), avatar })
      if (!bot) return
      close()
      await openBot(bot.id)
      // Straight to the profile so you can write its soul.
      openDetails('profile', null)
    } finally {
      creating.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="Create New Bot"
      description="Give it a name now. You can write its soul, pick its model and add skills next."
      onClose={close}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy} aria-busy={busy}>
            Create bot
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="flex items-center gap-3">
          <span className="flex size-16 items-center justify-center rounded-card bg-sunken">
            <Character shape={avatar.shape} color={avatar.color} size={48} seed={name} />
          </span>
          <IconButton icon={Shuffle} label="Try another character" onClick={() => setAvatar(randomAvatar())} />
          <span className="text-[12px] text-fg-3">You can change the character later.</span>
        </div>
        <Field label="Name your Bot" error={error}>
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="Researcher"
            data-autofocus
          />
        </Field>
        <Field label="Label (optional)" hint="For example: Research, marketing, admin">
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add a label" />
        </Field>
        <Field label="Description (optional)" hint="Other bots read this to decide when to ask it for help.">
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Add a description" />
        </Field>
      </div>
    </Dialog>
  )
}
