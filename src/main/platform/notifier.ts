// Decides when to raise a desktop notification: a bot finished a reply, or it is waiting for the
// user's approval, while the window is not focused. Pure logic (no Electron import), so it is
// testable; index.ts passes in the real notify() and window focus check.

import type { Bot, BotPhase, Conversation, Entry, Id } from '@shared/domain'
import type { EventMap } from '@shared/ipc'
import type { ApprovalEvent, Store } from '../contracts'

export interface NotifierDeps {
  store: Pick<Store, 'bots' | 'conversations' | 'settings'>
  isWindowFocused(): boolean
  show(input: { title: string; body: string; urgent: boolean; conversationId: Id }): void
}

const preview = (text: string) => {
  const flat = text.replace(/[`*_#>\[\]]/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat
}

export function createNotifier(deps: NotifierDeps) {
  const { store } = deps
  const phases = new Map<string, BotPhase>()
  /** Last finished bot message per conversation and bot, waiting for the turn to end. */
  const replies = new Map<string, Entry>()
  /** Routine whose run is waiting for a reply, per conversation (named in the notification). */
  const routines = new Map<Id, string>()
  const key = (conversationId: Id, botId: Id) => `${conversationId}:${botId}`

  /** Exchanges are side chats; point the user at the conversation the chain started from. */
  const rootOf = (conversation: Conversation | undefined): Conversation | undefined => {
    let current = conversation
    for (let depth = 0; current?.kind === 'exchange' && current.origin && depth < 10; depth++) {
      current = store.conversations.get(current.origin.conversationId)
    }
    return current
  }

  const allowed = (botId: Id) => {
    if (deps.isWindowFocused()) return false
    if (!store.settings.get().notifications.enabled) return false
    return store.bots.get(botId)?.notify ?? false
  }

  return {
    /** Feed every bus event through here. */
    onEvent<C extends keyof EventMap>(channel: C, payload: EventMap[C]): void {
      if (channel === 'conv:entry') {
        const { entry } = payload as EventMap['conv:entry']
        if (entry.trigger) {
          routines.set(entry.conversationId, entry.trigger.kind === 'mission' ? entry.trigger.projectName : entry.trigger.routineName)
        }
        if (entry.kind === 'message' && entry.author.kind === 'bot' && !entry.isStreaming && entry.text.trim()) {
          replies.set(key(entry.conversationId, entry.author.botId), entry)
        }
        return
      }
      if (channel !== 'bot:state') return
      const { state } = payload as EventMap['bot:state']
      const k = key(state.conversationId, state.botId)
      const previous = phases.get(k)
      phases.set(k, state.phase)
      if (state.phase !== 'idle' || !previous || previous === 'idle') return

      const reply = replies.get(k)
      replies.delete(k)
      const conversation = store.conversations.get(state.conversationId)
      if (!reply || !conversation || conversation.kind === 'exchange' || !allowed(state.botId)) return
      const bot = store.bots.get(state.botId)
      const where = conversation.kind === 'group' ? ` in ${conversation.title || 'your group'}` : ''
      const routine = routines.get(conversation.id)
      routines.delete(conversation.id)
      deps.show({
        title: routine ? `${routine}: ${bot?.name ?? 'A bot'} finished` : `${bot?.name ?? 'A bot'} replied${where}`,
        body: preview(reply.text),
        urgent: false,
        conversationId: conversation.id
      })
    },

    onApproval(event: ApprovalEvent): void {
      if (event.state !== 'pending' || !allowed(event.ctx.bot.id)) return
      const root = rootOf(store.conversations.get(event.ctx.conversation.id)) ?? event.ctx.conversation
      deps.show({
        title: `${event.ctx.bot.name} needs your OK`,
        body: preview(event.summary),
        urgent: true,
        conversationId: root.id
      })
    }
  }
}
