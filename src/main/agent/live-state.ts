// Live bot states (typing / thinking / tool / waiting…) per (bot, conversation), pushed to the UI
// with `bot:state`. Idle states are dropped from the table after they are sent.

import type { BotLiveState, BotPhase, Id } from '@shared/domain'
import type { EventBus } from '../contracts'

export class LiveStates {
  private readonly states = new Map<string, BotLiveState>()
  private readonly published = new Map<string, { start: number; count: number }>()
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()

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
    if (phase === 'idle') {
      clearTimeout(this.pending.get(key))
      this.pending.delete(key)
      this.states.delete(key)
      this.published.delete(key)
      this.bus.emit('bot:state', { state })
      return
    }
    this.states.set(key, state)
    const windowMs = 100
    const publish = () => {
      clearTimeout(this.pending.get(key))
      this.pending.delete(key)
      const now = Date.now()
      const batch = this.published.get(key)
      if (!batch || now - batch.start >= windowMs) this.published.set(key, { start: now, count: 1 })
      else batch.count++
      this.bus.emit('bot:state', { state: this.states.get(key)! })
    }
    const batch = this.published.get(key)
    const remaining = batch ? windowMs - (Date.now() - batch.start) : 0
    // Keep ordinary reading/typing/approval transitions visible while bounding a burst of oscillating phases.
    if (remaining <= 0 || (current?.phase !== phase && batch && batch.count < 6)) publish()
    else if (!this.pending.has(key)) this.pending.set(key, setTimeout(publish, remaining))
  }

  idle(botId: Id, conversationId: Id): void {
    this.set(botId, conversationId, 'idle')
  }

  list(): BotLiveState[] {
    return [...this.states.values()]
  }

  /** Forget everything without notifying (shutdown). */
  clear(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    this.published.clear()
    this.states.clear()
  }
}
