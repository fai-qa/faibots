export type TrialCase = 'matched' | 'heldout'
export type ImprovementDecision = 'proposed' | 'approved' | 'rejected'
export interface ProjectInstruction { id: string; version: number; instruction: string; requiredText: string }
export interface ImprovementCandidate extends ProjectInstruction {
  decision: ImprovementDecision; matched: string; heldout: string; base: string | null
}
export interface ImprovementTrial {
  runId: string; candidateId: string; lane: TrialCase; baselineId: string; status: string
  observed: 'pending' | 'passed' | 'failed'; reason: string; sha256: string | null
}
export interface Improvements {
  active: ProjectInstruction | null
  cases: { runId: string; name: string }[]
  candidates: ImprovementCandidate[]
  trials: ImprovementTrial[]
  production: { runId: string; version: number; observed: string; reason: string }[]
  history: { version: number | null; action: string; at: number }[]
}
type Project = { projectId: string }
type Candidate = Project & { candidateId: string }
export interface ImprovementInvoke {
  'improvement:list': { req: Project; res: Improvements }
  'improvement:propose': { req: Project & { instruction: string; requiredText: string; matched: string; heldout: string }; res: string }
  'improvement:review': { req: Candidate & { decision: 'approved' | 'rejected' }; res: void }
  'improvement:trial': { req: Candidate & { lane: TrialCase }; res: string }
  'improvement:publish': { req: Candidate; res: void }
  'improvement:rollback': { req: Candidate; res: void }
}
export const IMPROVEMENT_CHANNELS = ['improvement:list','improvement:propose','improvement:review','improvement:trial','improvement:publish','improvement:rollback'] as const
