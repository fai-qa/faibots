import { useState } from 'react'
import type { Conversation } from '@shared/domain'
import { updateConversation } from '../../store/actions'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, TextInput } from '../ui/Field'

export function RenameDialog({ conv, onClose }: { conv: Conversation; onClose: () => void }) {
  const [title, setTitle] = useState(conv.title)
  const save = async () => {
    await updateConversation(conv.id, { title: title.trim() })
    onClose()
  }
  return (
    <Dialog
      title="Rename chat"
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save name
          </Button>
        </>
      }
    >
      <Field label="Group name" hint="Leave it empty to name the group after its members.">
        <TextInput
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
          placeholder="Launch crew"
          data-autofocus
        />
      </Field>
    </Dialog>
  )
}
