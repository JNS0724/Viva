/**
 * What the fake model says in the showcase run (test/smoke/smoke-showcase.ts), which makes the README's pictures
 * and demo: answers that read like real use, on a few fixed prompts. Anything else falls back to fake-llm.js's
 * rules. Background preparation is slowed down a little, so the demo can show it at work.
 */
import { lastWords, questionOf } from './fake-llm.js'

export const SHOWCASE_PROMPTS = Object.freeze({
  report: '把这周的进展整理成一页，用表格列出各模块',
  followup: '周五下班前要交周报，到时候帮我按上周的格式起草',
  cleanup: '把 drafts 里的临时文件清理掉',
})

const PREPARE_DELAY_MS = 3500
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const FRIDAY = 5

const REPORT = `## 本周进展 · 对账系统重构

整体**按计划推进**，接口联调还差一步，上线从周三改到**周五**。

- [x] 完成数据迁移（1,284 万条，校验一致）
- [x] 结算口径与财务对齐
- [ ] 补齐退款链路的回归测试

| 模块 | 负责人 | 进度 | 风险 |
|---|---|---|---|
| 结算 | 张三 | 80% | 低 |
| 退款 | 李四 | 45% | 回归用例不足 |
| 对账报表 | 王五 | 60% | 等口径确认 |

**下周重点**：退款回归测试补到 90% 覆盖，周五 18:00 前灰度上线。`

const DRAFT = `按上周的模板起好了草稿，内容取自本周的对话和《本周进展.md》。

### 本周进展
- **对账系统**：数据迁移完成，1,284 万条，校验一致；结算口径已与财务对齐。
- **退款链路**：回归用例补到 45%，剩下的集中在部分退款和跨月冲正。

### 风险
- 退款回归不足，灰度前要补到 90%；否则上线顺延到下周一。

### 下周计划
1. 周三前补齐退款回归测试
2. 周五 18:00 前灰度上线，周末观察对账差异

**还需要你补的**：财务口径确认邮件里的最终结论。`

/** The coming Friday at `hour`, local time (next week's when this one's has passed). */
function friday(hour, now = Date.now()) {
  const date = new Date(now)
  const ahead = (FRIDAY - date.getDay() + 7) % 7
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate() + ahead, hour)
  return at.getTime() > now + HOUR_MS ? at : new Date(at.getTime() + 7 * DAY_MS)
}

const systemText = (request) => (Array.isArray(request.system) ? request.system.map((part) => part.text ?? '').join('\n') : String(request.system ?? ''))
const partsOf = (message) => (Array.isArray(message?.content) ? message.content : [])
const afterTool = (request) => partsOf(request.messages.at(-1)).some((part) => part.type === 'tool_result')
/** The tool the model called just before, when this request carries its result. */
const toolBefore = (request) => (afterTool(request) ? partsOf(request.messages.at(-2)).find((part) => part.type === 'tool_use')?.name ?? null : null)
/** What the user said this turn, as fake-llm.js reads it (the memory block and tool results aside). */
const wordsOf = (request) => (afterTool(request) ? lastWords(request.messages) : questionOf(request.messages))

/** Verdicts for the showcase mailbox, one per message block: the one about something expiring needs the user. */
function judge(request) {
  const input = JSON.stringify(request.messages).replace(/\\n/g, '\n')
  const blocks = input.split(/\n(?=\[[^\]\s]+\/[^\]\s]+\] 来自：)/)
  const items = blocks.flatMap((block) => {
    const id = /^\[([^\]\s]+\/[^\]\s]+)\] 来自：/.exec(block)?.[1]
    if (!id) return []
    if (!block.includes('到期')) return [{ id, important: false }]
    return [{ id, important: true, why: '明天到期，要你回复确认', title: '合同续签', ask: '起草续签确认的回复，发不发由你', remind_at: new Date(Date.now() + DAY_MS / 2).toISOString() }]
  })
  return { text: JSON.stringify({ items }) }
}

function followupAnswer(request) {
  if (afterTool(request)) return { text: '好。准备和提醒的时间写在卡片上了，你点「跟进」我才会记下。到时候我先在后台按上周的模板起草，只读、不发送。' }
  return { tool: { name: 'viva_followup_propose', input: {
    title: '周报',
    ask: '按上周的模板起草本周周报：本周进展、风险、下周计划',
    prepare_by: friday(16).toISOString(),
    remind_at: friday(17).toISOString(),
    files: ['本周进展.md'],
  } } }
}

function cleanupAnswer(request) {
  if (afterTool(request)) return { text: '清理好了：删除了 drafts 里的 3 个临时文件，正式稿都还在。' }
  const shell = (request.tools ?? []).find((tool) => tool.name === 'bash' || tool.name === 'pwsh')
  if (!shell) return null
  const command = shell.name === 'pwsh' ? 'Remove-Item drafts\\*.tmp' : 'rm -rf drafts/*.tmp'
  return { tool: { name: shell.name, input: { command, description: '删除 drafts 里的临时文件' } } }
}

/** @returns an answer for a showcase prompt, or null to let fake-llm.js decide */
export function showcaseDecide(request) {
  const system = systemText(request)
  // dsh's Auto review of a pending step: fake-llm.js plays the reviewer.
  if (system.includes('REVIEW_POLICY') || JSON.stringify(request.messages).includes('REVIEW_POLICY')) return null
  if (system.includes('消息判断')) return judge(request)
  if (system.includes('后台准备')) return { text: DRAFT, delayMs: PREPARE_DELAY_MS }
  const tool = toolBefore(request)
  if (tool === 'viva_followup_propose') return followupAnswer(request)
  if (tool === 'bash' || tool === 'pwsh') return cleanupAnswer(request)
  const words = wordsOf(request)
  if (words.includes(SHOWCASE_PROMPTS.followup)) return followupAnswer(request)
  if (words.includes(SHOWCASE_PROMPTS.cleanup)) return cleanupAnswer(request)
  if (words.includes(SHOWCASE_PROMPTS.report)) return { text: REPORT }
  return null
}
