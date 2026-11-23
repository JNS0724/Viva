export type EvalSystem = 'viva' | 'reme'

export interface OfflineQueryResult {
  id: string
  kind: 'answer' | 'absent' | 'ambiguous' | 'safety'
  group?: string
  text: string
  hit1: boolean
  hit5: boolean
  allEvidenceHit5: boolean
  mrr5: number
  elapsedMs: number
  safetyLeaks: number
  topIds: string[]
  topScores: number[]
}

export interface OfflineModeSummary {
  system: EvalSystem
  mode: string
  dataset: 'evaluation' | 'validation'
  indexMs: number
  /** Null when the system bundles vector preparation inside indexMs and cannot measure them separately. */
  vectorPrepMs: number | null
  answerCount: number
  hit1: number
  hit5: number
  mrr5: number
  groups: Record<string, { hit1: number, hit5: number, count: number }>
  ambiguousAllEvidenceHit5: number
  ambiguousCount: number
  absentReturnedAny: number
  absentCount: number
  safetyLeaks: number
  p50Ms: number
  p95Ms: number
  nodeSearchHit1?: number
  nodeSearchHit5?: number
  nodeSearchCount?: number
  cases: OfflineQueryResult[]
}

export interface ScalePointResult {
  docCount: number
  chunkCount: number
  indexMs: number
  vectorPrepMs: number
  lexicalP50Ms: number
  lexicalP95Ms: number
  lexicalP99Ms: number
  hybridP50Ms: number | null
  hybridP95Ms: number | null
  hybridP99Ms: number | null
  automaticP50Ms?: number | null
  automaticP95Ms?: number | null
  automaticTimeoutRate?: number | null
  rssMb: number
}

export interface ScaleBenchmarkResult {
  system: EvalSystem
  mode: string
  points: ScalePointResult[]
}

export interface WorkspaceStats {
  dailyFiles: number
  digestFiles: number
  sessionFiles: number
  totalBytes: number
  filePaths: string[]
}

export interface PhaseTokenStats {
  calls: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export interface LiveTelemetry {
  llmCalls: number
  inputTokens: number
  cacheReadTokens?: number
  outputTokens: number
  ingestMs: number
  dreamMs: number
  answerMs: number
  toolCalls: number
  toolNames: Record<string, number>
  phaseTokens?: {
    ingest: PhaseTokenStats
    dream: PhaseTokenStats
    answer: PhaseTokenStats
  }
}

export interface ChineseCaseSystemResult {
  system: EvalSystem
  mode: string
  caseId: string
  category: string
  phases: Array<{
    phaseId: string
    recallQuery: string
    recallSnippetCount: number
    answer: string
    judgeVerdict: 'yes' | 'no' | 'error'
    judgeReason: string
    patternHits: number
    patternTotal: number
    forbiddenHits: number
    isolationLeaks?: number
  }>
  workspace: WorkspaceStats
  telemetry: LiveTelemetry
  error?: string
}

export interface LmeSessionMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LmeItem {
  question_id: string
  question_type: string
  question: string
  question_date: string
  answer: string
  answer_session_ids: string[]
  haystack_dates: string[]
  haystack_session_ids: string[]
  haystack_sessions: LmeSessionMessage[][]
}

export interface LmeCaseSystemResult {
  system: EvalSystem
  mode: string
  questionId: string
  questionType: string
  isAbstention: boolean
  question: string
  groundTruth: string
  answer: string
  verdict: 'yes' | 'no' | 'error'
  judgeReason: string
  sessionsIngested: number
  dreamTriggers: number
  /** True when maxSessions truncation dropped at least one answer_session_id for a non-abstention question. */
  evidenceTruncated?: boolean
  workspace: WorkspaceStats
  telemetry: LiveTelemetry
  error?: string
}

export type LmeSessionSampling = 'recent' | 'answer-aware'

export interface EvalManifest {
  runId: string
  startedAt: string
  finishedAt?: string
  vivaCommit: string
  remeCommit: string
  remeVersion: string
  llmModel: string
  embeddingModel: string
  suites: string[]
  vivaAutoContext?: boolean
  remeEnableDream?: boolean
  lmeSessionSampling?: LmeSessionSampling
}
