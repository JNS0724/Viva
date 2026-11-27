import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { openAppDb } from '../src/backend/app-db.ts'
import { openHistoryDb } from '../src/backend/history-db.ts'
import { createQuestionDesk } from '../src/backend/question-channel.ts'
import { createTaskRuntime } from '../src/backend/task-runtime.ts'
import type { TaskDispatchMeta } from '../src/backend/acp-task-sessions.ts'
import { createTaskStore } from '../src/backend/task-store.ts'
import { DAILY_MEMORY_DEFAULTS } from '../src/memory/contracts/memory-daily-defaults.ts'
import { todayAt } from '../src/memory/core/memory-calendar.ts'
import { DREAM_CONSOLIDATE_SYSTEM, DREAM_PROFILE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { createMemoryRuntime as createCoreMemoryRuntime } from '../src/memory/core/memory-runtime.ts'
import { openMemoryNotes } from '../src/memory/node/memory-note-store.ts'
import { memoryHash, openMemoryStore } from '../src/memory/node/memory-store.ts'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { createMemoryOwnerSupervisor } from '../src/memory/node/owner-supervisor.ts'
import { openMemoryRuntimeResources } from '../src/memory/node/runtime.ts'
import { offlineMemorySafety } from './fixtures/memory-safety.ts'
import {
  eligibleQuestionAnswers,
  eligibleQuestionSelections,
  questionAnswerSourceId,
  questionSelectionSourceId,
} from '../src/memory/node/question-answer-memory.ts'
import { withRequestSource } from '../src/shared/request-routing/header.ts'
import {
  encodeProvenancePrefix,
  parseProvenanceHeader,
  withProvenanceHeader,
} from '../src/shared/request-routing/provenance.ts'
import { withTaskRequestSource } from '../src/shared/request-routing/task-header.ts'
import { createSessionIngestion, readPersistedSessionRange } from '../plugins/memory/lib/ingestion.ts'
import { apply as applyQuestionsPlugin } from '../plugins/questions/index.ts'
import type { HumanQuestionReceipt } from '../plugins/questions/lib/channel.ts'
import { createSteerChannel } from '../plugins/steer/lib/channel.ts'
import { liftProvenance } from '../plugins/steer/index.ts'
import { dreamModelStep } from './fixtures/dream-model.ts'
import { eventually } from './fixtures/eventually.ts'
import { scratch } from './fixtures/scratch.js'

function notFoundError(message = 'Session not found') {
  return Object.assign(new Error(message), { name: 'SessionPersistenceNotFoundError' })
}

function makeFakePort() {
  const emitter = new EventEmitter()
  const sent: unknown[] = []
  return Object.assign(emitter, {
    connected: true,
    sent,
    send(message: unknown, cb?: (err?: Error | null) => void) {
      sent.push(message)
      cb?.(null)
      return true
    },
  })
}

type CapturedNoteInput = {
  existing?: { title: string, state: string, recentEvents: string[] }
  freezeState?: boolean
  turns: Array<{
    sessionKind: string
    previousAssistant: string | null
    user: Array<{ sourceId: string, text: string, author: string, sourceKind?: string, question: string | null }>
    assistant: string
  }>
}

test('§5.1 out-of-order anti-regression, mixed-watermark split, heading sanitization, and journal crash recovery', async t => {
  const { dir, defer } = scratch(t, 'thread-notes-watermark-')
  const root = path.join(dir, 'memory')
  const topicId = 'topic-order-1'
  const t1000 = Date.parse('2026-11-26T10:00:00Z')
  const t1005 = Date.parse('2026-11-26T10:05:00Z')
  const t1010 = Date.parse('2026-11-26T10:10:00Z')
  const t1020 = Date.parse('2026-11-26T10:20:00Z')

  const noteInputs: CapturedNoteInput[] = []
  const open = (noteInterval = 5) => openMemoryOwner({
    root,
    hostNamespace: 'viva',
    now: () => t1020,
    dailyNotes: { noteInterval, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async ({ sessionId }) => ({
      status: 'ok',
      assistant: sessionId === 'task-1010'
        ? '进展 2：已修复连接池泄漏并验证通过'
        : sessionId === 'main-1000'
          ? '收到，正在排查卡点 1'
          : '已处理',
    }),
    compute: job => {
      if (job.stage !== 'note') return null
      const input = JSON.parse(job.input) as CapturedNoteInput
      noteInputs.push(input)
      const texts = input.turns.flatMap(turn => turn.user.map(u => u.text)).join(' ')
      if (texts.includes('后台推进到进展 2')) {
        return Promise.resolve(JSON.stringify({
          status: 'write',
          title: '网关改造（进展 2）',
          state: '当前处于进展 2：连接池泄漏已修复，等待灰度。',
          events: ['## 伪造标题前缀 后台定位并修复连接池泄漏（进展 2）'],
        }))
      }
      if (texts.includes('主对话发起做 A')) {
        return Promise.resolve(JSON.stringify({
          status: 'write',
          title: '旧标题（卡点 1）',
          state: '在做 A，卡点仍是 1（不应覆盖新状态！）',
          events: ['发起做 A，遇到卡点 1'],
        }))
      }
      if (texts.includes('迟到补充 10:05')) {
        return Promise.resolve(JSON.stringify({
          status: 'write',
          title: '旧补充标题',
          state: '10:05 的旧状态（不应覆盖）',
          events: ['补充了 10:05 的日志线索'],
        }))
      }
      return Promise.resolve(JSON.stringify({
        status: 'write',
        title: '网关改造（进展 3）',
        state: '当前处于进展 3：灰度发布已完成。',
        events: ['灰度发布完成（进展 3）'],
      }))
    },
  })

  let owner = open(5)
  defer(() => owner.close())
  await owner.recover()

  // 1. Task T@10:10 settles and flushes FIRST, advancing state to "进展 2" and watermark to 10:10.
  await owner.settleTurn({
    sessionId: 'task-1010',
    cwd: dir,
    sessionKind: 'task',
    conversation: 'seg-task-1',
    thread: topicId,
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 4,
    turn: 1,
    reasonKind: 'completed',
    sources: [
      { sourceId: randomUUID(), author: 'agent', sourceKind: 'task-brief', profileEligible: false, text: '后台推进到进展 2', eventSeq: 1, at: t1010, timezone: 'UTC' },
      { sourceId: randomUUID(), author: 'assistant', sourceKind: 'task-assistant', profileEligible: false, text: '进展 2：已修复连接池泄漏并验证通过', eventSeq: 3, at: t1010, timezone: 'UTC' },
    ],
    assistantText: '进展 2：已修复连接池泄漏并验证通过',
    at: t1010,
    timezone: 'UTC',
    flushNotes: true,
  })
  await owner.runtime.wake()

  await owner.close()
  const rawDb = new DatabaseSync(path.join(root, 'memory.db'))
  const rowAfterTask = rawDb.prepare('SELECT key, workspace, path, state_watermark_at, state_watermark_key FROM memory_daily_notes').get() as {
    key: string, workspace: string, path: string, state_watermark_at: number, state_watermark_key: string
  }
  assert.match(readFileSync(path.join(root, 'memory-files', rowAfterTask.workspace, rowAfterTask.path), 'utf8'), /name: 网关改造（进展 2）/)
  assert.equal(rowAfterTask.state_watermark_at, t1010)
  assert.ok(rowAfterTask.state_watermark_key.startsWith('task-1010\n'))
  rawDb.close()

  // Verify REAL crash injection between physical file replace and SQLite receipt on openMemoryNotes:
  const crashStore = openMemoryStore(path.join(dir, 'crash-journal.db'), () => t1010)
  defer(() => crashStore.close())
  const crashNotes = openMemoryNotes(crashStore, () => true, point => {
    if (point === 'receipt') throw new Error('crash-between-replace-and-receipt')
  })
  const crashSrcId = randomUUID()
  crashStore.insertSource({
    id: crashSrcId, operation: crashSrcId, version: 1, conversation: 'c1', session: 's1',
    scope: { kind: 'user' }, context: { kind: 'user' }, project: null,
    author: 'user', sourceKind: 'main-human', profileEligible: true,
    text: '崩溃恢复水位验证', hash: memoryHash('崩溃恢复水位验证'), length: 8,
    question: null, requestId: null, questionId: null, at: t1010, timezone: 'UTC', outcome: 'note-pending',
  })
  const crashSrc = crashStore.readSource(crashSrcId)!
  const crashKey = crashNotes.addRange({
    session: 's1', groupKey: 'topic-crash', sessionKind: 'main', day: '2026-11-26',
    fromSeq: 0, toSeq: 3, turn: 1, turnAt: t1010, sources: [crashSrc],
    assistantDigest: null, assistantSources: [], questionSources: [], questionCurrent: true,
  })!
  assert.throws(
    () => crashNotes.commit(
      crashKey,
      crashNotes.pending(crashKey),
      { status: 'write', title: '崩溃水位标题', markdown: '## 当前状态\n崩溃前状态' },
      1,
      t1010,
      crashNotes.snapshot([crashSrcId]),
      undefined,
      { at: t1010, key: 's1\n1:0000000000000003' },
    ),
    /crash-between-replace-and-receipt/,
  )
  assert.equal(crashStore.db.prepare('SELECT COUNT(*) AS n FROM memory_daily_notes').get()?.n, 0, 'SQLite receipt has not run yet at crash point')
  const recoveredNotes = openMemoryNotes(crashStore, () => true)
  assert.equal(recoveredNotes.needsRecovery(), false)
  const committedNoteRow = crashStore.db.prepare('SELECT state_watermark_at, state_watermark_key FROM memory_daily_notes WHERE key=?').get(crashKey) as {
    state_watermark_at: number, state_watermark_key: string
  }
  assert.equal(committedNoteRow.state_watermark_at, t1010, 'journal recovery after replace->receipt crash must restore state_watermark_at')
  assert.equal(committedNoteRow.state_watermark_key, 's1\n1:0000000000000003', 'journal recovery after replace->receipt crash must restore state_watermark_key')

  // Reopen production owner and cold-settle earlier main turn M@10:00!
  owner = open(5)
  await owner.recover()
  await owner.settleTurn({
    sessionId: 'main-1000',
    cwd: dir,
    sessionKind: 'main',
    conversation: 'conv-main-1',
    thread: topicId,
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 3,
    turn: 1,
    reasonKind: 'completed',
    sources: [
      { sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '主对话发起做 A，遇到卡点 1', eventSeq: 1, at: t1000, timezone: 'UTC' },
    ],
    assistantText: '收到，正在排查卡点 1',
    at: t1000,
    timezone: 'UTC',
    flushNotes: true,
  })
  await owner.runtime.wake()

  assert.equal(noteInputs.length, 2)
  assert.equal(noteInputs[1]!.freezeState, true, 'late cold-arriving turn <= watermark must run with freezeState=true')

  const checkDb = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  defer(() => checkDb.close())
  const afterLate = checkDb.prepare('SELECT workspace, path, state_watermark_at FROM memory_daily_notes').get() as {
    workspace: string, path: string, state_watermark_at: number
  }
  assert.equal(afterLate.state_watermark_at, t1010, 'late turn must NOT regress state_watermark_at')

  const bodyAfterLate = readFileSync(path.join(root, 'memory-files', afterLate.workspace, afterLate.path), 'utf8')
  assert.match(bodyAfterLate, /name: 网关改造（进展 2）/, 'late turn must NOT regress card title')
  assert.ok(bodyAfterLate.indexOf('## 当前状态') < bodyAfterLate.indexOf('## 经过'), '## 当前状态 must be placed at top above ## 经过')
  assert.match(bodyAfterLate, /## 当前状态\n当前处于进展 2：连接池泄漏已修复，等待灰度。/)
  assert.doesNotMatch(bodyAfterLate, /不应覆盖新状态/, 'frozen state must reject model state regression')
  assert.doesNotMatch(bodyAfterLate, /\n## 伪造标题前缀/, 'events[] leading # characters must be stripped so events cannot spoof headings')
  const idx1000 = bodyAfterLate.indexOf('- [10:00] 发起做 A，遇到卡点 1')
  const idx1010 = bodyAfterLate.indexOf('- [10:10] 伪造标题前缀 后台定位并修复连接池泄漏（进展 2）')
  assert.ok(idx1000 >= 0 && idx1010 > idx1000, `late 10:00 event must be chronologically inserted before 10:10 event:\n${bodyAfterLate}`)

  // 2. Mixed batch spanning watermark [10:05 <= 10:10, 10:20 > 10:10]: splits into frozen step + advancing step!
  await owner.settleTurn({
    sessionId: 'main-1005',
    cwd: dir,
    sessionKind: 'main',
    conversation: 'conv-main-1',
    thread: topicId,
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 3,
    turn: 1,
    reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '迟到补充 10:05', eventSeq: 1, at: t1005, timezone: 'UTC' }],
    assistantText: '已处理',
    at: t1005,
    timezone: 'UTC',
    flushNotes: false,
  })
  await owner.settleTurn({
    sessionId: 'task-1020',
    cwd: dir,
    sessionKind: 'task',
    conversation: 'seg-task-1',
    thread: topicId,
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 3,
    turn: 1,
    reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'assistant', sourceKind: 'task-assistant', profileEligible: false, text: '灰度发布完成（进展 3）', eventSeq: 2, at: t1020, timezone: 'UTC' }],
    assistantText: '已处理',
    at: t1020,
    timezone: 'UTC',
    flushNotes: true,
  })
  await owner.runtime.wake()

  assert.equal(noteInputs.length, 4, 'mixed batch crossing watermark must split into two note generations')
  assert.equal(noteInputs[2]!.freezeState, true)
  assert.equal(noteInputs[3]!.freezeState, undefined)
  const afterMixed = checkDb.prepare('SELECT state_watermark_at FROM memory_daily_notes').get() as { state_watermark_at: number }
  assert.equal(afterMixed.state_watermark_at, t1020)
  const finalBody = readFileSync(path.join(root, 'memory-files', afterLate.workspace, afterLate.path), 'utf8')
  assert.match(finalBody, /name: 网关改造（进展 3）/)
  assert.match(finalBody, /## 当前状态\n当前处于进展 3：灰度发布已完成。/)
  const i00 = finalBody.indexOf('[10:00]')
  const i05 = finalBody.indexOf('[10:05]')
  const i10 = finalBody.indexOf('[10:10]')
  const i20 = finalBody.indexOf('[10:20]')
  assert.ok(i00 >= 0 && i05 > i00 && i10 > i05 && i20 > i10, `timeline must maintain chronological order:\n${finalBody}`)
})

test('§5.2 cross-topic task reuse isolation: routed rebind vs drawer keep-topic vs mid-turn cross-topic steer refusal', async t => {
  const { dir, defer } = scratch(t, 'thread-notes-cross-topic-')
  const nowMs = Date.now()
  const expectedHostDay = todayAt(nowMs, 'UTC')
  const appDb = openAppDb({ file: path.join(dir, 'app.db') })
  defer(() => appDb.close())
  const historyDb = openHistoryDb({ db: appDb.db })
  defer(() => historyDb.close())

  const convA = historyDb.save(historyDb.create({ sessionId: 'sess-main-a' }), [{ role: 'user', text: '话题 A 起点', receipt: null }]).id
  const convB = historyDb.save(historyDb.create({ sessionId: 'sess-main-b' }), [{ role: 'user', text: '话题 B 起点', receipt: null }]).id
  const convBChild = historyDb.save(historyDb.create({ sessionId: 'sess-main-b2', parentId: convB }), [{ role: 'user', text: '话题 B 续接段', receipt: null }]).id
  assert.equal(historyDb.topicOf(convA), convA)
  assert.equal(historyDb.topicOf(convB), convB)
  assert.equal(historyDb.topicOf(convBChild), convB)

  let activeConvId = convA
  const taskSid = randomUUID()
  const taskStore = createTaskStore({ db: appDb.db })
  const persistedSessions = new Map<string, Session>()
  const taskSession = Session.create(SessionId(taskSid), [], { version: 4, id: SessionId(taskSid), createdAt: nowMs, cwd: dir, isSeeded: false })
  persistedSessions.set(taskSid, taskSession)

  let turnCounter = 0
  const dispatchedMeta: Array<{ kind: string, text: string, meta?: TaskDispatchMeta }> = []
  const steerPort = makeFakePort()
  const steeredMessages: UserMessage[] = []
  const steerChannel = createSteerChannel(steerPort, (_sid, text, source) => {
    steeredMessages.push(createUserMessage({ content: [{ type: 'text', text }], source: (source ?? { kind: 'user' }) as UserMessage['source'] }))
    return null
  }, () => {})
  defer(() => steerChannel.close())

  const appendPromptedTurnStart = (text: string, meta?: TaskDispatchMeta) => {
    turnCounter++
    const wrapped = withTaskRequestSource(text, randomUUID())
    const wire = withProvenanceHeader(wrapped.text, {
      origin: meta?.origin === 'human' ? 'human' : 'router',
      sourceKind: meta?.origin === 'human' ? 'task-human-steer' : 'task-brief',
      sessionKind: 'task',
      ...(meta?.conversationId ? { conversationId: meta.conversationId } : {}),
      ...(meta?.threadId ? { threadId: meta.threadId } : {}),
      ...(meta?.hostDay ? { hostDay: meta.hostDay } : {}),
      ...(meta?.origin === 'human' && meta.sourceId ? { sourceId: meta.sourceId } : {}),
      humanSpans: wrapped.spans,
    })
    taskSession.append('turn/start', { turn: turnCounter })
    taskSession.append('user/message', liftProvenance(createUserMessage({ content: [{ type: 'text', text: wire }], source: { kind: 'user' } })), { surfaceOp: 'append' })
  }

  const finishCurrentTaskTurn = (conclusionText: string, stopReason = 'end_turn') => {
    taskSession.append('assistant/message', { message: { id: `asst-${turnCounter}`, role: 'assistant', content: [{ type: 'text', text: conclusionText }] }, interrupted: false } as never, { surfaceOp: 'append' })
    taskSession.append('turn/end', { turn: turnCounter, reason: { kind: 'completed' } })
    taskRuntime.dsh.receive({ type: 'task_message', taskId: taskSid, text: conclusionText })
    taskRuntime.dsh.receive({ type: 'task_end', taskId: taskSid, stopReason })
  }

  const makeRuntime = () => createTaskRuntime({
    db: historyDb,
    store: taskStore,
    now: () => nowMs,
    timezone: () => 'UTC',
    current: () => historyDb.get(activeConvId)!.conversation,
    agentInfo: () => ({ mode: 'ready', model: 'mock' }),
    agent: {
      startTask: async () => ({ ok: true, taskId: taskSid }),
      promptTask: (_id, text, meta) => {
        dispatchedMeta.push({ kind: 'prompt', text, meta })
        appendPromptedTurnStart(text, meta)
      },
      resumeTask: async () => ({ ok: true }),
      steerTask: (id, text, meta) => new Promise(resolve => {
        dispatchedMeta.push({ kind: 'steer', text, meta })
        const reqId = randomUUID()
        const wrapped = withTaskRequestSource(text, randomUUID())
        const source = meta?.origin === 'human'
          ? {
              kind: 'viva-task-human-steer' as const,
              ...(meta.sourceId ? { sourceId: meta.sourceId } : {}),
              ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
              ...(meta.threadId ? { threadId: meta.threadId } : {}),
              ...(meta.hostDay ? { hostDay: meta.hostDay } : {}),
              humanSpans: wrapped.payloadSpans,
            }
          : {
              kind: 'viva-task-router-message' as const,
              ...(meta?.conversationId ? { conversationId: meta.conversationId } : {}),
              ...(meta?.threadId ? { threadId: meta.threadId } : {}),
              ...(meta?.hostDay ? { hostDay: meta.hostDay } : {}),
            }
        const prevLen = steeredMessages.length
        steerPort.emit('message', { type: 'steer', id: reqId, sessionId: id, text: wrapped.text, source })
        if (steeredMessages.length > prevLen) {
          taskSession.append('user/message', liftProvenance(steeredMessages.at(-1)!), { surfaceOp: 'append' })
        }
        resolve({ ok: true })
      }),
      cancelTask: async () => {},
      closeTask: async () => {},
    },
  })
  let taskRuntime = makeRuntime()
  defer(() => taskRuntime.dispose())

  // 1. Start task T in Topic A (`activeConvId = convA`) and finish Turn 1.
  activeConvId = convA
  await taskRuntime.agent.start('审计密钥策略', '检查话题 A 的密钥轮换配置')
  assert.equal(dispatchedMeta.at(-1)?.meta?.threadId, convA)
  assert.equal(dispatchedMeta.at(-1)?.meta?.hostDay, expectedHostDay)
  finishCurrentTaskTurn('话题 A 专属结论：密钥轮换周期为 30 天')

  // 2. Switch active UI screen to Topic B! Perform drawer `window.message` + relaunch `window.resume`.
  //    MUST stay bound to Topic A (`convA`), NEVER hijacked to Topic B (`convB`), and `window.resume` keeps `origin: 'router'`.
  activeConvId = convB
  const drawerAsk = await taskRuntime.window.message(taskSid, '抽屉在话题 B 屏幕下追问原任务')
  assert.equal(drawerAsk.delivered, 'next question')
  assert.equal(dispatchedMeta.at(-1)?.meta?.origin, 'human')
  assert.equal(dispatchedMeta.at(-1)?.meta?.threadId, convA, 'drawer window.message while viewing Topic B must stay on Topic A')

  const midDrawer = await taskRuntime.window.message(taskSid, '抽屉运行中追加一句')
  assert.equal(midDrawer.delivered, 'into its turn')
  assert.equal(dispatchedMeta.at(-1)?.meta?.threadId, convA)

  // Close Turn 2 in DSH log BEFORE relaunching TaskRuntime so task is in 'interrupted' (unended, detached) state!
  taskSession.append('assistant/message', { message: { id: 'asst-2', role: 'assistant', content: [{ type: 'text', text: '话题 A 中断前进展' }] }, interrupted: true } as never, { surfaceOp: 'append' })
  taskSession.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } })
  taskRuntime.dispose()
  taskRuntime = makeRuntime()

  assert.deepEqual(await taskRuntime.window.resume(taskSid), { ok: true })
  assert.equal(dispatchedMeta.at(-1)?.meta?.origin, 'router', 'window.resume default prompt must stay router origin, never human')
  assert.equal(dispatchedMeta.at(-1)?.meta?.threadId, convA, 'window.resume while viewing Topic B must stay on Topic A')
  await taskRuntime.window.message(taskSid, '话题 A 已完成轮人工补充偏好')
  finishCurrentTaskTurn('话题 A 恢复完成结论')

  // 3. Now Topic B's main router (`activeConvId = convB`) reuses ended task T via `agent.message(...)`!
  activeConvId = convB
  const routedB = await taskRuntime.agent.message(taskSid, '按话题 B 重新扫描网关配置')
  assert.equal(routedB.delivered, 'next question')
  assert.equal(dispatchedMeta.at(-1)?.meta?.origin, 'router')
  assert.equal(dispatchedMeta.at(-1)?.meta?.threadId, convB, 'router follow-up from Topic B must rebind ended task to Topic B')
  assert.equal(taskStore.list()[0]?.next, convB, 'restarted task.next must update atomically to caller conversation')

  // 4. While Turn 4 is actively running for Topic B:
  //    - Same-topic router steer from `convBChild` (same topic `convB`) SUCCEEDS without mutating `taskStore.next` prematurely!
  activeConvId = convBChild
  const sameTopicSteer = await taskRuntime.agent.message(taskSid, '同话题子段补充扫描端口')
  assert.equal(sameTopicSteer.delivered, 'into its turn')
  assert.equal(dispatchedMeta.at(-1)?.meta?.threadId, convB)
  assert.equal(taskStore.list()[0]?.next, convB, 'mid-turn steer must not prematurely overwrite kept.next')

  //    - Cross-topic router steer from Topic A (`activeConvId = convA`) MUST BE REFUSED without calling steerTask!
  activeConvId = convA
  const steersBeforeRefusal = dispatchedMeta.length
  await assert.rejects(
    () => taskRuntime.agent.message(taskSid, '话题 A 试图半路抢绑正在跑的话题 B 任务'),
    /另一个话题|another topic/u,
    'cross-topic mid-turn router steer must be refused to preserve single-topic turn boundary',
  )
  assert.equal(dispatchedMeta.length, steersBeforeRefusal, 'refused cross-topic router steer must never reach steerTask')

  finishCurrentTaskTurn('话题 B 专属结论：网关端口收敛完毕')

  // 5. Ingest all 4 turns through real createSessionIngestion + openMemoryOwner and verify topic-card & previousAssistant isolation!
  const persistence = {
    async open(id: SessionId) {
      const s = persistedSessions.get(String(id))
      if (!s) throw notFoundError()
      return {
        inheritedEventCount: s.inheritedEventCount,
        async read(from: number, limit: number) { return { events: s.snapshotEvents().slice(from, from + limit) } },
        async close() {},
      }
    },
    async list() { return [...persistedSessions.values()].map(s => ({ header: s.header, revision: 1 })) },
  } as unknown as Parameters<typeof createSessionIngestion>[2]

  const memRoot = path.join(dir, 'memory')
  const noteInputs: CapturedNoteInput[] = []
  const dreamCanonicalSeen: Array<Array<{ sourceId: string, text: string }>> = []
  const dreamProfileSeen: Array<Array<{ sourceId: string, text: string }>> = []
  let tryCrossCardSourceHijack = false
  let verifyJointBatchIsolation = false
  let ownerClock = nowMs - 10_000
  const owner = openMemoryOwner({
    root: memRoot,
    hostNamespace: 'viva',
    now: () => ownerClock,
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: ({ sessionId, fromSeq, toSeq, sessionKind }) =>
      readPersistedSessionRange(persistence as Parameters<typeof readPersistedSessionRange>[0], sessionId, fromSeq, toSeq, { host: true, initialSessionKind: sessionKind }),
    compute: (job, _signal, tools) => {
      if (job.stage === 'dream') {
        if (job.system === DREAM_PROFILE_SYSTEM) {
          const pInput = JSON.parse(job.input) as { canonicalSources: Array<{ sourceId: string, text: string }> }
          dreamProfileSeen.push(pInput.canonicalSources)
          if (verifyJointBatchIsolation) {
            const aSteer = pInput.canonicalSources.find(s => s.text.includes('话题 A 已完成轮人工补充偏好'))
            if (aSteer) {
              return Promise.resolve(JSON.stringify({
                action: 'CREATE',
                body: '- 持续关注任务审计进展。',
                sourceIds: [aSteer.sourceId],
              }))
            }
          }
          return Promise.resolve(JSON.stringify({ action: 'NOOP' }))
        }
        if (job.system === DREAM_CONSOLIDATE_SYSTEM) {
          const dInput = JSON.parse(job.input) as {
            notes: Array<{ title: string, path: string, sourceIds: string[] }>
            canonicalSources: Array<{ sourceId: string, text: string }>
          }
          dreamCanonicalSeen.push(dInput.canonicalSources)
          if (verifyJointBatchIsolation) {
            const bNote = dInput.notes.find(n => n.title === '话题 B 网关扫描')
            const bAnswer = dInput.canonicalSources.find(s => s.text === '全端口扫描')
            if (bNote && bAnswer) {
              return Promise.resolve(JSON.stringify({
                operations: [{
                  action: 'CREATE',
                  path: 'digest/wiki/topic-b-qa.md',
                  name: '话题 B 扫描范围',
                  description: '话题 B 问答结论',
                  body: '确定采用全端口扫描。',
                  dailyPaths: [bNote.path],
                  sourceIds: [bAnswer.sourceId],
                }],
              }))
            }
          }
          if (tryCrossCardSourceHijack) {
            const bNote = dInput.notes.find(n => n.title === '话题 B 网关扫描')
            const aSource = dInput.canonicalSources.find(s => s.text.includes('话题 A 已完成轮人工补充偏好'))
            if (bNote && aSource) {
              return Promise.resolve(JSON.stringify({
                operations: [{
                  action: 'CREATE',
                  path: 'digest/wiki/cross-card-hijack.md',
                  name: '伪造跨卡引用',
                  description: '伪造跨卡引用',
                  body: '试图在仅声明话题 B 日记时引用话题 A 来源',
                  dailyPaths: [bNote.path],
                  sourceIds: [aSource.sourceId],
                }],
              }))
            }
          }
          return Promise.resolve(JSON.stringify({ operations: [] }))
        }
        return null
      }
      if (job.stage !== 'note') return null
      const input = JSON.parse(job.input) as CapturedNoteInput
      noteInputs.push(input)
      const latest = input.turns.map(turn => turn.assistant || turn.user.map(u => u.text).join(' ')).join(' | ')
      return Promise.resolve(JSON.stringify({
        status: 'write',
        title: latest.includes('话题 B') ? '话题 B 网关扫描' : '话题 A 密钥审计',
        state: latest,
        events: [latest],
      }))
    },
  })
  defer(() => owner.close())
  await owner.recover()

  const ingest = createSessionIngestion(
    {
      epoch: owner.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => owner.intakeCursor(sid),
      advanceIntakeCursor: async input => owner.advanceIntakeCursor(input),
      beginTurn: async input => owner.beginTurn(input),
      stageOpenTurnSources: async input => owner.stageOpenTurnSources(input),
      settleTurn: async input => owner.settleTurn(input),
    },
    { flush: async () => true, get: id => persistedSessions.get(String(id)), list: () => [...persistedSessions.values()] },
    persistence,
    { host: true },
  )
  await ingest.synchronize(taskSession)
  await owner.runtime.wake()

  // Turn 1 (Topic A completed), Turn 2 (interrupted -> gated out of daily ranges), Turn 3 (Topic A completed), Turn 4 (Topic B completed):
  await eventually(() => noteInputs.length === 3)
  const turn3Input = noteInputs.find(inp => inp.turns[0]?.assistant === '话题 A 恢复完成结论')
  const turn4Input = noteInputs.find(inp => inp.turns[0]?.assistant === '话题 B 专属结论：网关端口收敛完毕')
  assert.ok(turn3Input && turn4Input)
  assert.equal(turn3Input.turns[0]!.previousAssistant, '话题 A 专属结论：密钥轮换周期为 30 天', 'same-topic Turn 3 receives Topic A previousAssistant')
  assert.equal(turn4Input.turns[0]!.previousAssistant, null, 'rebound Topic B Turn 4 MUST NOT leak Topic A previousAssistant')
  assert.equal(JSON.stringify(turn4Input).includes('密钥轮换周期为 30 天'), false)

  const memDb = new DatabaseSync(path.join(memRoot, 'memory.db'), { readOnly: true })
  defer(() => memDb.close())
  const cards = memDb.prepare("SELECT key, json_extract(key, '$[1]') AS topic FROM memory_daily_notes ORDER BY key").all() as Array<{ key: string, topic: string }>
  assert.equal(cards.length, 2, 'Topic A and Topic B must produce two distinct daily topic cards')
  assert.deepEqual(new Set(cards.map(c => c.topic)), new Set([convA, convB]))

  // Verify Codex Fix #1: Disable Topic A's card and run Dream on Topic B's card ->
  // Topic A's verbatim sources MUST NOT appear in Topic B's Dream `canonicalSources`!
  const listedCards = await owner.handleHost('listFiles', { args: [{ kind: 'daily' }] }) as {
    items: Array<{ identity: { kind: 'daily', workspace: string, id: string }, title: string, version: unknown }>
  }
  const topicACard = listedCards.items.find(item => item.title === '话题 A 密钥审计')!
  const topicBCard = listedCards.items.find(item => item.title === '话题 B 网关扫描')!
  assert.ok(topicACard && topicBCard)
  const topicBDetail = await owner.handleHost('readFile', { args: [topicBCard.identity] }) as { sources: Array<{ conversationId?: string | null }> } | null
  assert.ok(topicBDetail)
  assert.equal(
    topicBDetail.sources.some(src => src.conversationId === convA || src.conversationId && historyDb.topicOf(src.conversationId) === convA),
    false,
    'Topic B card detail.sources must NOT expose Topic A dependencyOnly revocation sources',
  )

  // Both A and B enabled in same batch: an operation claiming dailyPaths=[B] citing A's source MUST be rejected!
  tryCrossCardSourceHijack = true
  await owner.runtime.runDocumentDream()
  assert.equal(memDb.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 0, 'Dream must reject cross-card source citation via dependencyOnly ref')
  tryCrossCardSourceHijack = false

  // Settle a Topic B question-answer on the reused `taskSid` (whose `contextSources` includes Topic A's steer!),
  // then run a joint A+B Dream batch to verify R3 P1 & P2:
  // - `digest/wiki/topic-b-qa.md` expanding `questionContexts` keeps Topic A's steer `dependencyOnly: true` (never public in `detail.sources`)!
  // - `user-profile.md` selecting ONLY Topic A's steer links ONLY Topic A's daily path in `## Sources`, NOT Topic B's daily path!
  const bQaCallHash = 'c'.repeat(64)
  const bQaDigest = (await import('../src/memory/node/question-answer-memory.ts')).canonicalEligibleAnswersDigest([
    { id: 'q-scope', question: '话题 B 扫描范围？', custom: '全端口扫描' },
  ])
  const curAfter4 = owner.intakeCursor(taskSid)!
  const t5Start = taskSession.snapshotEvents().length
  taskSession.append('turn/start', { turn: 5 })
  taskSession.append('assistant/message', { message: { id: 'asst-5', role: 'assistant', content: [{ type: 'text', text: '话题 B 补充扫描完成' }] }, interrupted: false } as never, { surfaceOp: 'append' })
  taskSession.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
  const t5End = taskSession.snapshotEvents().length
  owner.beginTurn({ sessionId: taskSid, turn: 5, sessionKind: 'task', conversation: convB, cwd: dir })
  owner.recordQuestionReceipt({
    sessionId: taskSid, turn: 5, callSeq: t5Start + 1, callIdHash: bQaCallHash, conversationId: convB,
    answeredAt: nowMs + 20, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: bQaDigest,
  })
  await owner.settleTurn({
    sessionId: taskSid, cwd: dir, sessionKind: 'task', conversation: convB, thread: convB,
    inheritedSeq: 0, expectedNextSeq: curAfter4.nextSeq, fromSeq: t5Start, toSeq: t5End, turn: 5, reasonKind: 'completed',
    sources: [],
    questionAnswers: [{
      callSeq: t5Start + 1, callIdHash: bQaCallHash, requestId: `${t5Start + 1}:${bQaCallHash}`, questionAt: nowMs + 15,
      answerBatchDigest: bQaDigest, timezone: 'UTC',
      items: [{ sourceId: questionAnswerSourceId(taskSid, t5Start + 1, 'call-b-qa', 'q-scope'), questionId: 'q-scope', question: '话题 B 扫描范围？', text: '全端口扫描' }],
    }],
    assistantText: '话题 B 补充扫描完成', at: nowMs + 25, timezone: 'UTC', flushNotes: true,
  })
  await owner.runtime.wake()

  ownerClock = nowMs + 5_000
  verifyJointBatchIsolation = true
  await owner.runtime.runDocumentDream()
  verifyJointBatchIsolation = false

  const bPathRow = memDb.prepare("SELECT path FROM memory_daily_notes WHERE json_extract(key, '$[1]')=?").get(convB) as { path: string }
  const aPathRow = memDb.prepare("SELECT path FROM memory_daily_notes WHERE json_extract(key, '$[1]')=?").get(convA) as { path: string }
  const listedDigests = await owner.handleHost('listFiles', { args: [{ kind: 'digest' }] }) as {
    items: Array<{ identity: { kind: 'digest', workspace: string, id: string }, path?: string, title: string }>
  }
  const bWikiItem = listedDigests.items.find(item => item.title === '话题 B 扫描范围')!
  assert.ok(bWikiItem, 'joint batch must commit Topic B wiki digest')
  const bWikiDetail = await owner.handleHost('readFile', { args: [bWikiItem.identity] }) as { sources: Array<{ conversationId?: string | null }> } | null
  assert.ok(bWikiDetail)
  assert.equal(
    bWikiDetail.sources.some(src => src.conversationId === convA || src.conversationId && historyDb.topicOf(src.conversationId) === convA),
    false,
    'Topic B wiki digest expanding questionContexts MUST keep Topic A dependencyOnly hidden from public sources',
  )
  const profileRow = memDb.prepare("SELECT workspace, path FROM memory_documents WHERE path='digest/personal/profile.md' AND forgotten=0").get() as { workspace: string, path: string } | undefined
  assert.ok(profileRow, 'joint batch must commit digest/personal/profile.md')
  const profileBody = readFileSync(path.join(memRoot, 'memory-files', profileRow.workspace, profileRow.path), 'utf8')
  assert.equal(profileBody.includes(`[[${aPathRow.path}]]`), true, 'user-profile.md must link Topic A daily note that contributed the selected source')
  assert.equal(profileBody.includes(`[[${bPathRow.path}]]`), false, 'user-profile.md must NOT link Topic B daily note that only held dependencyOnly ref')

  const refreshedCards = await owner.handleHost('listFiles', { args: [{ kind: 'daily' }] }) as {
    items: Array<{ identity: { kind: 'daily', workspace: string, id: string }, title: string, version: unknown }>
  }
  const refreshedTopicA = refreshedCards.items.find(item => item.title === '话题 A 密钥审计')!
  await owner.handleHost('setFileEnabled', {
    args: [{ operationId: randomUUID(), identity: refreshedTopicA.identity, version: refreshedTopicA.version, enabled: false }],
  })
  // Bump Topic B so Dream scans ONLY Topic B's card and check BOTH consolidate & profile inputs!
  const topicBFollowupSid = 'sess-main-b-followup'
  const topicBFollowupSession = Session.create(SessionId(topicBFollowupSid), [], { version: 4, id: SessionId(topicBFollowupSid), createdAt: nowMs, cwd: dir, isSeeded: false })
  topicBFollowupSession.append('turn/start', { turn: 1 })
  topicBFollowupSession.append('user/message', createUserMessage({ content: [{ type: 'text', text: '话题 B 用户补充确认' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  topicBFollowupSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  persistedSessions.set(topicBFollowupSid, topicBFollowupSession)
  await owner.settleTurn({
    sessionId: topicBFollowupSid,
    cwd: dir,
    sessionKind: 'main',
    conversation: convB,
    thread: convB,
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 3,
    turn: 1,
    reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '话题 B 用户补充确认', at: nowMs + 50, timezone: 'UTC' }],
    assistantText: '',
    at: nowMs + 50,
    timezone: 'UTC',
  })
  await owner.runtime.wake()
  dreamCanonicalSeen.length = 0
  dreamProfileSeen.length = 0
  await owner.runtime.runDocumentDream()
  assert.equal(dreamCanonicalSeen.length, 1, 'Dream must consolidate enabled Topic B card')
  const topicBDreamTexts = dreamCanonicalSeen[0]!.map(s => s.text).join('\n')
  assert.equal(topicBDreamTexts.includes('密钥轮换'), false, 'Topic A sources must NEVER leak into Topic B Dream canonicalSources')
  assert.equal(topicBDreamTexts.includes('追问原任务'), false, 'Topic A human steer must NEVER leak into Topic B Dream canonicalSources')
  assert.equal(topicBDreamTexts.includes('话题 A 已完成轮人工补充偏好'), false, 'Topic A completed steer must NEVER leak into Topic B Dream canonicalSources')
  assert.equal(topicBDreamTexts.includes('重新扫描网关配置'), true, 'Topic B own sources must be present in Topic B Dream canonicalSources')
  const topicBProfileTexts = dreamProfileSeen.flat().map(s => s.text).join('\n')
  assert.equal(topicBProfileTexts.includes('追问原任务'), false, 'Topic A human steer must NEVER leak into Topic B Dream profile pass')
  assert.equal(topicBProfileTexts.includes('话题 A 已完成轮人工补充偏好'), false, 'Topic A completed steer must NEVER leak into Topic B Dream profile pass')
  assert.equal(topicBProfileTexts.includes('话题 B 用户补充确认'), true, 'Topic B own pure user source must enter Dream profile pass')

  // Verify Codex Fix #3 & #4: Legacy StoredTask without `next` refuses cross-topic mid-turn router steer,
  // AND default createTaskRuntime timezone matches DAILY_MEMORY_DEFAULTS.timezone ('Asia/Shanghai')!
  const legacyStore = createTaskStore({ db: appDb.db })
  const legacySeg = historyDb.save(historyDb.create({ sessionId: 'legacy-s' }), [{ role: 'user', text: '旧任务', receipt: null }]).id
  const legacyTaskId = randomUUID()
  legacyStore.add({ id: legacyTaskId, segmentId: legacySeg, keep: 0, title: '旧任务', words: '旧任务', startedAt: nowMs })
  let legacyPromptMeta: TaskDispatchMeta | undefined
  const utcEvening18 = Date.parse('2026-11-27T18:00:00Z') // 2026-11-28 02:00 in Asia/Shanghai!
  const legacyRuntime = createTaskRuntime({
    db: historyDb,
    store: legacyStore,
    now: () => utcEvening18,
    current: () => historyDb.get(convB)!.conversation,
    agentInfo: () => ({ mode: 'ready', model: 'mock' }),
    agent: {
      startTask: async () => ({ ok: true, taskId: randomUUID() }),
      promptTask: (_id, _text, meta) => { legacyPromptMeta = meta },
      resumeTask: async () => ({ ok: true }),
      steerTask: async () => ({ ok: true }),
      cancelTask: async () => {},
      closeTask: async () => {},
    },
  })
  defer(() => legacyRuntime.dispose())
  assert.deepEqual(await legacyRuntime.window.resume(legacyTaskId), { ok: true })
  assert.equal(legacyPromptMeta?.hostDay, todayAt(utcEvening18, DAILY_MEMORY_DEFAULTS.timezone), 'default task-runtime timezone must match DAILY_MEMORY_DEFAULTS.timezone')
  await assert.rejects(
    () => legacyRuntime.agent.message(legacyTaskId, '跨话题抢绑无 next 的旧任务'),
    /另一个话题|another topic/u,
    'legacy running task without next must also refuse cross-topic router steer',
  )
})

test('§5.3 pure option selection & agent-answer real host + owner-worker subprocess pipeline with fault injections', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'thread-notes-selections-')
  const nowMs = Date.now()

  // ② Unit + Contextual Split-Credential Block on Option Selection ("验证码？" + option "123456"):
  assert.deepEqual(
    eligibleQuestionSelections(
      [{ id: 'otp-q', question: '请输入验证码？', header: '安全校验', options: [{ label: '123456' }, { label: '跳过' }] }],
      [{ id: 'otp-q', selected: ['123456'] }],
    ),
    [],
    'split credential ("验证码？" + option "123456") must be rejected by eligibleQuestionSelections',
  )
  assert.deepEqual(
    eligibleQuestionSelections(
      [{ id: 'fmt-q', question: '导出格式？', options: [{ label: 'PDF' }, { label: 'Markdown' }], multiSelect: true }],
      [{ id: 'fmt-q', selected: ['Markdown', 'PDF'] }],
    ),
    [{ id: 'fmt-q', question: '导出格式？', selected: ['PDF', 'Markdown'] }],
    'multiSelect options must normalize to original card options[] definition order',
  )

  // Real owner-worker subprocess via createMemoryOwnerSupervisor!
  const memRoot = path.join(dir, 'worker-mem')
  const persisted = new Map<string, Session>()
  const deletedSessions = new Set<string>()
  const flakySessions = new Set<string>()

  const persistence = {
    async open(id: SessionId) {
      const sid = String(id)
      if (deletedSessions.has(sid)) throw notFoundError(`deleted ${sid}`)
      if (flakySessions.has(sid)) throw new Error(`EIO flaky ${sid}`)
      const s = persisted.get(sid)
      if (!s) throw notFoundError(`missing ${sid}`)
      return {
        inheritedEventCount: s.inheritedEventCount,
        async read(from: number, limit: number) { return { events: s.snapshotEvents().slice(from, from + limit) } },
        async close() {},
      }
    },
    async list() {
      return [...persisted.values()]
        .filter(s => !deletedSessions.has(String(s.id)))
        .map(s => ({ header: s.header, revision: 1 }))
    },
  } as unknown as Parameters<typeof createSessionIngestion>[2]

  const workerNoteInputs: CapturedNoteInput[] = []
  const supervisor = createMemoryOwnerSupervisor({
    root: memRoot,
    hostNamespace: 'viva',
    dailyNotes: true,
    callbacks: {
      readSessionRange: ({ sessionId, fromSeq, toSeq, sessionKind }) =>
        readPersistedSessionRange(persistence as Parameters<typeof readPersistedSessionRange>[0], sessionId, fromSeq, toSeq, { host: true, initialSessionKind: sessionKind }),
      async compute({ job }) {
        if (job.stage !== 'note') return JSON.stringify({ operations: [] })
        const input = JSON.parse(job.input) as CapturedNoteInput
        workerNoteInputs.push(input)
        const summary = input.turns
          .flatMap(turn => turn.user.map(u => `${u.author}:${u.question ? `[${u.question}]` : ''}${u.text}`))
          .join('；')
        return JSON.stringify({
          status: 'write',
          title: '点选与混合问答卡片',
          state: summary,
          events: [summary],
        })
      },
    },
  })
  defer(() => supervisor.close())
  await supervisor.start()
  await supervisor.callAdapter('setRoute', [{ provider: 'mock', model: 'mock' }])

  // Wire real DSH viva-questions plugin <-> host createQuestionDesk IPC!
  const ctx = new Context()
  defer(() => ctx.fiber.dispose())
  const toPlugin = new EventEmitter()
  const fromPlugin = new EventEmitter()
  const pluginPort = Object.assign(toPlugin, {
    send(msg: unknown) {
      fromPlugin.emit('message', msg)
      return true
    },
  }) as unknown as NodeJS.Process

  const openTurnBySession = new Map<string, { openTurnStartSeq: number, lastTurn: number }>()
  ctx.provide('agents', {
    turnBoundaryOf: (sid: SessionId) => openTurnBySession.get(String(sid)) ?? { openTurnStartSeq: 0, lastTurn: 1 },
  } as never)
  const emittedReceipts: HumanQuestionReceipt[] = []
  ctx.on('viva-memory/read-profile-deletion-gen', probe => { probe.value = 0 })
  ctx.on('viva-questions/human-answer-receipt', receipt => { emittedReceipts.push(receipt) })
  applyQuestionsPlugin(ctx, {}, pluginPort)

  let activeScreenSession = 'sess-img-pure'
  const taskSessions = new Set<string>(['sess-task-ans'])
  const currentConvBySession = new Map<string, string>()
  const desk = createQuestionDesk({
    send: msg => { toPlugin.emit('message', msg) },
    emit: () => {},
    sessionId: () => activeScreenSession,
    taskOf: sid => taskSessions.has(sid) ? sid : null,
    profileDeletionGen: () => 0,
    onAnswer: (entry, answers, _op, meta) => {
      if (!entry.memoryEligible || !entry.callId || entry.callSeq === undefined) return
      const rawCards = meta?.rawCards ?? entry.question.questions
      const customEligible = eligibleQuestionAnswers(rawCards, answers)
      const selectionEligible = eligibleQuestionSelections(rawCards, answers)
      if (!customEligible.length && !selectionEligible.length) return
      const conversationId = currentConvBySession.get(entry.sessionId)
      if (!conversationId) return
      const sourceIds: Record<string, string> = {}
      for (const item of customEligible) {
        sourceIds[item.id] = questionAnswerSourceId(entry.sessionId, entry.callSeq, entry.callId, item.id)
      }
      return {
        conversationId,
        sourceIds,
        recordReceipt: true,
      }
    },
  })
  fromPlugin.on('message', msg => { void desk.receive(msg) })

  const ingestion = createSessionIngestion(
    {
      get epoch() { return supervisor.epoch() },
      inEpoch: (_e, fn) => fn(),
      intakeCursor: sid => supervisor.callAdapter('intakeCursor', [sid]) as never,
      advanceIntakeCursor: input => supervisor.callAdapter('advanceIntakeCursor', [input]) as never,
      beginTurn: input => supervisor.callAdapter('beginTurn', [input]).then(() => {}),
      recordQuestionReceipt: input => supervisor.callAdapter('recordQuestionReceipt', [input]).then(() => {}),
      retireSessionQuestionReceipts: sid => supervisor.callAdapter('retireSessionQuestionReceipts', [sid]).then(() => {}),
      pruneExpiredQuestionReceipts: (maxAge, ex) => supervisor.callAdapter('pruneExpiredQuestionReceipts', [maxAge, ex]).then(() => {}),
      stageOpenTurnSources: input => supervisor.callAdapter('stageOpenTurnSources', [input]) as never,
      settleTurn: input => supervisor.callAdapter('settleTurn', [{ ...input, flushNotes: true }]) as never,
    },
    { flush: async () => true, get: id => persisted.get(String(id)), list: () => [...persisted.values()] },
    persistence,
    { host: true },
  )

  const makeSession = (sid: string) => {
    const s = Session.create(SessionId(sid), [], { version: 4, id: SessionId(sid), createdAt: nowMs, cwd: dir, isSeeded: false })
    persisted.set(sid, s)
    return s
  }

  const runLiveQuestionCall = async (
    s: Session,
    callId: string,
    cards: Array<{ id: string, question: string, header?: string, options?: Array<{ label: string }>, multiSelect?: boolean }>,
    submit: (questionId: string) => Promise<void>,
    mutateReturnedAnswers?: (res: { answers: Array<{ id: string, selected: string[], custom?: string }> }) => { answers: Array<{ id: string, selected: string[], custom?: string }> },
  ) => {
    const startEv = s.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(callId), name: 'ask_user_question', arguments: JSON.stringify({ questions: cards }) })
    ctx.emit('session/event', s, startEv as never)
    let pendingQId: string | undefined
    const captureListener = (msg: { type?: string, id?: string }) => {
      if (msg?.type === 'question' && typeof msg.id === 'string') pendingQId = msg.id
    }
    fromPlugin.on('message', captureListener)
    let result: { answers: Array<{ id: string, selected: string[], custom?: string }> }
    try {
      result = await ctx.waterfall(
        'tools/execute',
        { name: 'ask_user_question', callId, agent: { session: s } } as never,
        async () => {
          const askP = ctx.waterfall(
            'user-questions/request',
            { questions: cards, agent: { session: s } } as never,
            () => Promise.reject(new Error('unreachable')),
          )
          assert.ok(await eventually(() => Boolean(pendingQId)))
          await submit(pendingQId!)
          return await askP
        },
      ) as { answers: Array<{ id: string, selected: string[], custom?: string }> }
    } finally {
      fromPlugin.off('message', captureListener)
    }
    const persistedResult = mutateReturnedAnswers ? mutateReturnedAnswers(result) : result
    s.append('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(persistedResult) }] },
    } as never, { surfaceOp: 'append', sourceEventSeqs: [startEv.seq] })
    return startEv.seq
  }

  // ① Image-only main prompt + pure option click -> independent readable daily topic card, zero fake history sourceIds!
  const sidPure = 'sess-img-pure'
  const topicPure = 'topic-img-pure'
  activeScreenSession = sidPure
  currentConvBySession.set(sidPure, 'conv-img-pure')
  openTurnBySession.set(sidPure, { openTurnStartSeq: 0, lastTurn: 1 })
  const sPure = makeSession(sidPure)
  sPure.append('turn/start', { turn: 1 })
  const imgMsg = createUserMessage({
    content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }] as never,
    source: {
      kind: 'user',
      vivaProvenance: {
        v: 1,
        origin: 'human',
        sourceKind: 'main-human',
        sessionKind: 'main',
        conversationId: 'conv-img-pure',
        threadId: topicPure,
        sourceId: randomUUID(),
        humanSpans: [],
      },
    } as unknown as UserMessage['source'],
  })
  sPure.append('user/message', imgMsg, { surfaceOp: 'append' })

  let emittedHistorySourceIds: Readonly<Record<string, string>> | undefined = { sentinel: 'unset' }
  emittedReceipts.length = 0
  const pureCallSeq = await runLiveQuestionCall(
    sPure,
    'call-pure-1',
    [{ id: 'q-fmt', question: '架构图导出什么格式？', header: '导出', options: [{ label: 'SVG' }, { label: 'PNG' }] }],
    async qId => {
      emittedHistorySourceIds = undefined
      assert.equal(await desk.answer(qId, [{ id: 'q-fmt', selected: ['SVG'] }], undefined, { onSourceIds: ids => { emittedHistorySourceIds = ids } }), true)
    },
  )
  assert.equal(emittedHistorySourceIds, undefined, 'pure option selection must NOT emit fake user text sourceIds for history.db')
  assert.equal(emittedReceipts.length, 1, 'pure option selection must emit scalar human receipt')
  assert.ok(emittedReceipts[0]!.selectionBatchDigest, 'receipt must carry selectionBatchDigest')
  await supervisor.callAdapter('recordQuestionReceipt', [emittedReceipts[0]!])
  sPure.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ingestion.synchronize(sPure)

  const pureSelId = questionSelectionSourceId(sidPure, Number(pureCallSeq), 'call-pure-1', 'q-fmt')
  const listedPure = await eventually(async () => {
    const res = await supervisor.callHost('listFiles', { args: [{ kind: 'daily' }] }) as { items: Array<{ identity: { kind: 'daily', workspace: string, id: string }, title: string }> }
    return res.items.length > 0 ? res.items[0]! : null
  })
  assert.ok(listedPure, 'image-only turn + pure option click must independently generate a daily topic card')
  const pureDetail = await supervisor.callHost('readFile', { args: [listedPure.identity] }) as { markdown: string } | null
  assert.ok(pureDetail?.markdown.includes('selection:[架构图导出什么格式？]SVG'), JSON.stringify(pureDetail))

  // ④ Agent `answer_background_task` (`recordMemory: false`) with byte-for-byte identical JSON + task custom `profile_eligible = 0`:
  const sidTask = 'sess-task-ans'
  const topicTask = 'topic-task-ans'
  currentConvBySession.set(sidTask, 'seg-task-ans')
  openTurnBySession.set(sidTask, { openTurnStartSeq: 0, lastTurn: 1 })
  const sTask = makeSession(sidTask)
  const taskBriefWrapped = withTaskRequestSource('整理导出任务', randomUUID())
  sTask.append('turn/start', { turn: 1 })
  sTask.append('user/message', liftProvenance(createUserMessage({
    content: [{ type: 'text', text: withProvenanceHeader(taskBriefWrapped.text, { origin: 'router', sourceKind: 'task-brief', sessionKind: 'task', conversationId: 'seg-task-ans', threadId: topicTask, humanSpans: [] }) }],
    source: { kind: 'user' },
  })), { surfaceOp: 'append' })

  emittedReceipts.length = 0
  await runLiveQuestionCall(
    sTask,
    'call-agent-ans',
    [{ id: 'q-fmt', question: '架构图导出什么格式？', header: '导出', options: [{ label: 'SVG' }, { label: 'PNG' }] }],
    async qId => {
      assert.equal(await desk.answer(qId, [{ id: 'q-fmt', selected: ['SVG'] }], undefined, { recordMemory: false }), true)
    },
  )
  assert.equal(emittedReceipts.length, 0, 'answer_background_task (recordMemory: false) must emit ZERO human receipts')

  await runLiveQuestionCall(
    sTask,
    'call-human-task-custom',
    [{ id: 'q-dir', question: '输出目录名？', header: '目录', options: [{ label: 'dist' }] }],
    async qId => {
      assert.equal(await desk.answer(qId, [{ id: 'q-dir', selected: [], custom: '这次输出到 artifacts' }]), true)
    },
  )
  assert.equal(emittedReceipts.length, 1)
  await supervisor.callAdapter('recordQuestionReceipt', [emittedReceipts[0]!])
  sTask.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ingestion.synchronize(sTask)

  // ③ Mixed custom + selection independent digest verification (tamper selection only vs tamper custom only vs untampered both):
  const sidMixed = 'sess-mixed-verify'
  activeScreenSession = sidMixed
  currentConvBySession.set(sidMixed, 'conv-mixed')
  openTurnBySession.set(sidMixed, { openTurnStartSeq: 0, lastTurn: 1 })
  const sMixed = makeSession(sidMixed)
  sMixed.append('turn/start', { turn: 1 })
  const mixedPrompt = withRequestSource('混合回答校验', randomUUID(), '混合回答校验')
  sMixed.append('user/message', liftProvenance(createUserMessage({
    content: [{ type: 'text', text: withProvenanceHeader(mixedPrompt.text, { origin: 'human', sourceKind: 'main-human', sessionKind: 'main', conversationId: 'conv-mixed', threadId: 'topic-mixed', sourceId: randomUUID(), humanSpans: mixedPrompt.spans }) }],
    source: { kind: 'user' },
  })), { surfaceOp: 'append' })

  const mixedCards = [{ id: 'q-mix', question: '部署区域？', options: [{ label: '华东' }, { label: '华北' }] }]
  emittedReceipts.length = 0
  await runLiveQuestionCall(
    sMixed,
    'call-mix-tamper-sel',
    mixedCards,
    async qId => {
      assert.equal(await desk.answer(qId, [{ id: 'q-mix', selected: ['华东'], custom: '仅跑灰度' }]), true)
    },
    () => ({ answers: [{ id: 'q-mix', selected: ['华北'], custom: '仅跑灰度' }] }),
  )
  await runLiveQuestionCall(
    sMixed,
    'call-mix-tamper-cus',
    mixedCards,
    async qId => {
      assert.equal(await desk.answer(qId, [{ id: 'q-mix', selected: ['华东'], custom: '仅跑上海' }]), true)
    },
    () => ({ answers: [{ id: 'q-mix', selected: ['华东'], custom: '被篡改' }] }),
  )
  await runLiveQuestionCall(
    sMixed,
    'call-mix-both',
    mixedCards,
    async qId => {
      assert.equal(await desk.answer(qId, [{ id: 'q-mix', selected: ['华东'], custom: '双路完整保留' }]), true)
    },
  )
  await runLiveQuestionCall(
    sMixed,
    'call-lost-receipt',
    mixedCards,
    async qId => {
      assert.equal(await desk.answer(qId, [{ id: 'q-mix', selected: ['华北'] }]), true)
    },
  )
  assert.equal(emittedReceipts.length, 4)
  for (const r of emittedReceipts.slice(0, 3)) {
    await supervisor.callAdapter('recordQuestionReceipt', [r])
  }
  sMixed.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await ingestion.synchronize(sMixed)

  const workerDb = new DatabaseSync(path.join(memRoot, 'memory.db'), { readOnly: true })
  defer(() => workerDb.close())

  const pureRow = workerDb.prepare('SELECT author, source_kind, profile_eligible, text, question FROM memory_sources WHERE id=?').get(pureSelId) as {
    author: string, source_kind: string, profile_eligible: number, text: string, question: string
  }
  assert.equal(pureRow.author, 'selection')
  assert.equal(pureRow.source_kind, 'question-selection')
  assert.equal(pureRow.profile_eligible, 0)
  assert.equal(pureRow.text, 'SVG')
  assert.equal(pureRow.question, '架构图导出什么格式？')

  const agentAnsRows = workerDb.prepare("SELECT * FROM memory_sources WHERE session=? AND author IN ('selection','answer')").all(sidTask) as Array<{
    id: string, author: string, source_kind: string, profile_eligible: number, text: string
  }>
  assert.equal(agentAnsRows.length, 1, 'agent answer_background_task must produce ZERO selection/answer sources; only human task custom survives')
  assert.equal(agentAnsRows[0]!.source_kind, 'task-question-answer')
  assert.equal(agentAnsRows[0]!.profile_eligible, 0, 'task-question-answer must have profile_eligible = 0 (§3.2.3)')
  assert.equal(agentAnsRows[0]!.text, '这次输出到 artifacts')

  const mixedRows = workerDb.prepare("SELECT id, author, text FROM memory_sources WHERE session=? AND author IN ('selection','answer') ORDER BY author, text").all(sidMixed) as Array<{
    id: string, author: string, text: string
  }>
  assert.deepEqual(
    mixedRows.map(r => [r.author, r.text]),
    [
      ['answer', '仅跑灰度'],
      ['answer', '双路完整保留'],
      ['selection', '华东'],
      ['selection', '华东'],
    ],
  )
  assert.equal(new Set(mixedRows.map(r => r.id)).size, 4, 'custom and selection sourceIds must never collide')

  // ⑤b: Delete DSH session log for `sidPure` AFTER its daily topic card was written -> card remains readable via supervisor.callHost!
  deletedSessions.add(sidPure)
  const pureDetailAfterDelete = await supervisor.callHost('readFile', { args: [listedPure.identity] }) as { markdown: string } | null
  assert.ok(pureDetailAfterDelete?.markdown.includes('SVG'), 'committed daily topic card must remain readable after DSH session log deletion')

  // ⑤c: Shared topic card per-range fault isolation:
  const topicIso = 'topic-fault-iso'
  const sIsoMain = makeSession('iso-main')
  sIsoMain.append('turn/start', { turn: 1 })
  sIsoMain.append('user/message', createUserMessage({ content: [{ type: 'text', text: '健康主轮正常落卡' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  sIsoMain.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  makeSession('iso-deleted')
  makeSession('iso-flaky')
  deletedSessions.add('iso-deleted')
  flakySessions.add('iso-flaky')

  await supervisor.callAdapter('settleTurn', [{
    sessionId: 'iso-main', cwd: dir, sessionKind: 'main', conversation: 'c-iso', thread: topicIso,
    inheritedSeq: 0, expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '健康主轮正常落卡', at: nowMs + 300, timezone: 'UTC' }],
    assistantText: '', at: nowMs + 300, timezone: 'UTC', flushNotes: false,
  }])
  await supervisor.callAdapter('settleTurn', [{
    sessionId: 'iso-deleted', cwd: dir, sessionKind: 'task', conversation: 'c-iso-t1', thread: topicIso,
    inheritedSeq: 0, expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'agent', sourceKind: 'task-brief', profileEligible: false, text: '已删日志任务', at: nowMs + 310, timezone: 'UTC' }],
    assistantText: '', at: nowMs + 310, timezone: 'UTC', flushNotes: false,
  }])
  await supervisor.callAdapter('settleTurn', [{
    sessionId: 'iso-flaky', cwd: dir, sessionKind: 'task', conversation: 'c-iso-t2', thread: topicIso,
    inheritedSeq: 0, expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'agent', sourceKind: 'task-brief', profileEligible: false, text: '暂不可读任务', at: nowMs + 320, timezone: 'UTC' }],
    assistantText: '', at: nowMs + 320, timezone: 'UTC', flushNotes: true,
  }])

  assert.ok(await eventually(() => {
    const mStatus = workerDb.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get('iso-main') as { status?: string } | undefined
    const dStatus = workerDb.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get('iso-deleted') as { status?: string } | undefined
    return mStatus?.status === 'written' && dStatus?.status === 'skipped'
  }, { timeoutMs: 8_000 }), 'healthy earlier range must write and deleted range must retire even when trailing range is unavailable')
  assert.equal(
    (workerDb.prepare('SELECT status FROM memory_note_ranges WHERE session=?').get('iso-flaky') as { status?: string } | undefined)?.status,
    'pending',
    'trailing unavailable range must remain pending for retry',
  )
})

test('§5.4 L3 automaticRecall cross-session hit, 1-day cross-midnight + Dream late-write scan, Dream author guard, rewind occurrence ID, and provenance tolerance', async t => {
  const { dir, defer } = scratch(t, 'thread-notes-recall-dream-')

  // 1. Provenance optional-field fault tolerance (§3.1.2):
  const validPrefix = encodeProvenancePrefix({
    origin: 'human',
    sourceKind: 'main-human',
    sessionKind: 'main',
    conversationId: 'conv-ok',
    threadId: 'topic-ok',
    hostDay: '2026-11-26',
    humanSpans: [{ start: 0, end: 4 }],
  })
  const corruptedOptionalWire = validPrefix
    .replace('"t":"topic-ok"', '"t":"bad\\nspace id"')
    .replace('"hd":"2026-11-26"', '"hd":"2026-99-99"') + '正文内容'
  const parsedCorrupted = parseProvenanceHeader(corruptedOptionalWire)
  assert.ok(parsedCorrupted, 'malformed optional tid/hd must NOT cause parseProvenanceHeader to return null')
  assert.equal(parsedCorrupted.payload, '正文内容', 'transport header must still be cleanly stripped')
  assert.equal(parsedCorrupted.provenance.conversationId, 'conv-ok')
  assert.equal(parsedCorrupted.provenance.threadId, undefined)
  assert.equal(parsedCorrupted.provenance.hostDay, undefined)

  // 2. Main chat L3 `automaticRecall` (`op: 'context'`) hitting background progress (§4.2 & §5.4)
  //    + Unedited rewind occurrence ID (§3.3.2) + `canCommit` open-turn isolation (§3.3.4):
  let clock = Date.parse('2026-11-26T23:50:00Z')
  const root = path.join(dir, 'mem-recall')
  let dreamMode: 'noop' | 'try-illegal-personal' | 'try-illegal-procedure' | 'valid-wiki' = 'noop'
  const dreamConsolidateNotesSeen: string[][] = []

  const appDb = openAppDb({ file: path.join(dir, 'app-rewind.db') })
  defer(() => appDb.close())
  const historyDb = openHistoryDb({ db: appDb.db })
  defer(() => historyDb.close())

  const owner = openMemoryOwner({
    root,
    hostNamespace: 'viva',
    now: () => clock,
    dailyNotes: { noteInterval: 1, timezone: 'UTC', scanDays: 1 },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async () => ({ status: 'ok', assistant: '' }),
    compute: (job, _signal, tools) => {
      if (job.stage === 'note') {
        const input = JSON.parse(job.input) as CapturedNoteInput
        const texts = input.turns.flatMap(turn => turn.user.map(u => u.text)).join('；')
        return Promise.resolve(JSON.stringify({
          status: 'write',
          title: '支付网关改造进展',
          state: [input.existing?.state, texts].filter(Boolean).join('\n'),
          events: [texts],
        }))
      }
      if (job.stage === 'dream') {
        if (job.system === DREAM_PROFILE_SYSTEM) return Promise.resolve(JSON.stringify({ action: 'NOOP' }))
        if (job.system === DREAM_CONSOLIDATE_SYSTEM) {
          const dInput = JSON.parse(job.input) as { notes: Array<{ title: string, path: string, sourceIds: string[] }> }
          dreamConsolidateNotesSeen.push(dInput.notes.map(n => n.path))
          if (dreamMode === 'noop') return Promise.resolve(JSON.stringify({ operations: [] }))
          if (dreamMode === 'try-illegal-personal' || dreamMode === 'try-illegal-procedure') {
            return dreamModelStep(job, {
              bucket: dreamMode === 'try-illegal-personal' ? 'personal' : 'procedure',
              name: 'gateway-habit',
              summary: '由后台任务结论生成的非法偏好或流程',
              body: '由后台任务结论生成的非法偏好或流程',
            }, tools)
          }
          return dreamModelStep(job, {
            bucket: 'wiki',
            name: 'payment-gateway',
            summary: '支付网关改造进展',
            body: '已完成进展 2：沙箱联调通过。',
          }, tools)
        }
      }
      return null
    },
  })
  defer(() => owner.close())
  await owner.recover()

  const mainSid = 'sess-main-gw'
  const taskSid = 'sess-task-gw'
  const mainTurn1Src = randomUUID()
  const mainConv = historyDb.save(historyDb.create({ sessionId: mainSid }), [
    { role: 'user', text: '支付网关改造正在做 A，遇到卡点 1', sourceId: mainTurn1Src },
  ])
  const topicGateway = mainConv.id

  await owner.settleTurn({
    sessionId: mainSid,
    cwd: dir,
    sessionKind: 'main',
    conversation: mainConv.id,
    thread: topicGateway,
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 3,
    turn: 1,
    reasonKind: 'completed',
    sources: [{ sourceId: mainTurn1Src, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '支付网关改造正在做 A，遇到卡点 1', at: clock, timezone: 'UTC' }],
    assistantText: '',
    at: clock,
    timezone: 'UTC',
  })
  await owner.runtime.wake()

  const selfEchoBeforeTask = JSON.parse(await owner.runtime.handleModelRequest(
    { op: 'context', session: mainSid, turn: 2, question: '支付网关改造进展' },
    owner.sessionContext(mainSid),
    () => true,
  )) as { status: string, text?: string }
  assert.equal(JSON.stringify(selfEchoBeforeTask).includes('卡点 1'), false, 'single-session daily card must not self-echo into same main session before cross-session contribution')

  // Cross-midnight 1-day attachment (§3.3.3) WITHOUT any prior Dream run (`dream.lastCheckedAt` unset -> first-scan stateless check!):
  clock = Date.parse('2026-11-27T23:05:00Z')
  const taskConclusionSrc = randomUUID()
  await owner.settleTurn({
    sessionId: taskSid,
    cwd: dir,
    sessionKind: 'task',
    conversation: 'seg-gw-task',
    thread: topicGateway,
    hostDay: '2026-11-26',
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 4,
    turn: 1,
    reasonKind: 'completed',
    sources: [{ sourceId: taskConclusionSrc, author: 'assistant', sourceKind: 'task-assistant', profileEligible: false, text: '支付网关改造推进到进展 2：沙箱联调通过', at: clock, timezone: 'UTC' }],
    assistantText: '',
    at: clock,
    timezone: 'UTC',
    flushNotes: true,
  })
  await owner.runtime.wake()

  // `canCommit` isolation: open Turn 2 staged source is blocked in owner_open_turn_sources while settled Turn 1 remains committable!
  const openTurn2Src = randomUUID()
  owner.stageOpenTurnSources({
    sessionId: taskSid,
    turn: 2,
    sessionKind: 'task',
    conversation: 'seg-gw-task',
    cwd: dir,
    sources: [{ sourceId: openTurn2Src, author: 'user', sourceKind: 'task-human-steer', profileEligible: true, text: '未闭合第二轮插话', at: clock + 1000, timezone: 'UTC' }],
  })
  // Simulate a stale manual sidecar check if openTurn2Src wasn't explicitly staged for rememberSidecarFile:
  // Wait — rememberSidecarFile ALLOWS open-turn staged explicit user sources mid-turn via `allowOpenTurnSourceIds`,
  // whereas background Dream / Note commit (`canCommit`) MUST block `openTurn2Src` until Turn 2 closes!
  const dbCheckOpen = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  assert.ok(dbCheckOpen.prepare('SELECT 1 FROM owner_open_turn_sources WHERE session=? AND source_id=?').get(taskSid, openTurn2Src))
  dbCheckOpen.close()

  // Main session M asks related question -> L3 `automaticRecall` (`op: 'context'`) MUST hit "进展 2：沙箱联调通过"!
  const recallAfterTask = JSON.parse(await owner.runtime.handleModelRequest(
    { op: 'context', session: mainSid, turn: 2, question: '支付网关改造进展' },
    owner.sessionContext(mainSid),
    () => true,
  )) as { status: string }
  assert.equal(
    JSON.stringify(recallAfterTask).includes('进展 2：沙箱联调通过'),
    true,
    `main session L3 automaticRecall must hit shared topic card once background task contributed: ${JSON.stringify(recallAfterTask)}`,
  )

  const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  defer(() => db.close())
  const cardsAfter1Day = db.prepare('SELECT day, updated_at FROM memory_daily_notes ORDER BY day').all() as Array<{ day: string, updated_at: number }>
  assert.equal(cardsAfter1Day.length, 1, '1-day cross-midnight task must attach to existing 2026-11-26 topic card')
  assert.equal(cardsAfter1Day[0]!.day, '2026-11-26')
  assert.equal(cardsAfter1Day[0]!.updated_at, clock)

  // Advance clock to 2026-11-28 23:00 UTC (`scanDays = 1` -> day window is ONLY `'2026-11-28'`,
  // excluding `'2026-11-26'` by `day`, yet `updated_at >= cutoffMs(2026-11-27T00:00:00Z)` ensures 2026-11-26 card is scanned!).
  dreamConsolidateNotesSeen.length = 0
  clock = Date.parse('2026-11-28T23:00:00Z')
  dreamMode = 'try-illegal-personal'
  await owner.runtime.runDocumentDream()
  assert.ok(dreamConsolidateNotesSeen.length >= 1, 'Dream on D+2 with scanDays=1 must still scan D card updated on D+1 via updated_at >= cutoffMs')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 0, 'Dream author guard must reject digest/personal/* citing task-assistant evidence')

  dreamMode = 'try-illegal-procedure'
  await owner.runtime.runDocumentDream()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 0, 'Dream author guard must reject digest/procedure/* citing task-assistant evidence')

  // Verify R2 P1 fix: valid selection receipt (`selected: ['SVG']`) CANNOT endorse mismatched `item.text`!
  const forgeSid = 'sess-sel-forge'
  const forgeHash = 'b'.repeat(64)
  owner.beginTurn({ sessionId: forgeSid, turn: 1, sessionKind: 'main', conversation: 'conv-forge', cwd: dir })
  const validSelDigest = (await import('../src/memory/node/question-answer-memory.ts')).canonicalEligibleSelectionsDigest([
    { id: 'q-svg', question: '格式？', selected: ['SVG'] },
  ])
  owner.recordQuestionReceipt({
    sessionId: forgeSid, turn: 1, callSeq: 2, callIdHash: forgeHash, conversationId: 'conv-forge',
    answeredAt: clock + 30, questionProfileGen: 0, answerProfileGen: 0,
    answerBatchDigest: (await import('../src/memory/node/question-answer-memory.ts')).canonicalEligibleAnswersDigest([]),
    selectionBatchDigest: validSelDigest,
  })
  const forgedSelId = questionSelectionSourceId(forgeSid, 2, 'c-forge', 'q-svg')
  await owner.settleTurn({
    sessionId: forgeSid, cwd: dir, sessionKind: 'main', conversation: 'conv-forge', thread: 'topic-forge',
    inheritedSeq: 0, expectedNextSeq: null, fromSeq: 0, toSeq: 4, turn: 1, reasonKind: 'completed',
    sources: [],
    questionAnswers: [{
      callSeq: 2, callIdHash: forgeHash, requestId: `2:${forgeHash}`, questionAt: clock + 25,
      answerBatchDigest: (await import('../src/memory/node/question-answer-memory.ts')).canonicalEligibleAnswersDigest([]),
      selectionBatchDigest: validSelDigest,
      timezone: 'UTC',
      items: [],
      selectionItems: [{ sourceId: forgedSelId, questionId: 'q-svg', question: '格式？', selected: ['SVG'], text: '伪造的未签名点选正文' }],
    }],
    assistantText: '', at: clock + 40, timezone: 'UTC', flushNotes: false,
  })
  assert.equal(db.prepare('SELECT 1 FROM memory_sources WHERE id=?').get(forgedSelId), undefined, 'mismatched selection item.text must be rejected despite valid selected digest')

  // Verify Codex Fix #2: `task-question-answer` (`author='answer'`, `sourceKind='task-question-answer'`) ALONE
  // MUST ALSO be rejected by Dream's `isAllowedPersonalOrProcedureSource` on `digest/personal/*` & `digest/procedure/*`!
  const taskQaOnlySid = 'sess-task-qa-only'
  const taskQaCallHash = 'a'.repeat(64)
  const taskQaText = '这次临时导出用 CSV 格式'
  owner.beginTurn({ sessionId: taskQaOnlySid, turn: 1, sessionKind: 'task', conversation: 'seg-qa-only', cwd: dir })
  const taskQaDigest = (await import('../src/memory/node/question-answer-memory.ts')).canonicalEligibleAnswersDigest([
    { id: 'q-csv', question: '本次导出格式？', custom: taskQaText },
  ])
  owner.recordQuestionReceipt({
    sessionId: taskQaOnlySid, turn: 1, callSeq: 2, callIdHash: taskQaCallHash, conversationId: 'seg-qa-only',
    answeredAt: clock + 10, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: taskQaDigest,
  })
  await owner.settleTurn({
    sessionId: taskQaOnlySid, cwd: dir, sessionKind: 'task', conversation: 'seg-qa-only', thread: 'topic-task-qa-only',
    inheritedSeq: 0, expectedNextSeq: null, fromSeq: 0, toSeq: 4, turn: 1, reasonKind: 'completed',
    sources: [],
    questionAnswers: [{
      callSeq: 2, callIdHash: taskQaCallHash, requestId: `2:${taskQaCallHash}`, questionAt: clock + 5,
      answerBatchDigest: taskQaDigest, timezone: 'UTC',
      items: [{ sourceId: questionAnswerSourceId(taskQaOnlySid, 2, 'c-csv', 'q-csv'), questionId: 'q-csv', question: '本次导出格式？', text: taskQaText }],
    }],
    assistantText: '', at: clock + 20, timezone: 'UTC', flushNotes: true,
  })
  await owner.runtime.wake()
  dreamMode = 'try-illegal-personal'
  await owner.runtime.runDocumentDream()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 0, 'Dream author guard must reject digest/personal/* citing task-question-answer')
  dreamMode = 'try-illegal-procedure'
  await owner.runtime.runDocumentDream()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 0, 'Dream author guard must reject digest/procedure/* citing task-question-answer')

  await owner.settleTurn({
    sessionId: mainSid,
    cwd: dir,
    sessionKind: 'main',
    conversation: mainConv.id,
    thread: topicGateway,
    inheritedSeq: 0,
    expectedNextSeq: 3,
    fromSeq: 3,
    toSeq: 6,
    turn: 2,
    reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '确认支付网关沙箱联调归档', at: clock, timezone: 'UTC' }],
    assistantText: '',
    at: clock,
    timezone: 'UTC',
  })
  await owner.runtime.wake()
  dreamMode = 'valid-wiki'
  await owner.runtime.runDocumentDream()
  const wikiDocs = db.prepare('SELECT path FROM memory_documents').all() as Array<{ path: string }>
  assert.deepEqual(wikiDocs.map(d => d.path), ['digest/wiki/payment-gateway.md'], 'digest/wiki/* citing mixed human + task evidence must succeed')

  // 2-day cross-midnight (`hostDay = '2026-11-26'`, completion on `'2026-11-28'`) falls back to completionDay `'2026-11-28'`:
  await owner.settleTurn({
    sessionId: 'sess-task-2day',
    cwd: dir,
    sessionKind: 'task',
    conversation: 'seg-gw-2day',
    thread: topicGateway,
    hostDay: '2026-11-26',
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 3,
    turn: 1,
    reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'agent', sourceKind: 'task-brief', profileEligible: false, text: '跨两天的长任务不回挂旧日', at: clock, timezone: 'UTC' }],
    assistantText: '',
    at: clock,
    timezone: 'UTC',
    flushNotes: true,
  })
  await owner.runtime.wake()
  const daysAfter2Day = (db.prepare("SELECT day FROM memory_daily_notes WHERE json_extract(key, '$[1]')=? ORDER BY day").all(topicGateway) as Array<{ day: string }>).map(r => r.day)
  assert.deepEqual(daysAfter2Day, ['2026-11-26', '2026-11-28'], 'task finishing >=2 days after hostDay must write to completionDay, not hostDay')

  // 3. Unedited rewind replaying canonical `mainTurn1Src` in a forked session `sess-main-rewound` (§3.3.2):
  const rewoundConv = historyDb.save(historyDb.create({ sessionId: 'sess-main-rewound', parentId: mainConv.id }), []).id
  const rewindSettled = await owner.settleTurn({
    sessionId: 'sess-main-rewound',
    cwd: dir,
    sessionKind: 'main',
    conversation: rewoundConv,
    thread: topicGateway,
    inheritedSeq: 0,
    expectedNextSeq: null,
    fromSeq: 0,
    toSeq: 3,
    turn: 1,
    reasonKind: 'completed',
    sources: [{ sourceId: mainTurn1Src, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '支付网关改造正在做 A，遇到卡点 1', at: clock + 5000, timezone: 'UTC' }],
    assistantText: '',
    at: clock + 5000,
    timezone: 'UTC',
  })
  assert.deepEqual(rewindSettled, { status: 'ok', nextSeq: 3 }, 'unedited rewind replay in new session must settle cleanly without conflict')
  const origRow = db.prepare('SELECT session, conversation FROM memory_sources WHERE id=?').get(mainTurn1Src) as { session: string, conversation: string }
  assert.equal(origRow.session, mainSid, 'original sourceId must remain bound to original session so historyDb.sourceLink stays valid')
  assert.ok(historyDb.sourceLink(mainTurn1Src))
  const occRow = db.prepare('SELECT id, text FROM memory_sources WHERE session=?').get('sess-main-rewound') as { id: string, text: string } | undefined
  assert.ok(occRow && occRow.id !== mainTurn1Src, 'rewound session must receive a distinct deterministic occurrence sourceId')
  assert.equal(occRow.text, '支付网关改造正在做 A，遇到卡点 1')
})

test('blocker regressions: full merged evidence author guard (including dependencyOnly & pendingBatch replay) and noteInterval=5 trailing unavailable retry', async t => {
  const { dir, defer } = scratch(t, 'thread-notes-blocker-regressions-')

  // 1. Blocker #1: Day-1 `selection: CSV` -> Day-2 `"照刚才的格式办"` (where `CSV` becomes `dependencyOnly: true` on Day-2 card)
  //    MUST still block `digest/procedure/*` & `digest/personal/*` on BOTH live Dream and `pendingBatch` crash replay (§4.3)!
  let clock = Date.parse('2026-11-26T10:00:00Z')
  const root1 = path.join(dir, 'mem-b1')
  let dreamCalls = 0
  const makeOwner1 = () => openMemoryOwner({
    root: root1,
    hostNamespace: 'viva',
    now: () => clock,
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async ({ fromSeq }) => ({
      status: 'ok',
      assistant: fromSeq === 0 ? '已按 CSV 导出' : '好的，继续使用 CSV 格式导出',
    }),
    compute: (job, _signal, tools) => {
      if (job.stage === 'note') {
        const input = JSON.parse(job.input) as CapturedNoteInput
        const state = input.turns.map(turn => `${turn.user.map(u => u.text).join(' ')} -> ${turn.assistant}`).join('\n')
        return Promise.resolve(JSON.stringify({ status: 'write', title: '报表导出', state, events: [state] }))
      }
      if (job.stage === 'dream') {
        if (job.system === DREAM_PROFILE_SYSTEM) return Promise.resolve(JSON.stringify({ action: 'NOOP' }))
        if (job.system === DREAM_CONSOLIDATE_SYSTEM) {
          dreamCalls++
          const dInput = JSON.parse(job.input) as {
            notes: Array<{ path: string, sourceIds: string[] }>
            canonicalSources: Array<{ sourceId: string, author: string, text: string }>
          }
          const day2Note = dInput.notes.at(-1)!
          const day2User = dInput.canonicalSources.find(s => s.text === '照刚才的格式办')!
          return Promise.resolve(JSON.stringify({
            operations: [{
              action: 'CREATE',
              path: 'digest/procedure/export-csv.md',
              name: '以后默认导出 CSV',
              description: '以后默认导出 CSV',
              body: '默认统一使用 CSV 导出。',
              dailyPaths: [day2Note.path],
              sourceIds: [day2User.sourceId],
            }],
          }))
        }
      }
      return null
    },
  })
  let owner1 = makeOwner1()
  let owner1Closed = false
  defer(() => { if (!owner1Closed) owner1.close() })
  await owner1.recover()

  const sidCsv = 'sess-csv-launder'
  const callHash = 'd'.repeat(64)
  const selDigest = (await import('../src/memory/node/question-answer-memory.ts')).canonicalEligibleSelectionsDigest([
    { id: 'q-fmt', question: '本次导出格式？', selected: ['CSV'] },
  ])
  const emptyAnsDigest = (await import('../src/memory/node/question-answer-memory.ts')).canonicalEligibleAnswersDigest([])
  owner1.beginTurn({ sessionId: sidCsv, turn: 1, sessionKind: 'main', conversation: 'conv-csv', cwd: dir })
  owner1.recordQuestionReceipt({
    sessionId: sidCsv, turn: 1, callSeq: 1, callIdHash: callHash, conversationId: 'conv-csv',
    answeredAt: clock + 5, questionProfileGen: 0, answerProfileGen: 0,
    answerBatchDigest: emptyAnsDigest, selectionBatchDigest: selDigest,
  })
  const csvSelId = questionSelectionSourceId(sidCsv, 1, 'call-csv', 'q-fmt')
  await owner1.settleTurn({
    sessionId: sidCsv, cwd: dir, sessionKind: 'main', conversation: 'conv-csv', thread: 'conv-csv',
    inheritedSeq: 0, expectedNextSeq: null, fromSeq: 0, toSeq: 3, turn: 1, reasonKind: 'completed',
    sources: [],
    questionAnswers: [{
      callSeq: 1, callIdHash: callHash, requestId: `1:${callHash}`, questionAt: clock + 1,
      answerBatchDigest: emptyAnsDigest, selectionBatchDigest: selDigest, timezone: 'UTC',
      items: [],
      selectionItems: [{ sourceId: csvSelId, questionId: 'q-fmt', question: '本次导出格式？', selected: ['CSV'], text: 'CSV' }],
    }],
    assistantText: '已按 CSV 导出', at: clock + 10, timezone: 'UTC',
  })
  await owner1.runtime.wake()

  await owner1.settleTurn({
    sessionId: sidCsv, cwd: dir, sessionKind: 'main', conversation: 'conv-csv', thread: 'conv-csv',
    inheritedSeq: 0, expectedNextSeq: 3, fromSeq: 3, toSeq: 6, turn: 2, reasonKind: 'completed',
    sources: [{ sourceId: randomUUID(), author: 'user', sourceKind: 'main-human', profileEligible: true, text: '先核对一下表头字段', at: clock + 20, timezone: 'UTC' }],
    assistantText: '表头字段已核对完毕', at: clock + 20, timezone: 'UTC',
  })
  await owner1.runtime.wake()

  // Advance two days so Day-1 card ages out of the 2-day Dream scan window, leaving ONLY Day-2 card in batch
  // where `csvSelId` is strictly `dependencyOnly: true` (via `contextSources`, NOT immediate `previous`)!
  clock = Date.parse('2026-11-28T10:00:00Z')
  const day2UserId = randomUUID()
  await owner1.settleTurn({
    sessionId: sidCsv, cwd: dir, sessionKind: 'main', conversation: 'conv-csv', thread: 'conv-csv',
    inheritedSeq: 0, expectedNextSeq: 6, fromSeq: 6, toSeq: 9, turn: 3, reasonKind: 'completed',
    sources: [{ sourceId: day2UserId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '照刚才的格式办', at: clock, timezone: 'UTC' }],
    assistantText: '好的，继续使用 CSV 格式导出', at: clock, timezone: 'UTC',
  })
  await owner1.runtime.wake()

  await owner1.runtime.runDocumentDream()
  const db1 = new DatabaseSync(path.join(root1, 'memory.db'))
  assert.equal(db1.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 0, 'live Dream must reject digest/procedure/* when dependencyOnly selection tainted Day-2 card')

  // Seed a crash-interrupted `pendingBatch` carrying `{ id: csvSelId, dependencyOnly: true }` and verify `opSourcesValid` rejects it on recovery!
  const day2NoteRow = db1.prepare("SELECT key, workspace, path, file_revision, revision FROM memory_daily_notes WHERE day='2026-11-28'").get() as {
    key: string, workspace: string, path: string, file_revision: string, revision: number
  }
  const day2NoteRefs = (db1.prepare('SELECT source, token, dependency_only FROM memory_note_sources WHERE note=?').all(day2NoteRow.key) as Array<{
    source: string, token: string, dependency_only: number
  }>).map(r => ({ id: r.source, token: r.token, ...(r.dependency_only ? { dependencyOnly: true as const } : {}) }))
  assert.equal(day2NoteRefs.find(r => r.id === csvSelId)?.dependencyOnly, true)
  const day2View = await owner1.handleHost('listFiles', { args: [{ kind: 'daily' }] }) as {
    items: Array<{ path?: string, title: string, version: { policyToken: string } }>
  }
  const day2PolicyToken = day2View.items.at(-1)!.version.policyToken
  db1.close()
  owner1.close()
  owner1Closed = true

  const injectDb = new DatabaseSync(path.join(root1, 'memory.db'))
  const forgedMarkdown = `---\nname: 以后默认导出 CSV\ndescription: 以后默认导出 CSV\n---\n默认统一使用 CSV 导出。\n\n## Sources\n- [[${day2NoteRow.path}]]\n`
  const pendingPayload = {
    pendingBatch: {
      workspace: day2NoteRow.workspace,
      fileRefs: [{
        key: day2NoteRow.key, workspace: day2NoteRow.workspace, path: day2NoteRow.path,
        revision: day2NoteRow.file_revision, policyToken: day2PolicyToken,
        checkpoint: day2NoteRow.revision, sources: day2NoteRefs,
      }],
      operations: [{
        operationId: `dream:${randomUUID()}`,
        action: 'CREATE',
        path: 'digest/procedure/export-csv.md',
        expectedRevision: null,
        markdown: forgedMarkdown,
        sources: day2NoteRefs,
        reads: [],
        linkedPaths: [],
        files: [{ path: day2NoteRow.path, revision: day2NoteRow.file_revision }],
      }],
      checkpointPaths: [day2NoteRow.path],
    },
  }
  injectDb.prepare("UPDATE effects SET payload=?, due_at=? WHERE kind='memory.dream' AND key='daily'")
    .run(JSON.stringify(pendingPayload), clock)
  injectDb.close()

  dreamCalls = 0
  owner1 = makeOwner1()
  owner1Closed = false
  await owner1.recover()
  await owner1.runtime.wake()
  const verifyDb1 = new DatabaseSync(path.join(root1, 'memory.db'), { readOnly: true })
  defer(() => verifyDb1.close())
  assert.equal(verifyDb1.prepare('SELECT COUNT(*) AS n FROM memory_documents').get()?.n, 0, 'pendingBatch recovery must ALSO reject digest/procedure/* containing dependencyOnly selection')

  // 2. Blocker #2 + Journal Replay (cross-platform on macOS/Linux/Windows via `checkpoint('intent')`):
  //    Default `noteInterval = 5` where Turn 5 initially returns `unavailable` AND the first file write fails
  //    right after `memory_file_intents(state='pending')` commits — in-process `notes.recover()` replays Turns 1..4
  //    AND `effects` retains `{ flush: true }` so Turn 5 settles automatically once readable!
  let clock2 = Date.parse('2026-11-26T12:00:00Z')
  let failTurn5 = true
  let failFirstIntent = true
  const root2 = path.join(dir, 'mem-b2')
  const store2 = openMemoryStore(path.join(root2, 'memory.db'), () => clock2)
  const resources2 = openMemoryRuntimeResources({ store: store2, now: () => clock2 })
  resources2.openNotes = (readable, currentJob, opts) => openMemoryNotes(
    store2,
    readable,
    point => {
      if (point === 'intent' && failFirstIntent) {
        failFirstIntent = false
        throw Object.assign(new Error('cross-platform-disk-eio-after-intent'), { code: 'EIO' })
      }
    },
    currentJob,
    opts,
  )
  const runtime2 = createCoreMemoryRuntime({
    store: store2,
    resources: resources2,
    ...offlineMemorySafety,
    now: () => clock2,
    timezone: () => 'UTC',
    dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    changed: () => {},
    readSessionRange: async ({ fromSeq }) => {
      if (fromSeq === 12 && failTurn5) return { status: 'unavailable' }
      return { status: 'ok', assistant: `回复-${fromSeq / 3 + 1}` }
    },
    compute: job => {
      if (job.stage !== 'note') return Promise.resolve(JSON.stringify({ operations: [] }))
      const input = JSON.parse(job.input) as CapturedNoteInput
      const joined = input.turns.flatMap(turn => turn.user.map(u => u.text)).join(' | ')
      return Promise.resolve(JSON.stringify({
        status: 'write',
        title: '五轮批次尾轮恢复',
        state: [input.existing?.state, joined].filter(Boolean).join('\n'),
        events: [joined],
      }))
    },
  })
  defer(() => runtime2.close())

  const sid5 = 'sess-five-turns'
  for (let i = 0; i < 5; i++) {
    const srcId = randomUUID()
    runtime2.accept(
      `第${i + 1}轮进展`,
      { conversation: 'conv-5', session: sid5, scope: { kind: 'user' }, context: { kind: 'user' } },
      srcId,
      undefined,
      { deferAutomatic: false, at: clock2 + i * 100, timezone: 'UTC' },
    )
    store2.tx(() => {
      runtime2.recordNoteRangeInTx!({
        session: sid5,
        groupKey: 'conv-5',
        sessionKind: 'main',
        turnAt: clock2 + i * 100,
        fromSeq: i * 3,
        toSeq: (i + 1) * 3,
        turn: i + 1,
        ids: [srcId],
        assistant: `回复-${i + 1}`,
        flush: false,
      })
    })
  }
  await runtime2.wake()

  assert.equal(failFirstIntent, false, 'checkpoint("intent") must fire on first commit attempt')
  assert.ok(
    store2.db.prepare("SELECT 1 FROM memory_file_intents WHERE state='pending'").get(),
    'first write failure after staging intent must leave pending journal intent for in-process recovery',
  )
  clock2 += 5_000
  await runtime2.wake()
  // Now journal replay committed Turns 1..4 while Turn 5 is STILL unavailable — `effects` MUST still retain `memory.note`!
  assert.equal(
    (store2.db.prepare("SELECT status FROM memory_note_ranges WHERE session=? AND from_seq=12").get(sid5) as { status?: string } | undefined)?.status,
    'pending',
    'Turn 5 must remain pending while its session log is transiently unavailable',
  )
  assert.ok(
    store2.db.prepare("SELECT 1 FROM effects WHERE kind='memory.note'").get(),
    'effects table MUST retain a retry job after journal replay of Turns 1..4 despite remainder < noteInterval',
  )

  failTurn5 = false
  clock2 += 5_000
  await runtime2.wake()
  assert.equal(store2.db.prepare("SELECT COUNT(*) AS n FROM memory_note_ranges WHERE session=? AND status='pending'").get(sid5)?.n, 0, 'Turn 5 must automatically settle once readable without requiring 4 new user turns')
  const listed5 = await runtime2.listFilesAsync({ kind: 'daily' })
  const detail5 = await runtime2.readFileAsync(listed5.items[0]!.identity)
  assert.ok(detail5?.markdown.includes('第1轮进展') && detail5?.markdown.includes('第5轮进展'), detail5?.markdown)
})
