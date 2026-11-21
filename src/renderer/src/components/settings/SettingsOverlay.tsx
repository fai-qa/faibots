import clsx from 'clsx'
import { AlarmClock, ChartColumn, Cpu, Info, Palette, Plug, Settings, ShieldCheck, Folder, X, type LucideIcon } from 'lucide-react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useUi, type SettingsSection } from '../../store/ui'
import { IconButton } from '../ui/Button'
import { useFocusTrap } from '../ui/Dialog'
import { BackgroundSection, UsageSection } from './AutomationSections'
import { ConnectorsSection } from './ConnectorsSection'
import { AboutSection, AppearanceSection, GeneralSection, PermissionsSection, WorkspaceSection } from './GeneralSections'
import { ProvidersSection } from './ProvidersSection'

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon; description: string }[] = [
  { id: 'general', label: 'General', icon: Settings, description: 'Your name, notifications and the model new bots start with.' },
  { id: 'providers', label: 'Models & providers', icon: Cpu, description: 'Where your bots get their models, and how each route is paid for.' },
  { id: 'connectors', label: 'Connectors', icon: Plug, description: 'MCP servers that give bots tools like GitHub, Notion or your files.' },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck, description: 'What every bot may do without asking. Each bot can override these.' },
  { id: 'background', label: 'Background & routines', icon: AlarmClock, description: 'Keep faibots running so routines can work, and let other apps start them.' },
  { id: 'usage', label: 'Usage', icon: ChartColumn, description: 'Turns and tokens per bot, from every model call your bots made.' },
  { id: 'appearance', label: 'Appearance', icon: Palette, description: 'Theme and colours.' },
  { id: 'workspace', label: 'Workspace', icon: Folder, description: 'Where bots keep their files, and how long chats stay in context.' },
  { id: 'about', label: 'About', icon: Info, description: 'Version and where your data lives.' }
]

export function SettingsOverlay() {
  const section = useUi((s) => s.settingsSection)
  if (!section) return null
  return <SettingsPanel section={section} />
}

function SettingsPanel({ section }: { section: SettingsSection }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = () => useUi.setState({ settingsSection: null })
  useFocusTrap(ref, close)
  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0]!

  return createPortal(
    <div className="fade-in fixed inset-0 z-40 flex items-center justify-center bg-scrim p-6" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="faibots settings"
        tabIndex={-1}
        className="pop-in flex h-[min(780px,90vh)] w-[min(1000px,94vw)] overflow-hidden rounded-[16px] bg-elevated shadow-modal outline-none"
      >
        <nav className="flex w-[220px] shrink-0 flex-col gap-px border-r border-line-soft bg-sidebar p-2.5" aria-label="Settings sections">
          <div className="px-2.5 pb-3 pt-2 text-[14px] font-semibold text-fg">Settings</div>
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => useUi.setState({ settingsSection: s.id })}
              aria-current={s.id === section ? 'page' : undefined}
              className={clsx(
                'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-left text-ui',
                s.id === section ? 'bg-active font-medium text-fg' : 'text-fg-2 hover:bg-hover hover:text-fg'
              )}
            >
              <s.icon size={15} className="shrink-0" />
              {s.label}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-start gap-3 px-7 pb-3 pt-6">
            <div className="min-w-0 flex-1">
              <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{current.label}</h2>
              <p className="mt-0.5 text-[12.5px] text-fg-3">{current.description}</p>
            </div>
            <IconButton icon={X} label="Close settings" onClick={close} />
          </header>
          <div className="scroll-y min-h-0 flex-1 px-7 pb-8 pt-2">
            {section === 'general' && <GeneralSection />}
            {section === 'providers' && <ProvidersSection />}
            {section === 'connectors' && <ConnectorsSection />}
            {section === 'permissions' && <PermissionsSection />}
            {section === 'background' && <BackgroundSection />}
            {section === 'usage' && <UsageSection />}
            {section === 'appearance' && <AppearanceSection />}
            {section === 'workspace' && <WorkspaceSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
