// A ModelAdapter whose steps are scripted, for native-engine tests. Not used by app code.

import type { ToolResult } from '../../contracts'
import type { CompleteRequest, ModelAdapter, ModelTurn, StepEvents, StepResult, ToolCallRequest, TurnSpec } from '../../providers/types'

export type ScriptedStep = (events: StepEvents, signal: AbortSignal) => StepResult | Promise<StepResult>

export class ScriptedAdapter implements ModelAdapter {
  readonly specs: TurnSpec[] = []
  readonly toolResults: { call: ToolCallRequest; result: ToolResult }[][] = []
  readonly completes: CompleteRequest[] = []
  stepsRun = 0
  summary = 'Notes: the user wants a May launch.'
  /** When set, complete() (used for summaries) fails with this error. */
  completeError?: Error

  constructor(private readonly steps: ScriptedStep[] = []) {}

  push(...steps: ScriptedStep[]): this {
    this.steps.push(...steps)
    return this
  }

  startTurn(spec: TurnSpec): ModelTurn {
    this.specs.push(spec)
    return {
      step: async (events, signal) => {
        const next = this.steps.shift()
        if (!next) throw new Error('ScriptedAdapter: no step left')
        this.stepsRun++
        return next(events, signal)
      },
      addToolResults: (results) => {
        this.toolResults.push(results)
      }
    }
  }

  async complete(request: CompleteRequest): Promise<string> {
    this.completes.push(request)
    if (this.completeError) throw this.completeError
    return this.summary
  }
}

/** A step that writes `text` (in two deltas) and ends the reply. */
export const say =
  (text: string): ScriptedStep =>
  (events) => {
    const half = Math.ceil(text.length / 2)
    events.onTextDelta(text.slice(0, half))
    events.onTextDelta(text.slice(half))
    events.onTextEnd()
    return { stop: 'end', text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }
  }

/** A step that optionally writes text, then calls tools. */
export const callTools =
  (calls: ToolCallRequest[], text = ''): ScriptedStep =>
  (events) => {
    if (text) {
      events.onTextDelta(text)
      events.onTextEnd()
    }
    for (const c of calls) events.onToolInputStart(c.name)
    return { stop: 'tool_use', text, toolCalls: calls, usage: { inputTokens: 10, outputTokens: 5 } }
  }
