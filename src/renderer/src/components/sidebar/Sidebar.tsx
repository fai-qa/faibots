import clsx from 'clsx'
import { ChevronRight, Folder, Plus, Search, Settings, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project } from '@shared/domain'
import { useData } from '../../store/data'
import { navigate, useUi } from '../../store/ui'
import { sidebarSections, type SidebarItem } from '../../lib/sidebar'
import { Character } from '../avatar/BotAvatar'
import { IconButton } from '../ui/Button'
import { Kbd } from '../ui/Badge'
import { modKey } from '../../lib/format'
import { isMockBridge } from '../../lib/bridge'
import { SidebarRow } from './SidebarRow'

export function Sidebar() {
  const compact = useUi((s) => s.compactSidebar)
  const focusSearch = useUi((s) => s.focusSearch)
  const bots = useData((s) => s.bots)
  const conversations = useData((s) => s.conversations)
  const projects = useData((s) => s.projects)
  const userName = useData((s) => s.settings?.userName)
  const [query, setQuery] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusSearch) {
      useUi.setState({ compactSidebar: false })
      setTimeout(() => searchRef.current?.focus(), 0)
    }
  }, [focusSearch])

  const sections = useMemo(() => sidebarSections(bots, conversations, query), [bots, conversations, query])
  const empty = (Boolean(query.trim()) || !sections.main) && !sections.pinned.length && !sections.bots.length && !sections.groups.length

  const renderList = (items: SidebarItem[]) => items.map((item) => <SidebarRow key={item.key} item={item} compact={compact} />)

  return (
    <aside
      className={clsx('flex h-full shrink-0 flex-col border-r border-line-soft bg-sidebar transition-[width] duration-150', compact ? 'w-[68px]' : 'w-[264px]')}
      aria-label="Bots and groups"
    >
      <div className={clsx('drag flex h-[52px] shrink-0 items-center gap-2', compact ? 'justify-center' : 'pl-4 pr-2.5')}>
        <Character shape="squircle" color="black" size={22} seed="faibots" />
        {!compact && (
          <>
            <span className="flex flex-1 items-center gap-2">
              <span className="text-[14px] font-semibold tracking-[-0.01em] text-fg">faibots</span>
              {isMockBridge() && (
                <span title="No backend: this is the UI preview with sample data" className="rounded-pill bg-warn/15 px-1.5 py-px text-2xs font-medium text-warn-fg">
                  Preview
                </span>
              )}
            </span>
            <IconButton icon={SquarePen} label={`New chat (${modKey}+Shift+N)`} onClick={() => navigate({ kind: 'new-chat' })} />
          </>
        )}
      </div>

      {sections.main && (
        <div className={clsx('px-2 pb-1.5', compact && 'flex justify-center')}>
          <SidebarRow item={sections.main} compact={compact} />
        </div>
      )}

      {!compact && (
        <div className="px-2.5 pb-1.5">
          <div className="flex h-8 items-center gap-2 rounded-control bg-hover px-2.5 focus-within:bg-pane focus-within:ring-[3px] focus-within:ring-focus/15">
            <Search size={14} className="shrink-0 text-fg-3" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('')
                  searchRef.current?.blur()
                }
              }}
              placeholder="Search bots"
              aria-label="Search bots"
              className="min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-4"
            />
            {!query && <Kbd>{modKey}⇧F</Kbd>}
          </div>
        </div>
      )}

      <div className={clsx('pb-1', compact ? 'flex justify-center px-2' : 'px-2')}>
        <button
          type="button"
          onClick={() => useUi.setState({ newBotOpen: true })}
          title={`New Bot (${modKey}+N)`}
          className={clsx(
            'flex items-center gap-2.5 rounded-control text-ui font-medium text-fg-2 transition-[background-color,color,translate] duration-150 hover:-translate-y-px hover:bg-hover hover:text-fg active:translate-y-0',
            compact ? 'size-11 justify-center' : 'h-11 w-full px-2.5'
          )}
        >
          <span className="flex size-7 items-center justify-center rounded-[30%] border border-dashed border-line-strong">
            <Plus size={15} />
          </span>
          {!compact && 'New Bot'}
        </button>
      </div>

      <nav className={clsx('scroll-y min-h-0 flex-1 pb-3', compact ? 'px-2' : 'px-2')}>
        {sections.pinned.length > 0 && (
          <Section title="Pinned" compact={compact}>
            {renderList(sections.pinned)}
          </Section>
        )}
        {sections.bots.length > 0 && (
          <Section title="Bots" compact={compact}>
            {renderList(sections.bots)}
          </Section>
        )}
        {sections.groups.length > 0 && (
          <Section title="Groups" compact={compact}>
            {renderList(sections.groups)}
          </Section>
        )}
        <section className="pt-3" aria-label="Projects">
          {compact ? (
            <div className="mx-auto mb-1 h-px w-6 bg-line" />
          ) : (
            <div className="flex items-center justify-between px-2.5 pb-1">
              <h2 className="text-[12px] font-semibold text-fg-3">Projects</h2>
              <button
                type="button"
                title="New Project"
                aria-label="New Project"
                onClick={() => useUi.setState({ newProjectOpen: true })}
                className="flex size-7 items-center justify-center rounded-control text-fg-3 transition-colors duration-150 hover:bg-hover hover:text-fg"
              >
                <Plus size={13} />
              </button>
            </div>
          )}
          <div className={clsx('flex flex-col', compact ? 'items-center gap-1' : 'gap-px')}>
            {projects.map((project) => (
              <ProjectRow key={project.id} project={project} compact={compact} />
            ))}
          </div>
          {projects.length === 0 && !compact && (
            <p className="px-3 py-1.5 text-[12px] text-fg-4">No projects yet.</p>
          )}
        </section>
        {sections.hidden.length > 0 && !compact && (
          <div className="pt-3">
            <button
              type="button"
              onClick={() => setShowHidden((v) => !v)}
              className="flex w-full items-center gap-1 px-2 py-1 text-[12px] font-semibold text-fg-3 hover:text-fg-2"
              aria-expanded={showHidden}
            >
              <ChevronRight size={13} className={clsx('transition-transform', showHidden && 'rotate-90')} />
              Hidden Bots
              <span className="font-normal text-fg-4">{sections.hidden.length}</span>
            </button>
            {showHidden && renderList(sections.hidden)}
          </div>
        )}
        {empty && !compact && (
          <p className="px-3 py-6 text-center text-[12.5px] text-fg-3">{query ? 'No matching specialists or groups' : 'No Bots yet. Create one to get started.'}</p>
        )}
      </nav>

      <div className={clsx('border-t border-line-soft py-2', compact ? 'flex justify-center px-2' : 'px-2')}>
        <button
          type="button"
          onClick={() => useUi.setState({ settingsSection: 'general' })}
          title={`Settings (${modKey}+,)`}
          className={clsx(
            'flex items-center gap-2.5 rounded-control text-ui text-fg-2 transition-[background-color,color,translate] duration-150 hover:-translate-y-px hover:bg-hover hover:text-fg active:translate-y-0',
            compact ? 'size-11 justify-center' : 'h-11 w-full px-2.5'
          )}
        >
          <Settings size={16} className="shrink-0" />
          {!compact && (
            <>
              <span className="flex-1 text-left">Settings</span>
              {userName && <span className="truncate text-[12px] text-fg-4">{userName}</span>}
            </>
          )}
        </button>
      </div>
    </aside>
  )
}

function Section({ title, compact, children }: { title: string; compact: boolean; children: React.ReactNode }) {
  return (
    <section className="pt-3 first:pt-1" aria-label={title}>
      {compact ? <div className="mx-auto mb-1 h-px w-6 bg-line" /> : <h2 className="px-2.5 pb-1 text-[12px] font-semibold text-fg-3">{title}</h2>}
      <div className={clsx('flex flex-col', compact ? 'items-center gap-1' : 'gap-px')}>{children}</div>
    </section>
  )
}

function ProjectRow({ project, compact }: { project: Project; compact: boolean }) {
  const route = useUi((s) => s.route)
  const active = route.kind === 'project' && route.id === project.id
  const open = () => navigate({ kind: 'project', id: project.id })
  if (compact) {
    return (
      <button
        type="button"
        onClick={open}
        title={project.name}
        aria-label={project.name}
        aria-current={active ? 'page' : undefined}
        className={clsx(
          'relative flex size-11 items-center justify-center rounded-control transition-[background-color,translate] duration-150 hover:-translate-y-[2px] hover:z-[1]',
          active ? 'bg-active' : 'hover:bg-hover'
        )}
      >
        <Folder size={18} className="text-fg-2" />
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={open}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'relative flex h-[34px] w-full items-center gap-2.5 rounded-control px-2.5 text-left transition-[background-color,translate] duration-150 hover:-translate-y-[2px] hover:z-[1]',
        active ? 'bg-active' : 'hover:bg-hover'
      )}
    >
      <Folder size={15} className="shrink-0 text-fg-3" />
      <span className="truncate text-ui font-medium text-fg">{project.name}</span>
    </button>
  )
}
