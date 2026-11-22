import { useState } from 'react'
import type { ContextScope, TurnContextReceipt } from '@shared/turn-context'
import { invoke } from '../../lib/bridge'
import { useAsync } from '../../lib/hooks'
import { useData } from '../../store/data'

function Receipt({ turn }: { turn: TurnContextReceipt }) {
  const bot = useData((s) => s.botMap.get(turn.botId))
  const provider = useData((s) => s.providers.find((p) => p.id === turn.providerId))
  return (
    <article className="selectable space-y-1 break-words border-t border-line-soft py-2">
      <p>
        {bot?.name ?? 'Bot'} Â· {turn.route} Â· {new Date(turn.createdAt).toLocaleString()}
      </p>
      <p>
        Engine {turn.engine}
        {turn.providerId && <> Â· Provider {provider?.kind ?? turn.providerId}</>}
        {turn.modelId && <> Â· Model {turn.modelId}</>}
      </p>
      <details>
        <summary>Turn identity</summary>
        <p>Turn {turn.id}</p>
        <p>Bot {turn.botId}</p>
        <p>
          {turn.route === 'project' ? 'Session' : 'Chat'} {turn.scopeId}
        </p>
        {turn.projectId && <p>Project {turn.projectId}</p>}
        {turn.providerId && <p>Provider {turn.providerId}</p>}
      </details>
      <details>
        <summary>Offered tools ({turn.tools.length})</summary>
        {turn.tools.map((tool) => (
          <p key={tool.exposedAs}>
            <code>{tool.exposedAs}</code> Â· {tool.permission}
            {tool.workspaceException && tool.permission === 'ask' && ' Â· allowed inside the workspace'}
            {tool.hostApproval === 'cli-default' && ' Â· subject to CLI approval policy'}
          </p>
        ))}
      </details>
      <details>
        <summary>Selected file revisions ({turn.sources.length})</summary>
        {turn.sources.map((source, i) => (
          <p key={i} className="break-all">
            {source.kind === 'withheld' ? (
              source.reason === 'verification-limit' ? (
                'Withheld Â· file or page verification limit reached.'
              ) : (
                'Withheld Â· no current access or verified revision.'
              )
            ) : (
              <>
                {source.kind === 'project'
                  ? `Library item ${source.itemId} Â· revision ${source.revision}`
                  : `Attachment ${source.attachmentId}`}{' '}
                Â· SHA-256 {source.sha256}
              </>
            )}
          </p>
        ))}
      </details>
      {turn.omissions.map((note) => (
        <p key={note}>{note}</p>
      ))}
    </article>
  )
}

function Page({
  scope,
  before,
  page
}: {
  scope: ContextScope
  before?: number
  page: (before?: number) => void
}) {
  const result = useAsync(() => invoke('context:turns', { scope, before }), [before])
  if (result.error) return <p role="alert">{result.error}</p>
  if (result.loading || !result.data) return <p>Checking local recordsâ€¦</p>
  return (
    <>
      {result.data.turns.length === 0 && (
        <p>No context records for this chat or session. Older turns may predate this feature.</p>
      )}
      {result.data.turns.map((turn) => (
        <Receipt turn={turn} key={turn.id} />
      ))}
      {before && (
        <button type="button" onClick={() => page()}>
          Latest turns
        </button>
      )}
      {result.data.next && (
        <button className="ml-2" type="button" onClick={() => page(result.data!.next)}>
          Older turns
        </button>
      )}
    </>
  )
}

export function TurnContext({ scope, revision }: { scope: ContextScope; revision?: number }) {
  const [open, setOpen] = useState(false)
  const [before, page] = useState<number>()
  const grants = useData((s) => s.versions.journey)
  const lastEntry = useData((s) => (scope.kind === 'chat' ? s.lastEntry[scope.conversationId]?.id : undefined))
  return (
    <details
      className="max-h-[42vh] shrink-0 overflow-y-auto border-t border-line-soft px-3 py-2 text-[12px] text-fg-2"
      onToggle={(event) => {
        setOpen(event.currentTarget.open)
        if (!event.currentTarget.open) page(undefined)
      }}
    >
      <summary className="cursor-pointer font-medium">Turn context</summary>
      {open && (
        <Page
          key={JSON.stringify([scope, grants, lastEntry, before, revision])}
          scope={scope}
          before={before}
          page={page}
        />
      )}
    </details>
  )
}
