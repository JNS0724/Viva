import { join } from 'node:path'
import { openAppDb, transaction } from '../../src/backend/app-db.ts'
import { createEffects } from '../../src/backend/effects.ts'
import { openHistoryDb } from '../../src/backend/history-db.ts'
import { openMemoryOwner } from '../../src/memory/node/owner.ts'
import { createMemoryWithdrawal } from '../../src/backend/memory-withdrawal.ts'
import { memoryOwnerCaller } from './memory-owner-caller.ts'
import { crashAt } from './memory-crash-process.ts'

const [, , checkpoint, directory, conversationId] = process.argv
if (checkpoint !== 'before-withdrawal' || !directory || !conversationId) throw new Error('Expected a test profile and conversation ID')
const app = openAppDb({ file: join(directory, 'app.db') })
const history = openHistoryDb({ db: app.db })
const effects = createEffects({ db: app.db })
const owner = openMemoryOwner({ root: join(directory, 'memory'), hostNamespace: 'viva', compute: () => null, route: () => null, quiesce: async () => {} })
await owner.recover()
const call = memoryOwnerCaller(owner, method => {
  // Both the plugin fence and the host history transaction have committed; only commit RPC is missing.
  if (method === 'commitSourceChange') crashAt(checkpoint)
})
const withdrawal = createMemoryWithdrawal({ history: () => history, effects: () => effects, memory: () => ({ call }),
  apply: (_kind, _data, work) => ({ value: transaction(app.db, work) }), changing: async work => work(),
})
await withdrawal.deleteHistory(conversationId)
throw new Error('The crash fixture did not reach the withdrawal point')
