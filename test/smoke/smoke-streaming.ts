import { report, run, type SmokeWindow } from './smoke-kit.ts'

/**
 * An answer typed out draws only what changed each frame (view/markdown.ts streamMarkdown), and a task's 过程 draws
 * its latest steps (view/tasks-page.ts STEPS_SHOWN). Both in the real renderer: what streaming draws is what drawing
 * the whole text draws, at every step; and what each costs, for the perf budgets (smoke-perf.ts).
 */

/** Markdown whose blocks change as text comes: lists going on past a blank line, a fence, a table, setext, CRLF. */
const SAMPLE = [
  '# 标题\r\n\r\n第一段，**加粗**和`代码`，还有[链接](https://example.com)。\r\n',
  '- 一\n- 二\n\n- 三（空行后还是这张表）\n\n',
  '```ts\nconst a = 1\n\nconst b = 2\n```\n\n',
  '| 列一 | 列二 |\n| --- | :---: |\n| a | b |\n| c | d |\n\n',
  '这一行之后是 setext\n---\n\n> 引用\n续上的引用\n\n1. 有序\n2. 第二\n   - 嵌套\n\n最后一段没有换行',
].join('')

/**
 * Texts whose last line changes what it belongs to as it is typed (`*` an empty item until `*x` makes it a line of
 * the item above: codex's review of #80), and a code block that grows long; each checked like SAMPLE.
 */
const SAMPLES = [
  SAMPLE,
  '1. x\n*x',
  '- x\n*x',
  '> 引用\n*x\n\n- a\n- b\n*c 续上',
  // codex's second review of #80: a line that turns what is above it into something else, with no blank line.
  'p\n1.\n|---|---|x',
  'a\n<!--\n-->\nb\n=',
  // codex's third: a block with the same source reads differently once a table delimiter follows it.
  '===\n    a\n|---|---|\n',
  // A definition later on changes a link before it; a loose list goes on past blank lines.
  '见[文档][d]和[另一处][e]。\n\n中间一段。\n\n[d]: https://example.com/d\n\n[e]: https://example.com/e "标题"\n\n后文',
  '- 一\n\n- 二\n\n  续上第二项\n\n- 三\n\n结束',
  '    缩进代码\n\n    空行后还是代码\n\n正文',
  '前言\n\n```js\n' + Array.from({ length: 40 }, (_, i) => `const v${i} = ${i} // 第 ${i} 行`).join('\n') + '\n```\n\n后记',
]

/**
 * Streamed in chunks of every size, each frame matches the whole text drawn afresh, and the first heading, once
 * finished, keeps its node.
 * @returns problems
 */
export async function checkStreamMarkdown(win: SmokeWindow): Promise<string[]> {
  const seen = await run(win, `(async () => {
    const { renderMarkdown, streamMarkdown } = await import('./view/markdown.js')
    const ctx = { openLink: () => {}, image: null }
    const mismatches = []
    let frames = 0
    let headingsKept = 0
    for (const [sample, text] of ${JSON.stringify(SAMPLES)}.entries())
    for (const step of [1, 3, 7, 19, 64]) {
      let drawn = null
      let firstHeading = null
      let kept = true
      for (let end = step; ; end = Math.min(text.length, end + step)) {
        drawn = streamMarkdown(drawn, text.slice(0, end), ctx)
        frames += 1
        const whole = renderMarkdown(text.slice(0, end), ctx)
        // Text can sit in more than one adjacent node (a growing code block; inline runs drawn whole): compared joined.
        const joined = drawn.el.cloneNode(true)
        joined.normalize()
        whole.normalize()
        if (!joined.isEqualNode(whole) && mismatches.length < 3) mismatches.push({ sample, step, end, got: drawn.el.innerHTML.slice(-160), want: whole.innerHTML.slice(-160) })
        // SAMPLE's heading is finished once the paragraph after it has begun.
        if (sample === 0 && end > 40) {
          const heading = drawn.el.querySelector('.md-heading')
          firstHeading ??= heading
          kept &&= heading !== null && heading === firstHeading
        }
        if (end === text.length) break
      }
      if (sample !== 0) continue
      if (kept) headingsKept += 1
      else mismatches.push({ step, problem: 'the finished heading was drawn again' })
    }
    return { frames, headingsKept, mismatches }
  })()`) as { frames: number, headingsKept: number, mismatches: unknown[] }
  report(`stream markdown: ${JSON.stringify(seen)}`)
  return seen.mismatches.length ? [`a streamed answer should draw what the whole text draws, at every step: ${JSON.stringify(seen.mismatches)}`] : []
}

/** Each frame's work typing out the end of an answer in the thread. */
type FrameCost = { chars: number, frames: number, medianMs: number, p95Ms: number }

export interface StreamingCost {
  /** A 60 000-character answer of many short blocks. */
  answer: FrameCost
  /** A 120 000-character answer that is one code block, still open. */
  code: FrameCost
  /** A 60 000-character answer that is one paragraph: drawn again each frame (diagnostic, no budget). */
  paragraph: FrameCost
  /** Unfolding 过程 of a task of 1000 steps: the click's work, the rows drawn, and how many it should draw. */
  steps: { steps: number, rows: number, shown: number, expandMs: number }
}

/** What streaming and unfolding cost, measured off screen in the real renderer. */
export async function measureStreaming(win: SmokeWindow): Promise<StreamingCost> {
  return await run(win, `(async () => {
    const { initialState, reduce } = await import('./state.js')
    const { renderThread } = await import('./view/thread.js')
    const { renderTasksPage, STEPS_SHOWN } = await import('./view/tasks-page.js')
    const handlers = new Proxy({}, { get: () => () => {} })
    const offscreen = () => {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:-10000px;top:0;width:760px;height:900px;overflow:auto'
      document.body.append(host)
      return host
    }
    const pick = (list, q) => +[...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * q))].toFixed(2)

    const base = reduce(initialState, { type: 'history_loaded', conversationId: 'stream-fixture', savedAt: 1, messages: [{ role: 'user', text: '写长一点' }, { role: 'assistant', text: 'x' }] })
    /** The last 15 000 characters of \`text\` typed out, 250 a frame, after a first 5 000 to settle. */
    const typeOut = (text) => {
      const at = (shown) => ({ ...base, messages: base.messages.map((m, i) => i === base.messages.length - 1 ? { ...m, text, shown, open: true } : m) })
      const thread = offscreen()
      const times = []
      try {
        for (let shown = text.length - 20000; shown <= text.length; shown += 250) {
          const t0 = performance.now()
          renderThread(thread, at(shown), handlers, Date.now())
          thread.getBoundingClientRect()
          if (shown >= text.length - 15000) times.push(performance.now() - t0)
        }
      } finally { thread.remove() }
      return { chars: text.length, frames: times.length, medianMs: pick(times, 0.5), p95Ms: pick(times, 0.95) }
    }
    const fill = (unit, chars) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
    const blocks = fill('## 第 N 步\\n\\n这一步读取了笔记，记录了进展、遇到的**阻塞**和第二天的计划。\\n\\n- 待办一：接口联调\\n- 待办二：测试环境\\n\\n\`\`\`ts\\nconst result = await check(step)\\n\`\`\`\\n\\n', 60000)
    const code = '\`\`\`ts\\n' + fill('const result = await check(step) // 核对这一步\\n', 120000)
    const paragraph = fill('这一步读取了笔记，记录了进展、遇到的**阻塞**和第二天的计划。', 60000)
    const answer = typeOut(blocks)
    const codeCost = typeOut(code)
    const paragraphCost = typeOut(paragraph)

    let state = reduce(initialState, {type:'task_snapshot',snapshot:{taskId:'cost',runId:'run-1',title:'整理笔记',status:'running',currentAction:null,waitingFor:null,startedAt:Date.now(),updatedAt:Date.now(),endedAt:null,resultPreview:'',revision:1,taskSeq:0,opening:{words:'整理笔记',task:{id:'cost',title:'整理笔记',words:'整理笔记',segmentId:'seg'},hostSession:null}}})
    for (let i = 0; i < 1000; i += 1) {
      state = reduce(state, { type: 'task_update', taskId: 'cost', at: Date.now(), update: { sessionUpdate: 'tool_call', toolCallId: 't' + i, title: '读取 notes/' + i + '.md', kind: 'read', status: 'completed', rawInput: { path: 'notes/' + i + '.md' } } })
    }
    state = reduce(state, { type: 'tasks_page_open', taskId: 'cost' })
    const page = offscreen()
    let expandMs = 0, rows = 0
    try {
      renderTasksPage(page, state, handlers)
      await new Promise((done) => requestAnimationFrame(() => done()))
      const t0 = performance.now()
      renderTasksPage(page, reduce(state, { type: 'tasks_page_steps' }), handlers)
      page.getBoundingClientRect()
      expandMs = +(performance.now() - t0).toFixed(2)
      rows = page.querySelectorAll('.trace-row').length
    } finally { page.remove() }
    return {
      answer, code: codeCost, paragraph: paragraphCost,
      steps: { steps: 1000, rows, shown: STEPS_SHOWN, expandMs },
    }
  })()`) as StreamingCost
}
