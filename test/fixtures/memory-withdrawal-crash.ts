import { join } from 'node:path'
import { openAppDb, transaction } from '../../src/backend/app-db.ts'
import { createEffects } from '../../src/backend/effects.ts'
import { openHistoryDb } from '../../src/backend/history-db.ts'
import { createMemoryRuntime } from '../../src/backend/memory-runtime.ts'
import { openMemoryStore } from '../../src/memory/node/memory-store.ts'
import { createMemoryWithdrawal } from '../../src/backend/memory-withdrawal.ts'
import { crashAt } from './memory-crash-process.ts'

const [, , checkpoint, directory, conversationId] = process.argv
if (checkpoint !== 'before-withdrawal' || !directory || !conversationId) throw new Error('Expected a test profile and conversation ID')

const app = openAppDb({ file: join(directory, 'app.db') })
const history = openHistoryDb({ db: app.db })
const effects = createEffects({ db: app.db })
const store = openMemoryStore(join(directory, 'memory.db'))
const memory = createMemoryRuntime({
  store, compute: () => null, route: () => null, changed: () => {}, quiesce: async () => {},
})
const withdrawal = createMemoryWithdrawal({
  history: () => history,
  effects: () => effects,
  memory: () => ({
    ...memory,
    withdraw: () => {
      // The history transaction committed before the coordinator entered the withdrawal.
      return crashAt(checkpoint)
    },
  }),
  apply: (_kind, _data, work) => ({ value: transaction(app.db, work) }),
  changing: async work => work(),
})
await withdrawal.deleteHistory(conversationId)
throw new Error('The crash fixture did not reach the withdrawal point')
