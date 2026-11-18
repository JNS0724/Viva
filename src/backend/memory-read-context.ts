import { AsyncLocalStorage } from 'node:async_hooks'
import type { createRequestBudget } from '../shared/request-budget.ts'

/** Business request lifetime, independent of optional diagnostic context. */
export const memoryReadContext = new AsyncLocalStorage<ReturnType<typeof createRequestBudget>>()
