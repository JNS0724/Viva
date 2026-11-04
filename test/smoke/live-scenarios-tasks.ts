import { escape, fresh, LIVE_TURN_MS, type LiveScenario } from './live-kit.ts'
import { run, until } from './smoke-kit.ts'

/** Live scenarios (live.ts) for what runs on its own: a task handed to the background. */
const TASK_WORDS = '列出三个提高睡眠质量的方法，每个一句话。'
const LAST_TASK = `[...document.querySelectorAll('#thread .task-card')].at(-1)`

const taskBackground: LiveScenario = {
  id: 'task-background',
  title: '让助手把事放到后台做，做完卡片上有结果，对话不被占用',
  feature: '后台任务',
  core: true,
  async run(ctx) {
    const { win, expect } = ctx
    await fresh(win)
    await run(win, `(() => {
      document.getElementById('composer-input').value = ${JSON.stringify(`放到后台做，不用等：${TASK_WORDS}`)}
      document.getElementById('composer').requestSubmit()
    })()`)
    const started = await until(win, `(() => {
      const card = ${LAST_TASK}
      return card && document.getElementById('send-btn').dataset.busy === 'false' ? { busy: 'false' } : null
    })()`, 'the task card, the agent\'s turn over', LIVE_TURN_MS)
    expect(started.busy === 'false', 'the conversation should be free while the task works', started)
    const done: { id: string, text: string, preview: string } | null = await until(win, `(() => {
      const card = ${LAST_TASK}
      return card?.dataset.status === 'done' ? { id: card.dataset.task, text: card.textContent, preview: card.querySelector('.task-line-text')?.textContent ?? '' } : null
    })()`, 'the task reporting back', LIVE_TURN_MS)
      .catch(() => null)
    expect(done !== null, 'the task should finish', await run(win, `${LAST_TASK}?.textContent ?? ''`))
    // The card is a one-line preview. A short introduction is valid; its character count proves nothing
    // about whether the task's actual answer is available on its own page.
    expect(done === null || Boolean(done.preview.trim()), 'the finished task should report on its card', done)
    await run(win, `${LAST_TASK}?.scrollIntoView({ block: 'center' })`)
    await ctx.shot('task-background')
    if (done) {
      await run(win, `${LAST_TASK}.click()`)
      await until(win, `document.querySelector('#tasks-page .tp-main')?.dataset.task === ${JSON.stringify(done.id)}`, 'the completed task detail')
      const detail = await run(win, `({ request: [...document.querySelectorAll('#tasks-page .tp-thread .msg-user')].map(el => el.textContent).join('\\n'),
        answer: [...document.querySelectorAll('#tasks-page .tp-thread .msg-agent .msg-text')].map(el => el.textContent).join('\\n') })`)
      // The brief is the agent's own words for the task: about sleep, not necessarily the user's words verbatim.
      expect(detail.request.includes('睡眠') && /[一-鿿]/u.test(detail.answer), 'its own page should keep the brief and the actual answer', detail)
      await ctx.shot('task-background-detail')
      await escape(win)
    }
  },
}

export const TASK_SCENARIOS: readonly LiveScenario[] = [taskBackground]
