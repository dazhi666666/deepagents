/** Viewer v1 transport types shared with the independent frontend. */
import type { Json } from '../../../../science-harness/integrations/ai4science/platform/sdk.ts'
import type { MarsTask } from './records.ts'
import type { createMission } from './mission.ts'
import type { marsLayout } from './layout.ts'
import type { MarsAudit } from './audit.ts'

export interface ViewerEvent {
  schemaVersion: 1
  runId: string
  branchId: string
  epoch: number
  seq: number
  tick: number
  kind: string
  actorId: string | null
  entityIds: string[]
  taskId: string | null
  operationId: string | null
  payload: Json
}
export interface ViewerEntity {
  id: string
  kind: 'device' | 'robot' | 'sample' | 'crop' | 'agent'
  position: { x: number; y: number } | null
  state: Json
}
export interface ViewerSnapshot {  schemaVersion: 1
  stage: 'foundation' | 'experiment'
  runId: string
  branchId: string
  epoch: number
  cursor: number
  tick: number
  /** Public scenario seed; hidden truth remains evaluator-side. */
  seed: number
  mode: 'environment' | 'single-agent' | 'multi-agent'
  status: 'starting' | 'running' | 'attention-required' | 'agent-ended' | 'completed' | 'stopped'
  capabilities: { trajectories: boolean; cropSimulation: boolean; objectiveAssessment: boolean; checkpointSave: boolean; checkpointRestore: boolean; scoring: boolean }
  model: { provider: string; model: string; maxTokens: number }
  mission: ReturnType<typeof createMission> | (ReturnType<typeof import('./v05/registry.ts').publicMission> & { instructions: string })
    | (ReturnType<typeof import('./v06/registry.ts').publicMission> & { instructions: string })
  map: ReturnType<typeof marsLayout>
  rules: Json
  history: Json
  utilities: { powerDemand: number; powerCapacity: number; waterUl: number; waterCapacityUl: number }
  entities: ViewerEntity[]
  agents: Json[]
  messages: Json[]
  tasks: MarsTask[]
  notes: { path: string; text: string; revision: number; updatedBy: string }[]
  research?: Json
  operations: Json[]
  deliverables: Json[]
  sensors: Json
  usage: ReturnType<MarsAudit['usage']>
  score: Json
}

/** One analysis program as listed by the research and analysis views. */
export interface ViewerAnalysisRunSummary {
  id: string
  actorId: string
  asOfTick: number
  status: 'done' | 'error'
  codeSha256: string
  codeBytes: number
  error: string | null
  outputSummary: string
  logCount: number
  references: string[]
  reproducible: boolean | null
}
export interface ViewerAnalysisRun extends ViewerAnalysisRunSummary { code: string; output: Json; logs: string[] }

/** Active and recent model requests, derived from audit.jsonl wall-clock records. */
export interface ViewerModelActivity {
  now: number
  active: { requestId: string; actorId: string | null; role: string | null; provider: string; model: string; purpose: string;
    tick: number; startedAt: number | null; waitedSeconds: number | null }[]
  recent: { requestId: string; actorId: string | null; role: string | null; provider: string; model: string; purpose: string;
    tick: number; reason: Json; durationSeconds: number | null }[]
}

/** Post-game evaluator view; unavailable while the mission is running. */
export interface ViewerEvaluation {
  score: Json
  incidents: { id: string; onset: number }[]
  answers: Json | null
  baselines: { null: number; ref: number } | null
  taskTruths: Record<string, unknown>
  truth: Json
  crops: { id: string; status: string; removed: boolean; infectedSince: number | null; exposureTicks: number; growth: number }[]
  tasks: Record<string, { A?: number; d?: number; r?: number; points?: number }>
}
