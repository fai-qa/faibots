import { Folder } from 'lucide-react'
import { useRef, useState } from 'react'
import { createProject } from '../../store/actions'
import { navigate, useUi } from '../../store/ui'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextArea, TextInput } from '../ui/Field'

export function NewProjectDialogHost() {
  const open = useUi((s) => s.newProjectOpen)
  return open ? <NewProjectDialog /> : null
}

function NewProjectDialog() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const creating = useRef(false)
  const close = () => useUi.setState({ newProjectOpen: false })

  const create = async () => {
    // Keyboard submits can arrive before React commits the disabled button.
    if (creating.current) return
    if (!name.trim()) return setError('Name can’t be empty')
    creating.current = true
    setBusy(true)
    try {
      const project = await createProject(name.trim(), description.trim())
      if (!project) return
      close()
      navigate({ kind: 'project', id: project.id })
    } finally {
      creating.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      title="New Project"
      description="A local workspace for one project. Attach the notes fai works from, then run the mission."
      onClose={close}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="flex items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-inner bg-sunken">
            <Folder size={20} className="text-fg-3" />
          </span>
          <span className="text-[12px] text-fg-3">
            Everything lives in the local database: no files are moved or uploaded.
          </span>
        </div>
        <Field label="Project name" error={error}>
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="Launch plan"
            maxLength={120}
            data-autofocus
          />
        </Field>
        <Field label="Description (optional)" hint="What this project is for, in one or two sentences.">
          <TextArea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Add a description" />
        </Field>
      </div>
    </Dialog>
  )
}
