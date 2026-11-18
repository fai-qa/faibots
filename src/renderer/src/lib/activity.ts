// Rotating status phrases shown while a bot works (our own wording, same spirit as the
// original's "working" line).

import type { BotPhase } from '@shared/domain'

export const PHASE_PHRASES: Record<Exclude<BotPhase, 'idle'>, string[]> = {
  reading: ['Reading along', 'Catching up', 'Doing some reading'],
  thinking: ['Thinking it through', 'Mulling it over', 'Putting it together', 'Working on it'],
  typing: ['Writing a reply', 'Putting it into words', 'Almost there'],
  tool: ['Getting it done', 'Making progress', 'Running a few commands', 'Waiting on results', 'Chipping away'],
  waiting: ['Needs your input']
}

export function phrasesFor(phase: BotPhase, activity?: string): string[] {
  if (phase === 'idle') return []
  const base = PHASE_PHRASES[phase]
  // A concrete activity from the runtime ("Checking with Iris") always comes first.
  return activity ? [activity, ...base.filter((p) => p !== activity)] : base
}

export const PHASE_RANK: Record<BotPhase, number> = {
  waiting: 5,
  typing: 4,
  tool: 3,
  thinking: 2,
  reading: 1,
  idle: 0
}
