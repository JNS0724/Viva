import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { resolveConfig } from '../src/main/config.ts'
import { digitsOf, hasHan, latinShare } from './smoke/live-kit.ts'
import { LIVE_SCENARIOS, repeatOf, selectScenarios } from './smoke/live.ts'
import { RAW_ERROR } from './smoke/live-scenarios-app.ts'
import { summarize } from '../scripts/live-report.mjs'

const never = () => false
const FEATURES = fs.readFileSync(path.join(import.meta.dirname, '..', 'docs', 'features.zh-CN.md'), 'utf8')

test('the live check runs as two smoke phases', () => {
  assert.deepEqual([resolveConfig({ SMOKE_PHASE: 'live' }, never).smokePhase, resolveConfig({ SMOKE_PHASE: 'live-resume' }, never).smokePhase], ['live', 'live-resume'])
})

test('there are 26 scenarios, each named once, each covering a section of features.md', () => {
  const ids = LIVE_SCENARIOS.map((scenario) => scenario.id)
  assert.equal(ids.length, 26)
  assert.equal(new Set(ids).size, ids.length)
  for (const scenario of LIVE_SCENARIOS) {
    assert.ok(scenario.title && typeof scenario.run === 'function', scenario.id)
    assert.match(FEATURES, new RegExp(`^#{2,3} ${scenario.feature}$`, 'm'), `${scenario.id}: no section「${scenario.feature}」in docs/features.md`)
  }
})

test('the scenarios picked: all, the core ones, or those named', () => {
  assert.equal(selectScenarios({}).length, 26)
  const core = selectScenarios({ LIVE_SET: 'core' })
  assert.ok(core.length >= 10 && core.every((scenario) => scenario.core))
  assert.ok(core.some((scenario) => scenario.id === 'history'), 'the core set takes the app started again')
  assert.deepEqual(selectScenarios({ LIVE_ONLY: 'steer, desk' }).map((scenario) => scenario.id), ['steer', 'desk'])
  assert.throws(() => selectScenarios({ LIVE_ONLY: 'nope' }), /no such scenario: nope/)
  assert.throws(() => selectScenarios({ LIVE_SET: 'some' }), /core or full/)
})

test('each scenario runs three times unless told otherwise, and never an absurd number of times', () => {
  assert.equal(repeatOf({}), 3)
  assert.equal(repeatOf({ LIVE_REPEAT: '1' }), 1)
  for (const bad of ['0', '11', '2.5', 'x']) assert.throws(() => repeatOf({ LIVE_REPEAT: bad }), /whole number/)
})

test('what the checks read in an answer: digits with separators, English, Chinese', () => {
  assert.equal(digitsOf('合计 8,024.00 元，即 8 024'), '合计 8024.00 元，即 8024')
  assert.ok(latinShare('Coffee culture in the city 咖啡') > 0.6)
  assert.ok(latinShare('城市里的咖啡文化 coffee') < 0.6)
  assert.equal(latinShare(''), 0)
  assert.deepEqual([hasHan('密钥不对'), hasHan('401 Unauthorized')], [true, false])
})

test('a raw error is told from a plain Chinese one', () => {
  // As the window showed it for a wrong key, in the dry run of the live check.
  assert.match('出错了Internal error: turn failed: 401: {"message":"Authentication Fails, Your api key: ****-key is invalid"}', RAW_ERROR)
  assert.match('连接失败：connect ECONNREFUSED 127.0.0.1:9', RAW_ERROR)
  assert.doesNotMatch('API key 不对，去设置里检查一下。', RAW_ERROR)
  assert.doesNotMatch('连不上模型服务，检查网络后再试。', RAW_ERROR)
})

const attempt = (ok: boolean, ms: number, failures: string[] = []) => ({ ok, ms, failures, shots: [] })
type Scenario = { id: string, title: string, feature: string, core: boolean, step: string, attempts: ReturnType<typeof attempt>[] }
const phase = (name: string, scenarios: Scenario[]) => ({ phase: name, set: 'full', repeat: 2, startedAt: '2026-10-26T02:00:00.000Z', endedAt: '2026-10-26T02:40:00.000Z', scenarios })

test('the report puts both launches together, failures first, and compares with the last run', () => {
  const live = phase('live', [
    { id: 'steer', title: '插话', feature: '工作中插话', core: true, step: 'run', attempts: [attempt(true, 30_000), attempt(false, 40_000, ['the final answer should be in English'])] },
    { id: 'chat', title: '表格', feature: '消息里的 Markdown', core: false, step: 'run', attempts: [attempt(true, 10_000), attempt(true, 12_000)] },
    { id: 'history', title: '重开', feature: '历史对话', core: true, step: 'prepare', attempts: [attempt(true, 5_000), attempt(true, 5_000)] },
  ])
  const resume = phase('live-resume', [
    { id: 'history', title: '重开', feature: '历史对话', core: true, step: 'run', attempts: [attempt(true, 8_000), attempt(true, 9_000)] },
  ])
  const baseline = { scenarios: [{ id: 'steer', passed: 2, attempts: 2, ms: 20_000 }, { id: 'chat', passed: 2, attempts: 2, ms: 30_000 }] }
  const { markdown, json } = summarize([live, resume], baseline)
  assert.deepEqual(json.totals, { scenarios: 3, passed: 2, failed: 1 })
  assert.deepEqual(json.scenarios.map((s) => [s.id, s.passed, s.attempts]), [['steer', 1, 2], ['chat', 2, 2], ['history', 4, 4]])
  assert.ok(markdown.indexOf('❌ steer') < markdown.indexOf('✅ chat'), 'what failed comes first')
  assert.match(markdown, /1\/2/)
  assert.match(markdown, /the final answer should be in English/)
  assert.match(markdown, /上次 2\/2/, 'a scenario worse than last time says so')
  assert.match(markdown, /通过 2 \/ 3/)
})
