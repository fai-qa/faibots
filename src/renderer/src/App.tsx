import clsx from 'clsx'
import { MessageSquarePlus, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { refreshLiveFreshness, useData } from './store/data'
import { navigate, useUi } from './store/ui'
import { boot } from './store/actions'
import { useCurrentConversation } from './lib/hooks'
import { useGlobalHotkeys } from './lib/hotkeys'
import { useTheme } from './lib/theme'
import { modKey } from './lib/format'
import { Character } from './components/avatar/BotAvatar'
import { ChatView } from './components/chat/ChatView'
import { NewChatView } from './components/chat/NewChatView'
import { DetailsPane } from './components/details/DetailsPane'
import { AvatarEditorHost } from './components/details/AvatarEditor'
import { NewProjectDialogHost } from './components/journey/NewProjectDialog'
import { ProjectView } from './components/journey/ProjectView'
import { CommandPalette } from './components/palette/CommandPalette'
import { SettingsOverlay } from './components/settings/SettingsOverlay'
import { ErrorBoundary } from './components/shell/ErrorBoundary'
import { NewBotDialogHost } from './components/sidebar/NewBotDialog'
import { Sidebar } from './components/sidebar/Sidebar'
import { Button } from './components/ui/Button'
import { Kbd } from './components/ui/Badge'
import { ConfirmHost, Toasts } from './components/ui/Overlays'

/** Below this width the details pane floats over the chat instead of squeezing it. */
const DOCKED_DETAILS_MIN_WIDTH = 1180

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

export function App() {
  const status = useData((s) => s.status)
  const bootError = useData((s) => s.bootError)
  useTheme()
  useEffect(() => void boot(), [])
  useEffect(() => {
    const check = () => refreshLiveFreshness()
    const timer = window.setInterval(check, 5_000)
    window.addEventListener('focus', check)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', check) }
  }, [])

  if (status === 'loading') return <BootScreen />
  if (status === 'error') {
    return (
      <BootScreen>
        <div className="text-[15px] font-semibold text-fg">Couldn't start faibots</div>
        <p className="max-w-[380px] text-[12.5px] text-fg-3 selectable">{bootError}</p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </BootScreen>
    )
  }
  return (
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  )
}

function BootScreen({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-pane">
      <Character shape="squircle" color="black" size={44} state={children ? 'waiting' : 'thinking'} seed="boot" />
      {children ?? <div className="text-[12.5px] text-fg-3">Starting faibots…</div>}
    </div>
  )
}

function Shell() {
  useGlobalHotkeys()
  const route = useUi((s) => s.route)
  const detailsOpen = useUi((s) => s.detailsOpen)
  const conv = useCurrentConversation()
  const width = useWindowWidth()
  const floating = width < DOCKED_DETAILS_MIN_WIDTH
  const showDetails = detailsOpen && route.kind === 'conversation' && !!conv

  return (
    <div className="flex h-full bg-pane text-fg">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1">
        <ErrorBoundary compact key={route.kind === 'conversation' || route.kind === 'project' ? route.id : route.kind}>
          {route.kind === 'new-chat' ? (
            <NewChatView />
          ) : route.kind === 'project' ? (
            <ProjectView key={route.id} projectId={route.id} />
          ) : conv ? (
            <ChatView key={conv.id} conv={conv} />
          ) : (
            <HomeView />
          )}
        </ErrorBoundary>
        {showDetails && (
          <div className={clsx(floating ? 'absolute inset-y-0 right-0 z-30 shadow-modal' : 'flex')}>
            <ErrorBoundary compact>
              <DetailsPane />
            </ErrorBoundary>
          </div>
        )}
      </main>
      <SettingsOverlay />
      <CommandPalette />
      <NewBotDialogHost />
      <NewProjectDialogHost />
      <AvatarEditorHost />
      <ConfirmHost />
      <Toasts />
    </div>
  )
}

function HomeView() {
  const bots = useData((s) => s.bots)
  return (
    <section className="flex flex-1 flex-col bg-pane">
      <div className="drag h-[52px] shrink-0 border-b border-line-soft" />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="flex -space-x-2">
          <Character shape="egg" color="violet" size={44} seed="a" />
          <Character shape="squircle" color="blue" size={52} seed="b" />
          <Character shape="cloud" color="orange" size={44} seed="c" />
        </div>
        <div>
          <div className="text-[16px] font-semibold text-fg">{bots.length ? 'Pick a chat' : 'Make your first Bot'}</div>
          <p className="mt-1 max-w-[360px] text-[12.5px] text-fg-3">
            {bots.length
              ? 'Open a bot from the sidebar, or start a group chat where several bots work together.'
              : 'Each bot has its own soul, model, memory and skills. Start with one you will talk to every day.'}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" icon={Plus} onClick={() => useUi.setState({ newBotOpen: true })}>
            New Bot
          </Button>
          {bots.length > 0 && (
            <Button icon={MessageSquarePlus} onClick={() => navigate({ kind: 'new-chat' })}>
              Start a chat
            </Button>
          )}
        </div>
        <p className="text-[12px] text-fg-4">
          <Kbd>{modKey}</Kbd> <Kbd>K</Kbd> jumps anywhere
        </p>
      </div>
    </section>
  )
}
