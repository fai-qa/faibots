// Pick a character shape and colour, or upload a picture.

import clsx from 'clsx'
import { ImageUp, Trash } from 'lucide-react'
import { useRef, useState } from 'react'
import { AVATAR_SHAPES, BOT_COLORS, type BotAvatar as Avatar } from '@shared/domain'
import { useData } from '../../store/data'
import { useUi } from '../../store/ui'
import { updateBot } from '../../store/actions'
import { COLOR_LABELS, SHAPE_LABELS } from '../../lib/bots'
import { BotAvatar, Character } from '../avatar/BotAvatar'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Segmented } from '../ui/Toggle'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** Square-crop and shrink an image file to a small data URL. */
async function toAvatarDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const size = 256
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('That image could not be loaded')
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    return canvas.toDataURL('image/webp', 0.9)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function AvatarEditorHost() {
  const botId = useUi((s) => s.avatarEditorBotId)
  const bot = useData((s) => (botId ? s.botMap.get(botId) : undefined))
  if (!bot) return null
  return <AvatarEditor key={bot.id} botId={bot.id} initial={bot.avatar} name={bot.name} />
}

function AvatarEditor({ botId, initial, name }: { botId: string; initial: Avatar; name: string }) {
  const [avatar, setAvatar] = useState<Avatar>(initial)
  const [mode, setMode] = useState<'character' | 'upload'>(initial.imageDataUrl ? 'upload' : 'character')
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const close = () => useUi.setState({ avatarEditorBotId: null })

  const save = async () => {
    const next: Avatar = mode === 'character' ? { shape: avatar.shape, color: avatar.color } : avatar
    await updateBot(botId, { avatar: next })
    close()
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (file.size > MAX_UPLOAD_BYTES) return setError('Choose an image smaller than 25 MB')
    try {
      setAvatar((a) => ({ ...a, imageDataUrl: undefined }))
      const dataUrl = await toAvatarDataUrl(file)
      setAvatar((a) => ({ ...a, imageDataUrl: dataUrl }))
    } catch {
      setError('That image could not be loaded')
    }
  }

  const preview = { id: botId, name, avatar: mode === 'character' ? { shape: avatar.shape, color: avatar.color } : avatar }

  return (
    <Dialog
      title="Avatar editor"
      onClose={close}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={() => setAvatar(initial)}>
            Reset
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={mode === 'upload' && !avatar.imageDataUrl}>
            Set avatar
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 pb-4">
        <div className="flex size-[120px] items-center justify-center rounded-[28px] bg-sunken">
          <BotAvatar bot={preview} size={92} />
        </div>
        <Segmented
          label="Avatar source"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'character', label: 'Character' },
            { value: 'upload', label: 'Upload' }
          ]}
        />
      </div>

      {mode === 'character' ? (
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-[12.5px] font-medium text-fg-2">Character shape</div>
            <div className="grid grid-cols-10 gap-1.5" role="radiogroup" aria-label="Character shape">
              {AVATAR_SHAPES.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  role="radio"
                  aria-checked={avatar.shape === shape}
                  aria-label={`${SHAPE_LABELS[shape]} character shape`}
                  title={SHAPE_LABELS[shape]}
                  onClick={() => setAvatar((a) => ({ ...a, shape }))}
                  className={clsx(
                    'flex aspect-square items-center justify-center rounded-xl transition-colors',
                    avatar.shape === shape ? 'bg-active ring-2 ring-ink' : 'hover:bg-hover'
                  )}
                >
                  <Character shape={shape} color={avatar.color} size={30} seed={shape} />
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 text-[12.5px] font-medium text-fg-2">Character color</div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Character color">
              {BOT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={avatar.color === color}
                  aria-label={`${COLOR_LABELS[color]} character color`}
                  title={COLOR_LABELS[color]}
                  onClick={() => setAvatar((a) => ({ ...a, color }))}
                  className={clsx(
                    'size-8 rounded-full transition-transform hover:scale-105',
                    avatar.color === color && 'ring-2 ring-ink ring-offset-2 ring-offset-elevated'
                  )}
                  style={{ background: `var(--hue-${color})` }}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void onFile(e.dataTransfer.files[0])
            }}
            className="flex w-full flex-col items-center gap-1.5 rounded-xl border border-dashed border-line-strong px-4 py-7 text-center hover:bg-hover"
          >
            <ImageUp size={20} className="text-fg-3" />
            <span className="text-ui font-medium text-fg">Drag and drop an image, or browse files</span>
            <span className="text-[12px] text-fg-3">PNG, JPEG or WebP. It is cropped to a square.</span>
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          {error && <p className="text-[12px] text-danger-fg">{error}</p>}
          {avatar.imageDataUrl && (
            <Button size="sm" variant="ghost" icon={Trash} onClick={() => setAvatar((a) => ({ ...a, imageDataUrl: undefined }))}>
              Remove image
            </Button>
          )}
        </div>
      )}
    </Dialog>
  )
}
