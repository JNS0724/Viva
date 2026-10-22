import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { adoptDshSessions } from '../src/main/dsh-migrate.ts'
import { removeTree } from '../src/main/remove-tree.ts'
import { DSH_TIMEOUT_MS, startHarness } from './fixtures/dsh-harness.js'

/** The real dsh, on the app's own runtime, with sessions brought over from another home. */

test('a session copied over from the old home resumes with its history, without dsh caches', { timeout: DSH_TIMEOUT_MS }, async (t) => {
  const { dir, dshHome, workspace, llm, bridge } = await startHarness(t)
  const first = bridge()
  const { sessionId } = await first.start()
  await first.prompt('第一句：项目代号是青鸟')
  await first.dispose()

  // What the app finds on its first launch: the sessions in the user's ~/.dsh, nothing of its own yet.
  const oldHome = path.join(dir, 'users-dsh')
  assert.equal(adoptDshSessions({ fromHome: dshHome, toHome: oldHome, cwd: workspace }), 1)
  removeTree(path.join(dshHome, 'sessions'))
  removeTree(path.join(dshHome, 'storages'))
  assert.equal(adoptDshSessions({ fromHome: oldHome, toHome: dshHome, cwd: workspace }), 1)

  const second = bridge()
  const info = await second.start({ resumeSessionId: sessionId })
  assert.deepEqual([info.resumed, info.sessionId], [true, sessionId])
  await second.prompt('第二句')
  assert.match(JSON.stringify(llm.requests.at(-1).messages), /项目代号是青鸟/, 'the model sees the earlier turn')
})
