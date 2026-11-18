import { Dialog } from '../ui/Dialog'
import { TextArea } from '../ui/Field'
import { Markdown } from '../chat/Markdown'

/** A roomy side-by-side editor and preview for a bot's soul. */
export function SoulDialog({ name, value, onChange, onClose }: { name: string; value: string; onChange: (v: string) => void; onClose: () => void }) {
  return (
    <Dialog title={`${name}'s soul`} description="Identity, voice, values, boundaries and working style, in Markdown. Saved when you close." onClose={onClose} width={1080} bodyClassName="!py-4">
      <div className="grid h-[64vh] grid-cols-2 gap-4">
        <TextArea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Soul"
          spellCheck
          data-autofocus
          className="h-full resize-none text-[13.5px] leading-[1.65]"
        />
        <div className="scroll-y h-full rounded-lg border border-line-soft bg-sunken px-4 py-3">
          {value.trim() ? <Markdown text={value} /> : <p className="text-[12.5px] text-fg-4">The preview shows up here.</p>}
        </div>
      </div>
    </Dialog>
  )
}
