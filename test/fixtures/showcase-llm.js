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

const systemText = (request) => (Array.isArray(request.system) ? request.system.map((part) => part.text ?? '').join('\n') : String(request.system ?? ''))
const partsOf = (message) => (Array.isArray(message?.content) ? message.content : [])
const afterTool = (request) => partsOf(request.messages.at(-1)).some((part) => part.type === 'tool_result')
/** The tool the model called just before, when this request carries its result. */
const toolBefore = (request) => (afterTool(request) ? partsOf(request.messages.at(-2)).find((part) => part.type === 'tool_use')?.name ?? null : null)
/** What the user said this turn, as fake-llm.js reads it (the memory block and tool results aside). */
const wordsOf = (request) => (afterTool(request) ? lastWords(request.messages) : questionOf(request.messages))

/** A schedule for the weekly report: every Friday at 16:00, its prompt written from what was said. */
function scheduleAnswer(request) {
  if (afterTool(request)) return { text: '好。时间和要做的事写在卡片上了，你点「定时」才会记下。到时候我只读地按上周的模板起草，结果放进「动态」，不会发送。' }
  return { tool: { name: 'schedule_create', input: {
    title: '周报',
    prompt: '按上周的模板起草本周周报：本周进展、风险、下周计划。材料是工作区里的《本周进展.md》和《周报模板.md》。只写草稿，不发送。',
    kind: 'weekly', time: '16:00:00', time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone, weekdays: [FRIDAY],
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
  const tool = toolBefore(request)
  if (tool === 'schedule_create') return scheduleAnswer(request)
  if (tool === 'bash' || tool === 'pwsh') return cleanupAnswer(request)
  const words = wordsOf(request)
  if (words.includes(SHOWCASE_PROMPTS.followup)) return scheduleAnswer(request)
  if (words.includes(SHOWCASE_PROMPTS.cleanup)) return cleanupAnswer(request)
  if (words.includes(SHOWCASE_PROMPTS.report)) return { text: REPORT }
  return null
}
