export interface MemoryDreamStatus {
  state: 'idle' | 'queued' | 'running' | 'waiting' | 'retry' | 'disabled'
  lastCheckResult: 'empty' | 'processed' | 'size-limit' | null
  lastCheckedAt: number | null
  lastProcessedAt: number | null
}
