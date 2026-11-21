import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Character } from '../avatar/BotAvatar'

interface State {
  error: Error | null
}

/** Last line of defence: a calm screen with Reload instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode; compact?: boolean }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const details = `${error.name}: ${error.message}\n${error.stack ?? ''}`
    return (
      <div className="flex h-full min-h-[240px] flex-1 flex-col items-center justify-center gap-3 bg-pane p-8 text-center">
        <Character shape="blob" color="gray" size={56} state="waiting" />
        <div className="text-[15px] font-semibold text-fg">Something went wrong</div>
        <p className="max-w-[380px] text-[12.5px] text-fg-3">faibots hit an unexpected error while drawing this screen. Reloading usually fixes it.</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => window.location.reload()} className="h-8 rounded-lg bg-ink px-3 text-ui font-medium text-on-ink">
            Reload
          </button>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(details)}
            className="h-8 rounded-lg border border-line-strong px-3 text-ui font-medium text-fg hover:bg-hover"
          >
            Copy error
          </button>
          {this.props.compact && (
            <button type="button" onClick={() => this.setState({ error: null })} className="h-8 rounded-lg px-3 text-ui font-medium text-fg-2 hover:bg-hover">
              Try again
            </button>
          )}
        </div>
      </div>
    )
  }
}
