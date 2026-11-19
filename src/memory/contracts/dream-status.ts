export interface MemoryDreamStatus {
  state: 'idle' | 'queued' | 'running' | 'waiting' | 'retry' | 'disabled'
  lastCheckResult: 'empty' | 'processed' | 'size-limit' | null
  lastCheckedAt: number | null
  lastProcessedAt: number | null
  /** Manual requests keep the same job identity when a reply is lost. */
  jobId?: string
  completedAt?: number | null
}
