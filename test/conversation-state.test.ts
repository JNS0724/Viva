import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialConversation, reduceConversation } from '../src/renderer/conversation-state.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { threadState } from '../src/renderer/view/tasks-page.ts'

/**
 * One conversation, reduced on its own (conversation-state.ts, system-design §12.7 step 5): the one on screen and each
 * background task's go by the same pure reducer, and a task's view stays a conversation, nothing of the window's in
 * it; the thread is drawn from a view that names what it needs (view/thread.ts ThreadView).
 */

const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const CONVERSATION_FIELDS = Object.keys(initialConversation).sort()

/** A turn of a conversation: asked, answered in part, a tool, an approval asked and given, a question, its end. */
const turn = [
  { type: 'user_prompt', text: '查一下', at: 1 },
  { type: 'acp_update', update: chunk('好的，'), at: 2 },
  { type: 'acp_update', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: '读文件', status: 'in_progress' }, at: 3 },
  { type: 'permission_request', requestId: 'p1', toolCall: { toolCallId: 't1' }, options: [{ optionId: 'ok', kind: 'allow_once', name: '允许' }], at: 4 },
  { type: 'permission_resolved', requestId: 'p1', optionId: 'ok', at: 5 },
  { type: 'question_request', questionId: 'q1', questions: [{ id: 'c', question: '哪个城市？', options: [] }], at: 6 },
  { type: 'question_closed', questionId: 'q1', at: 7 },
  { type: 'acp_update', update: chunk('查完了。'), at: 8 },
  { type: 'turn_end', stopReason: 'end_turn', at: 9 },
]

test('pure: an action not the conversation\'s gives the same view back; one of its own a new view, the one given as it was', () => {
  const view = initialConversation as ConversationView
  assert.equal(reduceConversation(view, { type: 'settings_open' }), view)
  const asked = reduceConversation(view, turn[0])
  assert.notEqual(asked, view)
  assert.deepEqual([view.messages.length, view.phase], [0, 'idle'], 'the view given is not changed')
  assert.deepEqual([asked.messages.map((m) => m.text), asked.phase], [['查一下'], 'working'])
})

test('a task\'s view goes through a whole turn as a conversation: nothing of the window\'s gets into it', () => {
  const at = 1
  const made = reduce(initialState, { type: 'task_snapshot', snapshot: { taskId: 's1', runId: 'run-1', title: '查一下', status: 'running',
    currentAction: null, waitingFor: null, startedAt: at, updatedAt: at, endedAt: null, resultPreview: '', revision: 1, taskSeq: 0,
    opening: { words: '查一下', task: { id: 's1', segmentId: 'c-task', title: '查一下', words: '查一下' }, hostSession: null } } })
  const actions = turn.slice(1).map((action, i) => {
    if (action.type === 'acp_update') return { ...action, type: 'task_update', taskId: 's1', runId: 'run-1', seq: i + 1 }
    if (action.type === 'turn_end') return { type: 'task_end', taskId: 's1', stopReason: 'end_turn', at: 9, runId: 'run-1', seq: i + 1 }
    if (action.type === 'question_request') return { ...action, type: 'task_question', taskId: 's1', runId: 'run-1', seq: i + 1 }
    if (action.type === 'question_closed') return { ...action, type: 'task_question_closed', taskId: 's1', runId: 'run-1', seq: i + 1 }
    return { ...action, taskId: 's1', runId: 'run-1', seq: i + 1 }
  })
  const ended = actions.reduce(reduce, made)
  // Asked again: its new run begins with its next question (the window's way of asking would close the island too).
  const done = reduce(ended, { type: 'task_snapshot', snapshot: { ...made.tasks.list[0], taskId: 's1', runId: 'run-2', status: 'running',
    currentAction: null, waitingFor: null, startedAt: 10, updatedAt: 10, endedAt: null, resultPreview: '', revision: 9, taskSeq: 9,
    opening: { words: '再查一下' } } })
  const [task] = done.tasks.list
  assert.deepEqual(Object.keys(task.view).sort(), CONVERSATION_FIELDS, 'a conversation, and no more (no island, records, settings…)')
  // A tool and an approval between, what it wrote closes: what it says after goes on below.
  assert.deepEqual(task.view.messages.map((m) => m.text), ['查一下', '好的，', '查完了。', '再查一下'])
  assert.deepEqual([task.view.phase, task.status, task.view.timeline.map((entry) => entry.kind)],
    ['working', 'running', ['tool', 'permission', 'decision', 'question', 'answer']])
  assert.deepEqual([done.messages.length, done.phase], [0, 'idle'], 'the conversation on screen as it was')
})

test('the conversation on screen goes by the same reducer, the window\'s own state kept', () => {
  const open = { ...reduce(initialState, { type: 'toggle_island' }), records: [{ reportId: 'r1', at: 1, text: 'note', after: 0 }] }
  const asked = reduce(open, turn[0])
  assert.equal(asked.island, false, 'asking closes the island (the window\'s, beside the conversation\'s)')
  assert.deepEqual(asked.records, open.records, 'the rest of the window as it was')
  assert.deepEqual(turn.slice(1).reduce(reduce, asked).messages.map((m) => m.text), ['查一下', '好的，', '查完了。'])
})

test('a task\'s thread is drawn from its own conversation only: not the records, follow-ups or tasks of the one on screen', () => {
  const screen = { ...initialState, records: [{ reportId: 'r1', at: 1, text: 'note', after: 0 }], proposals: [{ id: 'p' }], taskCards: ['s9'] }
  const view = threadState(screen as never, { id: 's1', title: '查一下', status: 'done', view: reduceConversation(initialConversation as ConversationView, turn[0]) } as never)
  assert.deepEqual([view.records, view.proposals, view.taskCards, view.tasks.list, view.conversationId], [[], [], [], [], null])
  assert.deepEqual(view.messages.map((m) => [m.text, m.shown]), [['查一下', 3]], 'all of what it said shown')
})
