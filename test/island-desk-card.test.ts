import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deskCard, nextRequest, showsCoach } from '../src/renderer/island-desk-card.ts'

/** What each desktop card says and offers (island-desk-card.ts), with no DOM: every word once, every action once. */

const base = { mood: 'idle', recent: [] }
const permission = {
  ...base, form: 'waiting', tone: 'waiting', label: '需要你确认', task: '整理周报',
  permission: { requestId: 'p1', title: '运行命令', command: 'pnpm test',
    options: [{ optionId: 'ok', name: '允许', role: 'primary' }, { optionId: 'always', name: '总是允许', role: 'secondary' }, { optionId: 'no', name: '拒绝', role: 'text' }] },
}
const question = {
  ...base, form: 'asking', tone: 'waiting', label: '需要你回答',
  question: { questionId: 'q1', id: 'env', header: '部署环境', text: '要部署到哪个环境？', options: ['预发布', '生产'], skippable: true },
}
const done = { ...base, form: 'done', tone: 'done', label: '已完成', elapsedMs: 72_000, detail: '已经改好了', summary: '已经改好了 README 的安装步骤，并补了 Windows 的说明。' }
const opens = (card: ReturnType<typeof deskCard>) => card!.actions.some(button => button.act.kind === 'open')
const words = (card: ReturnType<typeof deskCard>) => card!.body.flatMap(part => 'text' in part ? [part.text] : [])

test('a permission names its task in the head and offers only its options; the window opens from the head icon', () => {
  const card = deskCard(permission, { shortcut: '' })!
  assert.equal(card.label, '需要你确认')
  assert.equal(card.meta, '来自 整理周报')
  assert.deepEqual(card.body.map(part => part.kind), ['title', 'code'])
  assert.deepEqual(card.actions.map(button => [button.text, button.role]), [['允许', 'primary'], ['总是允许', 'secondary'], ['拒绝', 'text']])
  assert.equal(opens(card), false, 'no second way to open the window')
  assert.equal(card.openIcon, true)
})

test('a request of the conversation on screen leaves the head\'s note empty', () => {
  assert.equal(deskCard({ ...permission, task: undefined }, { shortcut: '' })!.meta, '')
})

test('a single choice says once that a tap answers, and its options carry no word of their own', () => {
  const card = deskCard(question, { shortcut: '' })!
  assert.equal(card.meta, '部署环境')
  assert.deepEqual(card.body.map(part => part.kind), ['title', 'hint', 'choices'])
  const choices = card.body.find(part => part.kind === 'choices')!
  assert.deepEqual(choices.kind === 'choices' && choices.options.map(option => [option.text, option.act]),
    [['预发布', { kind: 'answer', questionId: 'q1', id: 'env', label: '预发布' }], ['生产', { kind: 'answer', questionId: 'q1', id: 'env', label: '生产' }]])
  assert.deepEqual(card.actions.map(button => [button.text, button.act.kind]), [['写其他答案', 'open'], ['跳过', 'skip']])
  assert.equal(card.openIcon, false, 'the other answer already opens the window')
})

test('a question with nothing to tap leads to the window with its main button', () => {
  const secret = deskCard({ ...question, label: '需要你填写', question: { questionId: 's1', id: 'secret', text: '接入「GitHub」需要你填写密钥', options: [], skippable: true } }, { shortcut: '' })!
  assert.deepEqual(secret.actions.map(button => [button.text, button.role, button.act.kind]), [['去 Viva 填写', 'primary', 'open'], ['跳过', 'text', 'skip']])
  assert.deepEqual(secret.body.map(part => part.kind), ['title'])
  const several = deskCard({ ...question, question: { ...question.question, options: [] } }, { shortcut: '' })!
  assert.equal(several.actions[0].text, '去 Viva 回答')
})

test('done shows the reply in its body and names the button for what it opens; no reply, no body', () => {
  const card = deskCard(done, { shortcut: '' })!
  assert.equal(card.meta, '用时 01:12', 'the same clock as the peek beside the cat')
  assert.deepEqual(card.body, [{ kind: 'text', text: done.summary, clamp: true }])
  assert.deepEqual(card.actions.map(button => [button.text, button.act.kind]), [['查看回复', 'open'], ['继续问', 'input']])
  assert.equal(card.openIcon, false)
  assert.deepEqual(deskCard({ ...done, detail: '', summary: '' }, { shortcut: '' })!.body, [])
})

test('an unfinished turn opens on its reply; a failure opens the window to see it', () => {
  const incomplete = deskCard({ ...base, form: 'error', tone: 'error', label: '未完成', detail: '已达到本轮输出上限', incomplete: true }, { shortcut: '' })!
  assert.deepEqual(incomplete.actions.map(button => button.text), ['查看回复', '继续问'])
  assert.deepEqual(incomplete.body, [{ kind: 'text', text: '已达到本轮输出上限' }])
  const failed = deskCard({ ...base, form: 'error', tone: 'error', label: '出错', detail: 'socket hang up' }, { shortcut: '' })!
  assert.deepEqual(failed.actions.map(button => button.text), ['在 Viva 查看', '继续问'])
})

test('not connected offers the settings; connecting offers nothing to do', () => {
  const setup = deskCard({ ...base, form: 'pending', tone: 'pending', label: '未连接', detail: '需要配置模型' }, { shortcut: '' })!
  assert.equal(setup.meta, '需要配置模型')
  assert.deepEqual(setup.actions.map(button => [button.text, button.act.kind]), [['去设置', 'settings']])
  const connecting = deskCard({ ...base, form: 'pending', tone: 'pending', label: '连接中' }, { shortcut: '' })!
  assert.deepEqual([connecting.body, connecting.actions], [[], []])
})

test('the background list counts its tasks in the head, not again in its body', () => {
  const card = deskCard({ ...base, form: 'background', tone: 'working', label: '工作中', background: { count: 3, done: 1, waiting: 0, items: [] } }, { shortcut: '' })!
  assert.deepEqual([card.label, card.meta], ['后台 3 件', '1 件做完了'])
  assert.deepEqual(card.body, [{ kind: 'background' }])
  assert.deepEqual(card.actions.map(button => [button.text, button.act.kind]), [['打开后台页', 'tasks']])
})

test('the first-time card leads each tip with its gesture, and closing it counts as seen', () => {
  const card = deskCard({ ...base, form: 'coach', tone: 'done', label: 'Viva 在这儿' }, { shortcut: '⌥Space' })!
  const tips = card.body[0]
  assert.equal(tips.kind, 'tips')
  assert.deepEqual(tips.kind === 'tips' && tips.items.map(item => item.key), ['⌥Space', '拖入', '按住'])
  assert.deepEqual(card.close, { kind: 'coached' })
  assert.deepEqual(card.actions.map(button => button.act), [{ kind: 'coached' }])
})

test('no card repeats its head in its body', () => {
  const views = [permission, question, done, { ...done, summary: '', detail: '' },
    { ...base, form: 'error', tone: 'error', label: '未完成', detail: '' },
    { ...base, form: 'pending', tone: 'pending', label: '未连接' }]
  for (const view of views) assert.ok(!words(deskCard(view, { shortcut: '' })).includes(view.label), view.form)
})

test('forms the input draws itself have no card', () => {
  assert.equal(deskCard({ ...base, form: 'input', tone: 'done', label: '问 Viva' }, { shortcut: '' }), null)
  assert.equal(deskCard({ ...base, form: 'drop', tone: 'done', label: '交给 Viva' }, { shortcut: '' }), null)
})

test('a request handled elsewhere gives way to the next one waiting, or to none', () => {
  const task = { id: 't', title: '检查依赖', status: 'waiting', question: { questionId: 'q9', id: 'x', text: '继续吗？', options: ['是'] } }
  const view = { ...base, form: 'idle', tone: 'idle', label: '空闲', background: { count: 1, waiting: 1, done: 0, items: [task] } }
  assert.equal(nextRequest(permission, 'p1'), null, 'still there: nothing to move to')
  assert.equal(nextRequest(view, 'p1')?.question?.questionId, 'q9')
  assert.equal(nextRequest({ ...base, form: 'idle', tone: 'idle', label: '空闲' }, 'p1'), undefined)
})

test('the first-time card shows only on the resting island', () => {
  const resting = { coach: true, expanded: false, dragging: false, form: 'mini', dropping: false }
  assert.equal(showsCoach(resting), true)
  assert.equal(showsCoach({ ...resting, coach: false }), false)
  assert.equal(showsCoach({ ...resting, expanded: true }), false)
  assert.equal(showsCoach({ ...resting, dragging: true }), false)
  assert.equal(showsCoach({ ...resting, dropping: true }), false)
  assert.equal(showsCoach({ ...resting, form: 'waiting' }), false)
})
