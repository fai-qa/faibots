export const SPECIALIST_JOB_KINDS = ['research', 'analysis', 'writing', 'editing', 'review', 'implementation', 'operations'] as const
export type SpecialistJobKind = (typeof SPECIALIST_JOB_KINDS)[number]
