import { test, expect } from './fixtures.ts'
import { finishTurn, run, submit, until } from './smoke-kit.ts'

test('intentional dsh restarts settle the old foreground turn @lifecycle', async ({ scenario }) => {
  const app = await scenario({ phase: 'memory', bridge: 'real' })
  const { window: win } = await app.start('lifecycle')

  for (const restart of ['model', 'key']) {
    await submit(win, '明天天气怎么样')
    await until(win, `Boolean(document.querySelector('.ask'))`, 'the foreground question before restart')
    // Both public settings paths restart a live dsh. Keep the local fake provider and its endpoint:
    // updating the model resumes the topic; clearing the unused DeepSeek key creates a new topic.
    await run(win, restart === 'model' ? `(async () => {
      const provider = (await window.agent.getModels()).providers[0]
      return window.agent.updateModelProvider(provider.id, {
        name: provider.name, api: provider.api, baseURL: provider.baseURL, models: provider.models, key: '',
      })
    })()` : `window.agent.clearApiKey()`)
    await until(win, `(() => {
      const send = document.getElementById('send-btn')
      return send?.dataset.busy === 'false' && !send.disabled && !document.querySelector('.ask')
    })()`, `the ${restart} restart settling the old question`, 15_000)
    // Exercise the backend busy guard too; merely hiding the card would leave new topics blocked.
    expect(await run(win, `window.agent.newSession().then(info => Boolean(info.sessionId))`)).toBe(true)
  }

  const title = '生命周期重启后的后台任务'
  await submit(win, `后台做：${title}`)
  await until(win, `[...document.querySelectorAll('#thread > .msg-agent .msg-text')]
    .some(el => el.textContent.includes(${JSON.stringify(`已看过后台结果：${title}`)}))`, 'a task result reported after the intentional restarts')
  await finishTurn(win)
})
