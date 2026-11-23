// The native TurnEngine: FaiBots's own tool loop over a ModelAdapter (Claude API, OpenAI, Gemini,
// xAI, OpenAI-compatible). Each step streams one model response; tool calls go through the
// ToolRegistry (permissions, approval cards), and their results go back as one batch. At most 25
// steps per turn. Before the first step the history is compacted when it is too long.

import type { Attachment } from '@shared/domain'
import type { AttachmentStore, Store } from '../contracts'
import type { RuntimeProviders } from '../providers/provider-service'
import type { StepEvents, StepResult, ToolSpec } from '../providers/types'
import { KEEP_VERBATIM, needsCompaction, planCompaction, summarizeCovered } from './compaction'
import { IncompleteTurnError, type TurnEngine } from './engine'
import { buildBotView, isProjectHistory, viewChars, withTurnNote } from './history'

export const MAX_STEPS = 25

/** Provider errors that mean "the prompt is too long for this model". */
const TOO_LONG = /prompt is too long|context length|context window|maximum context|too many tokens|input is too long|reduce the length/i
const isTooLong = (err: unknown) => err instanceof Error && TOO_LONG.test(err.message)
/** Images bigger than this are described in text instead of sent (provider limits are ~5 MB). */
const MAX_IMAGE_BYTES = 4_500_000

export interface NativeEngineDeps {
  store: Pick<Store, 'entries' | 'settings'>
  providers: Pick<RuntimeProviders, 'adapterFor' | 'modelInfo'>
  attachments: Pick<AttachmentStore, 'read'>
}

/** After a failed summary, wait this long before compacting proactively again. */
export const COMPACTION_RETRY_MS = 10 * 60_000

export function createNativeEngine(deps: NativeEngineDeps): TurnEngine {
  /** When a summary last failed, per conversation and bot: a failing compaction is not retried
   *  on every turn (each attempt sends the whole long history to the model). */
  const compactionFailedAt = new Map<string, number>()

  const loadImage = (a: Attachment) => {
    if (a.sizeBytes > MAX_IMAGE_BYTES) return undefined
    try {
      const data = deps.attachments.read(a)
      if (data.length > MAX_IMAGE_BYTES) return undefined
      return { mediaType: a.mimeType.toLowerCase(), dataBase64: data.toString('base64') }
    } catch {
      return undefined
    }
  }

  return {
    async run(turn) {
      const { bot, route, recorder, signal } = turn
      const incomplete = (message: string): never => { recorder.event(message); throw new IncompleteTurnError(message) }
      const adapter = deps.providers.adapterFor(route.provider)
      const conversationId = turn.conversation.id

      let summary = turn.context.summary
      let entries = turn.isolatedTrigger ? [turn.isolatedTrigger] : deps.store.entries.since(conversationId, turn.context.summarizedUpToSeq)
        .filter((e) => e.seq <= turn.upToSeq && !isProjectHistory(e))
      const view = () => buildBotView({ botId: bot.id, entries, summary, nameOf: turn.nameOf, loadImage })
      let messages = view()

      const tools: ToolSpec[] = turn.tools
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
        // A stable order keeps the prompt cache warm.
        .sort((a, b) => a.name.localeCompare(b.name))

      const info = await deps.providers.modelInfo(route.provider.id, route.modelId)

      /** Fold older messages into the summary. `keep` = message entries kept verbatim. */
      const compact = async (keep: number): Promise<boolean> => {
        const plan = planCompaction(entries, keep)
        if (!plan) return false
        recorder.phase('thinking', 'Tidying up older messages')
        let covered = plan.upToSeq
        try {
          const done = await summarizeCovered({
            adapter,
            modelId: route.modelId,
            botName: bot.name,
            previousSummary: summary,
            older: plan.older,
            nameOf: turn.nameOf,
            selfId: bot.id,
            ...(info?.contextWindow && { contextWindow: info.contextWindow }),
            signal
          })
          summary = done.summary
          covered = done.coveredUpToSeq
        } catch (err) {
          if (!signal.aborted) {
            compactionFailedAt.set(`${conversationId}:${bot.id}`, Date.now())
            console.warn(`[runtime] compaction failed for ${bot.handle}:`, turn.isolatedTrigger ? 'Project context unavailable.' : err instanceof Error ? err.message : String(err))
          }
          return false
        }
        compactionFailedAt.delete(`${conversationId}:${bot.id}`)
        turn.saveContext({ summary, summarizedUpToSeq: covered })
        // Only what the summary really covered leaves the prompt; the rest stays for a later compaction.
        entries = entries.filter((e) => e.seq > covered)
        messages = view()
        return true
      }

      // Compaction, before anything is sent.
      const promptChars =
        turn.system.stable.length + turn.system.volatile.length + viewChars(messages) + JSON.stringify(tools).length
      const failedAt = compactionFailedAt.get(`${conversationId}:${bot.id}`)
      const coolingDown = failedAt !== undefined && Date.now() - failedAt < COMPACTION_RETRY_MS
      if (!coolingDown && needsCompaction({ promptChars, contextWindow: info?.contextWindow, compactAt: deps.store.settings.get().compactAt })) {
        await compact(KEEP_VERBATIM)
        if (signal.aborted) return
      }

      const start = () => {
        turn.disclose?.(tools.map(({ name }) => ({ name, exposedAs: name })), entries,
          ['Host tools outside the faibots catalog are unavailable on this route.'])
        return adapter.startTurn({
          modelId: route.modelId,
          ...(route.effort && { effort: route.effort }),
          system: turn.system,
          messages: withTurnNote(messages, turn.turnNote),
          tools
        })
      }
      let modelTurn = start()
      let retriedTooLong = false

      for (let step = 0; step < MAX_STEPS; step++) {
        if (signal.aborted) return
        recorder.phase('thinking')
        const events: StepEvents = {
          onTextDelta: (delta) => recorder.textDelta(delta),
          onTextEnd: () => recorder.endText(),
          onThinking: () => {
            if (recorder.currentPhase?.phase !== 'thinking') recorder.phase('thinking')
          },
          onToolInputStart: (name) => {
            recorder.endText()
            recorder.phase('tool', turn.activityFor(name))
          }
        }
        let result: StepResult
        try {
          result = await modelTurn.step(events, signal)
        } catch (err) {
          // Our size estimate can be low (code is denser than prose). If the very first request
          // is refused as too long, fold away more of the history and try once more.
          if (step === 0 && !retriedTooLong && !signal.aborted && isTooLong(err) && (await compact(KEEP_VERBATIM / 2))) {
            retriedTooLong = true
            modelTurn = start()
            step--
            continue
          }
          throw err
        }
        recorder.endText()
        recorder.addUsage(result.usage)

        switch (result.stop) {
          case 'end':
            return
          case 'max_tokens':
            incomplete(`${bot.name}'s reply reached the model's output limit and was cut short.`)
          case 'refusal':
            incomplete(`${bot.name} (${route.modelId}) declined to answer${result.detail ? ` (${result.detail})` : ''}.`)
          case 'context':
            incomplete(`This conversation no longer fits ${route.modelId}. Reset it, or pick a model with a larger context window.`)
          case 'tool_use':
            break
        }

        const results = []
        for (const call of result.toolCalls) {
          results.push({ call, result: await turn.runTool(call) })
          if (signal.aborted) return
        }
        modelTurn.addToolResults(results)
        if (turn.passed()) return
      }
      incomplete(`${bot.name} stopped after ${MAX_STEPS} steps without finishing. Ask it to continue if needed.`)
    }
  }
}
