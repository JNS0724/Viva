export { createRequestBudget, RequestTimeout } from '../memory/core/request-budget.ts'

export const DEFAULT_TOOL_TIMEOUT_MS = 5_000
export const APP_WRITE_TIMEOUT_MS = 30_000
export const MEMORY_READ_BUDGET_MS = 10_000
export const INITIALIZATION_BUDGET_MS = 30_000
export type MemoryReadOptions = { budgetMs?: number }
