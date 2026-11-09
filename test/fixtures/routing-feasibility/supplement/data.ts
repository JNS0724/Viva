/** Synthetic fixtures for the supplementary probe. No user data. */
import type { HistoryHit } from '../../../../src/backend/history-channel.ts'

export interface ProbeTask { id: string, title: string, goal: string, status: string }
export interface StoredMessage { messageId: number, segmentId: string, title: string, seq: number, role: 'user' | 'assistant', text: string, at: number }
export interface SeedMessage { role: 'user' | 'assistant', text: string }

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 9, 2, 0, 0)

export const BRIEF_TASK: ProbeTask = { id: 'task-brief-01', title: '今日简报', goal: '整理每日工作相关资讯，输出中文简报', status: 'running' }
export const MARKET_TASK: ProbeTask = { id: 'task-market-01', title: '行情分析', goal: '分析 A 股行情', status: 'running' }
/** Same title, neutral goals: no language hint points at either one. */
export const AMBIGUOUS_TASKS: ProbeTask[] = [
  { id: 'task-weekly-07', title: '报告', goal: '汇总本周三个项目的进展', status: 'running' },
  { id: 'task-feedback-03', title: '报告', goal: '汇总本月的客户反馈', status: 'running' },
]

type Turn = [string, string]
function segment(segmentId: string, title: string, daysAgo: number, turns: Turn[], startId: number): StoredMessage[] {
  return turns.flatMap(([user, assistant], i) => [
    { messageId: startId + i * 2, segmentId, title, seq: i * 2, role: 'user' as const, text: user, at: NOW - daysAgo * DAY + i * 120_000 },
    { messageId: startId + i * 2 + 1, segmentId, title, seq: i * 2 + 1, role: 'assistant' as const, text: assistant, at: NOW - daysAgo * DAY + i * 120_000 + 30_000 },
  ])
}
const filler = (topic: string, n: number): Turn[] => Array.from({ length: n }, (_, i) => [
  `${topic}第 ${i + 1} 项：把负责人、截止时间和需要的材料对一下。`,
  `好的，${topic}第 ${i + 1} 项的负责人和截止时间已经列出来了，材料清单放在后面。`,
])

/** Searchable history where the briefing standard was set, then corrected in the same topic; noise elsewhere mentions 简报. */
export const AMENDED_CORPUS: StoredMessage[] = [
  ...segment('seg-weekly', '周会安排', 21, filler('周会', 6), 1000),
  ...segment('seg-brief', '每日简报的做法', 14, [
    ['我们先定今日简报的规则：按行业排序，先别用英文。', '好的，今日简报按行业排序，用中文。'],
    ['简报的来源先用公司内网和两个行业网站。', '记下了：来源是公司内网和两个行业网站。'],
    ['更正今日简报的规则：改成按与 Viva 项目的相关性排序，正文用中文，开头放识别码 ROUTE-JADE-7391。以后我说按原标准，就是指这一版。', '确认：按与 Viva 项目的相关性排序，中文正文，开头放 ROUTE-JADE-7391，取代之前按行业排序的规则。'],
  ], 2000),
  ...segment('seg-client', '客户简报模板', 9, [
    ['客户简报的模板放在共享盘的“模板”文件夹里。', '好的，客户简报模板在共享盘“模板”文件夹。'],
    ...filler('客户回访', 3),
  ], 3000),
  ...segment('seg-expense', '报销流程', 3, filler('报销', 5), 4000),
]

/** Searchable history where only the assistant proposed a format; the user never confirmed it. */
export const SUGGESTION_CORPUS: StoredMessage[] = [
  ...segment('seg-weekly', '周会安排', 20, filler('周会', 5), 1000),
  ...segment('seg-brief', '简报格式讨论', 12, [
    ['讨论下今日简报的格式，先不要定，我还没想好排序和语言。', '我建议用英文、按行业排序，开头加 ONLY-SUGGESTED-842。等你确认后再定。'],
    ['先放着，我们说说周会的事。', '好的，简报格式先放着。'],
  ], 2000),
  ...segment('seg-expense', '报销流程', 4, filler('报销', 4), 3000),
]

const words = (query: string) => query.split(/\s+/).map(w => w.trim()).filter(Boolean)

/** history-db.ts searchMessages semantics, simplified: every word appears; newest first. */
export function searchCorpus(corpus: readonly StoredMessage[], query: string): HistoryHit[] {
  const terms = words(query)
  if (!terms.length) return []
  return corpus.filter(m => terms.every(t => m.text.includes(t))).sort((a, b) => b.at - a.at).map(m => {
    const near = (seq: number) => corpus.find(x => x.segmentId === m.segmentId && x.seq === seq)
    const before = near(m.seq - 1), after = near(m.seq + 1)
    return {
      messageId: m.messageId, segmentId: m.segmentId, seq: m.seq, role: m.role, at: m.at, cwd: null, title: m.title,
      snippet: { before: '', hit: m.text.slice(0, 160), after: '' },
      before: before ? { role: before.role, text: before.text.slice(0, 120) } : null,
      after: after ? { role: after.role, text: after.text.slice(0, 120) } : null,
    }
  })
}

export function readCorpus(corpus: readonly StoredMessage[], ref: { segmentId: string, seq: number }, around = 4) {
  const own = corpus.filter(m => m.segmentId === ref.segmentId).sort((a, b) => a.seq - b.seq)
  if (!own.length) return { status: 'deleted' as const }
  const span = Math.min(Math.max(around, 1), 10)
  return {
    status: 'found' as const, title: own[0].title,
    messages: own.filter(m => Math.abs(m.seq - ref.seq) <= span).map(m => ({ messageId: m.messageId, segmentId: m.segmentId, seq: m.seq, role: m.role, text: m.text, at: m.at, target: m.seq === ref.seq })),
  }
}

/**
 * A long session for the compaction scenario: 80 turns of ~450 characters each, standard set at turn 20, corrected
 * at turn 46, other topics around and after. Not available to search: only the session (and its compaction) holds it.
 */
export function longSession(): SeedMessage[] {
  const pad = (topic: string, i: number) => `关于${topic}，第 ${i} 轮：先核对上周遗留的事项，再看本周新增的需求，把每项的负责人、截止时间、依赖的系统和需要准备的材料逐条列出来。`
    + '另外把会上提到但还没有结论的问题单独放一栏，注明下一次讨论的时间。最后检查一下有没有和别的项目冲突的安排，有的话标出来。'
  const reply = (topic: string, i: number) => `好的，${topic}第 ${i} 轮的清单已经整理好：遗留事项三项、新增需求两项，负责人和截止时间都列出来了。`
    + '没有结论的问题单独放在最后一栏，下一次讨论定在周四下午。和其他项目的冲突目前有一处，是测试环境的占用时间，已经标黄提醒。需要的材料也附在后面了。'
  const topics = ['采购审批', '测试环境排期', '招聘面试安排', '季度预算', '供应商对账', '培训计划']
  const out: SeedMessage[] = []
  for (let i = 1; i <= 80; i++) {
    const topic = topics[i % topics.length]
    if (i === 20) out.push({ role: 'user', text: '我们定一下今日简报的规则：按行业排序，先别用英文，来源用公司内网和两个行业网站。' }, { role: 'assistant', text: '好的，今日简报按行业排序，中文，来源是公司内网和两个行业网站。' })
    else if (i === 46) out.push({ role: 'user', text: '更正今日简报的规则：改成按与 Viva 项目的相关性排序，正文用中文，开头放识别码 ROUTE-JADE-7391。以后我说按原标准，就是指这一版。' }, { role: 'assistant', text: '确认：今日简报改为按与 Viva 项目的相关性排序，中文正文，开头放 ROUTE-JADE-7391，取代之前按行业排序的规则。' })
    else out.push({ role: 'user', text: pad(topic, i) }, { role: 'assistant', text: reply(topic, i) })
  }
  return out
}
