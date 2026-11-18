// Human-in-the-loop cards. A request posts an `approval` entry and waits for resolve().
// Exchange conversations are read-only side chats the user is rarely looking at, so the card is
// mirrored into the conversation the chain started from; answering either card resolves both.

import { randomUUID } from 'node:crypto'
import type { ApprovalDecision, ApprovalInfo, Conversation, Id } from '@shared/domain'
import type { ApprovalEvent, ApprovalService, EventBus, Store } from '../contracts'
import type { PlatformEntryRepo } from '../store/entries'

interface Pending {
  entryIds: Id[]
  settle(decision: ApprovalDecision, status: ApprovalInfo['status']): void
}

export function createApprovalService(deps: {
  store: Pick<Store, 'conversations'> & { entries: PlatformEntryRepo }
  bus: EventBus
}): ApprovalService {
  const { store, bus } = deps
  const pending = new Map<Id, Pending>()
  const listeners = new Set<(event: ApprovalEvent) => void>()

  const notify = (event: ApprovalEvent) => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[approvals] listener failed:', err instanceof Error ? err.message : err)
      }
    }
  }

  const updateCards = (entryIds: Id[], patch: Partial<ApprovalInfo>) => {
    for (const id of entryIds) {
      const entry = store.entries.get(id)
      if (!entry?.approval) continue
      bus.emit('conv:entry', { entry: store.entries.update(id, { approval: { ...entry.approval, ...patch } }) })
    }
  }

  // Nobody waits on cards left over from a previous run.
  for (const entry of store.entries.pendingApprovals()) {
    store.entries.update(entry.id, { approval: { ...entry.approval!, status: 'expired' } })
  }

  /** The non-exchange conversation an exchange chain started from (if any). */
  const rootOf = (conversation: Conversation): Conversation | undefined => {
    let current: Conversation | undefined = conversation
    for (let depth = 0; current?.kind === 'exchange' && current.origin && depth < 10; depth++) {
      current = store.conversations.get(current.origin.conversationId)
    }
    return current && current.id !== conversation.id && current.kind !== 'exchange' ? current : undefined
  }

  return {
    request({ ctx, toolName, summary, toolInput }) {
      if (ctx.signal.aborted) return Promise.resolve('deny')
      const approvalId = randomUUID()
      const approval: ApprovalInfo = { approvalId, toolName, summary, input: toolInput, status: 'pending' }
      const targets = [ctx.conversation.id]
      const root = rootOf(ctx.conversation)
      if (root) targets.push(root.id)

      const entryIds = targets.map((conversationId) => {
        const entry = store.entries.append({
          conversationId,
          kind: 'approval',
          author: { kind: 'bot', botId: ctx.bot.id },
          text: summary,
          mentions: [],
          mentionsEveryone: false,
          attachments: [],
          approval,
          isStreaming: false
        })
        bus.emit('conv:entry', { entry })
        return entry.id
      })

      return new Promise<ApprovalDecision>((resolve) => {
        const onAbort = () => settle('deny', 'expired')
        const settle = (decision: ApprovalDecision, status: ApprovalInfo['status']) => {
          if (!pending.delete(approvalId)) return
          ctx.signal.removeEventListener('abort', onAbort)
          updateCards(entryIds, status === 'resolved' ? { status, decision } : { status })
          notify({ approvalId, state: status === 'resolved' ? 'resolved' : 'expired', ctx, toolName, summary })
          resolve(decision)
        }
        pending.set(approvalId, { entryIds, settle })
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        notify({ approvalId, state: 'pending', ctx, toolName, summary })
      })
    },

    resolve(approvalId, decision) {
      const waiting = pending.get(approvalId)
      if (waiting) {
        waiting.settle(decision, 'resolved')
        return
      }
      // A card from before a restart (or already answered): make sure it no longer looks pending.
      const stale = store.entries.byApprovalId(approvalId).filter((e) => e.approval?.status === 'pending')
      updateCards(stale.map((e) => e.id), { status: 'expired' })
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
