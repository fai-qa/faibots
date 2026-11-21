// Live bot states (typing / thinking / tool / waiting…) per (bot, conversation), pushed to the UI
// with `bot:state`. Idle states are dropped from the table after they are sent.

import type { BotLiveState, BotPhase, Id } from '@shared/domain'
import type { EventBus } from '../contracts'

export class LiveStates {
  private readonly states = new Map<string, BotLiveState>()

  constructor(private readonly bus: EventBus) {}

  private key(botId: Id, conversationId: Id) {
    return `${botId}\u0000${conversationId}`
  }

  get(botId: Id, conversationId: Id): BotLiveState | undefined {
    return this.states.get(this.key(botId, conversationId))
  }

  set(botId: Id, conversationId: Id, phase: BotPhase, activity?: string): void {
    const key = this.key(botId, conversationId)
    const current = this.states.get(key)
    // Repeated real engine activity refreshes the observation. A silent worker never gets a synthetic heartbeat.
    if (current && current.phase === phase && current.activity === activity && Date.now() - current.updatedAt < 15_000) return
    if (!current && phase === 'idle') return
    const state: BotLiveState = { botId, conversationId, phase, ...(activity && { activity }), updatedAt: Date.now() }
    if (phase === 'idle') this.states.delete(key)
    else this.states.set(key, state)
    this.bus.emit('bot:state', { state })
  }

  idle(botId: Id, conversationId: Id): void {
    this.set(botId, conversationId, 'idle')
  }

  list(): BotLiveState[] {
    return [...this.states.values()]
  }

  /** Forget everything without notifying (shutdown). */
  clear(): void {
    this.states.clear()
  }
}
