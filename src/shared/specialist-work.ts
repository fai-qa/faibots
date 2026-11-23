export const SPECIALIST_JOB_KINDS = ['research', 'analysis', 'writing', 'editing', 'review', 'implementation', 'operations'] as const
export type SpecialistJobKind = (typeof SPECIALIST_JOB_KINDS)[number]

/** Measured history for the selected bot in the admitting chat, as it stood before this assignment. */
export interface SelectionComparison {
  kind: SpecialistJobKind
  count: number
  medianMs: number | null
  metered: number
  medianTokens: number | null
}
