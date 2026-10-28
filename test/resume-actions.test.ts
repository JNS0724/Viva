import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createResumeActions } from '../src/renderer/resume-actions.ts'

/** 继续这个话题 in the window: the directory said first; a fault retried; a session or directory gone, the user asked. */

type Api = Parameters<typeof createResumeActions>[0]['api']
const INFO = { mode: 'live', model: 'V4', cwd: '/w', sessionId: 's-new' } as AgentInfo

function setup(api: Partial<Api>, { busy = false } = {}) {
  let state: State = initialState
  const toasts: Array<{ text: string, action?: ToastAction | null }> = []
  let resumed = 0
  const actions = createResumeActions({
    api: api as Api, getState: () => state, dispatch: (action) => { state = reduce(state, action) },
    errorMessage: (err) => (err instanceof Error ? err.message : String(err)),
    showToast: (text, options) => { toasts.push({ text, action: options?.action }) },
    busy: () => busy, afterResume: () => { resumed += 1 },
  })
  return { actions, toasts, state: () => state, resumed: () => resumed }
}

test('in the same directory the topic is taken up at once', async () => {
  const asked: string[] = []
  const { actions, state, resumed } = setup({
    resumeCheck: async () => ({ cwd: '/w', exists: true, same: true }),
    resumeTopic: async (id) => { asked.push(id); return { ok: true, info: INFO, parentId: id } },
  })
  await actions.resumeTopic('seg-1')
  assert.deepEqual(asked, ['seg-1'])
  assert.deepEqual([state().topic.parentId, state().topic.carried, state().resume, resumed()], ['seg-1', null, null, 1])
})

test('another directory is said before switching; nothing is switched until the user says so', async () => {
  const asked: string[] = []
  const { actions, state } = setup({
    resumeCheck: async () => ({ cwd: '/other', exists: true, same: false }),
    resumeTopic: async (id) => { asked.push(id); return { ok: true, info: INFO, parentId: id } },
  })
  await actions.resumeTopic('seg-1')
  assert.deepEqual([state().resume, asked], [{ stage: 'confirm-dir', segmentId: 'seg-1', cwd: '/other' }, []])
  await actions.resumeConfirm()
  assert.deepEqual([state().resume, asked, state().topic.parentId], [null, ['seg-1'], 'seg-1'])
})

test('a fault on the way says so with 重试, and opens nothing; the agent info follows where it is', async () => {
  const { actions, state, toasts } = setup({
    resumeCheck: async () => ({ cwd: '/w', exists: true, same: true }),
    resumeTopic: async () => ({ ok: false, reason: 'unavailable', message: 'connect ECONNRESET', cwd: '/w', info: { ...INFO, sessionId: 's-back' } }),
  })
  await actions.resumeTopic('seg-1')
  assert.match(toasts[0].text, /暂时接不上原来的会话.*ECONNRESET/)
  assert.deepEqual(toasts[0].action, { label: '重试', kind: 'resume-topic', payload: 'seg-1' })
  assert.deepEqual([state().resume, state().switching, state().info.sessionId], [null, false, 's-back'])
})

test('a session gone asks to go on from the records; going on says how many turns went with it', async () => {
  const went: unknown[] = []
  const { actions, state } = setup({
    resumeCheck: async () => ({ cwd: '/w', exists: true, same: true }),
    resumeTopic: async () => ({ ok: false, reason: 'gone', message: 'session is not resumable', cwd: '/w', info: INFO }),
    continueFromRecords: async (id, dir) => { went.push([id, dir]); return { info: INFO, parentId: id, turns: 12 } },
  })
  await actions.resumeTopic('seg-1')
  assert.deepEqual(state().resume, { stage: 'gone', segmentId: 'seg-1', cwd: '/w' })
  await actions.resumeConfirm()
  assert.deepEqual(went, [['seg-1', '/w']])
  assert.deepEqual([state().topic.parentId, state().topic.carried, state().resume], ['seg-1', 12, null])
})

test('a directory gone asks for another; none chosen changes nothing', async () => {
  const went: unknown[] = []
  let chosen: string | null = null
  const { actions, state } = setup({
    resumeCheck: async () => ({ cwd: '/gone', exists: false, same: false }),
    chooseWorkDir: async () => chosen,
    continueFromRecords: async (id, dir) => { went.push([id, dir]); return { info: INFO, parentId: id, turns: 3 } },
  })
  await actions.resumeTopic('seg-1')
  assert.equal(state().resume?.stage, 'missing-dir')
  await actions.resumeChooseDir()
  assert.deepEqual([went, state().resume?.stage], [[], 'missing-dir'], 'cancelled: still asking')
  chosen = '/new'
  await actions.resumeChooseDir()
  assert.deepEqual(went, [['seg-1', '/new']])
  assert.equal(state().topic.carried, 3)
})

test('while the agent works nothing is taken up', async () => {
  let checked = 0
  const { actions, toasts } = setup({ resumeCheck: async () => { checked += 1; return { cwd: '/w', exists: true, same: true } } }, { busy: true })
  await actions.resumeTopic('seg-1')
  assert.equal(checked, 0)
  assert.match(toasts[0].text, /正在工作/)
})
