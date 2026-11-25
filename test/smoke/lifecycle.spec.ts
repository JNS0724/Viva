import { test, expect } from './fixtures.ts'
import { pauseOwnedProcess } from '../fixtures/diagnostics-process-pause.ts'
import { finishTurn, newTopic, run, submit, until } from './smoke-kit.ts'

/** An approval card in the conversation, not a schedule proposal. */
const PERMISSION_CARD = '#thread .confirm:not(.ask):not(.fu-card)'

test('Viva replaces a crashed memory owner without restarting dsh @lifecycle', async ({ scenario }) => {
  const app = await scenario({ phase: 'memory', bridge: 'real' })
  const { window: win, page, hooks } = await app.start('memory-owner-recovery')
  const owner = await hooks.memoryOwnerPid()
  const dsh = await hooks.agentPid()
  if (!owner || !dsh) throw new Error('Missing Viva memory processes')
  expect(owner).not.toBe(dsh)
  expect(owner).not.toBe(await hooks.backendPid())
  const session = await run(win, 'window.agent.getInfo().then(info => info.sessionId)')
  const revision = await run(win, 'window.agent.getMemory().then(result => result.revision)')

  process.kill(owner, 'SIGKILL')
  await expect.poll(async () => {
    const replacement = await hooks.memoryOwnerPid()
    if (!replacement || replacement === owner) return false
    return await run(win, `window.agent.getMemory().then(result => result.revision >= ${Number(revision)}, () => false)`)
  }, { timeout: 25_000 }).toBe(true)
  expect(await hooks.agentPid()).toBe(dsh)
  expect(await run(win, 'window.agent.getInfo().then(info => info.sessionId)')).toBe(session)

  const words = '记忆进程恢复后的同一个话题'
  await submit(win, words)
  await finishTurn(win)
  await expect(page.locator('.msg-agent .msg-text').last()).toContainText(words)
})

test('intentional dsh restarts settle the old foreground turn @lifecycle', async ({ scenario }) => {
  const app = await scenario({ phase: 'memory', bridge: 'real' })
  const { window: win, hooks } = await app.start('lifecycle')
  const owner = await hooks.memoryOwnerPid()
  expect(owner).toBeTruthy()

  let previousOwner = owner

  for (const restart of ['model', 'key']) {
    // A foreground turn waiting on the user: an app operation's approval card (the main conversation asks no question cards).
    await submit(win, '帮我接入演示服务')
    await until(win, `Boolean(document.querySelector(${JSON.stringify(PERMISSION_CARD)}))`, 'the foreground approval before restart')
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
      return send?.dataset.busy === 'false' && !send.disabled && !document.querySelector(${JSON.stringify(PERMISSION_CARD)})
    })()`, `the ${restart} restart settling the old approval`, 15_000)
    // Exercise the backend busy guard too; merely hiding the card would leave new topics blocked.
    const previous = await run(win, `window.agent.getInfo().then(info => info.sessionId)`)
    await newTopic(win)
    await until(win, `(async () => {
      const info = await window.agent.getInfo(), send = document.getElementById('send-btn')
      return info.sessionId && info.sessionId !== ${JSON.stringify(previous)} && !send.disabled && send.dataset.busy === 'false'
    })()`, 'the new-topic UI and backend busy guard both accepting the next session')
    await expect.poll(async () => {
      const nextOwner = await hooks.memoryOwnerPid()
      if (!nextOwner || nextOwner === previousOwner) return false
      return await run(win, `window.agent.getMemory().then(result => typeof result.revision === 'number', () => false)`)
    }, { timeout: 20_000 }).toBe(true)
    previousOwner = await hooks.memoryOwnerPid()
  }

  const title = '生命周期重启后的后台任务'
  await submit(win, `后台做：${title}`)
  await until(win, `[...document.querySelectorAll('#thread > .msg-agent .msg-text')]
    .some(el => el.textContent.includes(${JSON.stringify(`已看过后台结果：${title}`)}))`, 'a task result reported after the intentional restarts')
  await finishTurn(win)
})

test('Stop reports a frozen runtime and preserves the editable draft through recovery @lifecycle', async ({ scenario }, info) => {
  const app = await scenario({ phase: 'memory', bridge: 'real' })
  const { page, window: win, hooks } = await app.start('stop-and-recover')
  await submit(win, '帮我接入演示服务')
  await expect(page.locator(PERMISSION_CARD)).toBeVisible()
  const pid = await hooks.agentPid()
  if (!pid) throw new Error('Missing test dsh process')
  const paused = await pauseOwnedProcess(pid)
  try {
    await page.locator('#send-btn[data-busy="true"]').click()
    await expect(page.locator('.msg-working')).toContainText('正在停止', { timeout: 2_000 })
    const draft = page.locator('#composer-input')
    await draft.fill('停止后保留的草稿')
    const clock = page.locator('#island .isl-time').first()
    const elapsed = await clock.innerText()
    await expect(clock).not.toHaveText(elapsed, { timeout: 3_000 })
    await info.attach('stopping-clock', { body: await page.screenshot(), contentType: 'image/png' })
    await expect(page.locator('#thread').getByText('执行端未确认停止。', { exact: true })).toBeVisible({ timeout: 12_000 })
    await expect(draft).toHaveValue('停止后保留的草稿')
    const recover = page.getByRole('button', { name: '恢复会话', exact: true })
    await expect(recover).toBeVisible()
    await expect(page.getByText('恢复会话会重启运行时，可能中断后台任务。')).toBeVisible()

    const screenshot = info.outputPath('stop-recovery.png')
    await page.screenshot({ path: screenshot })
    await info.attach('stop-recovery', { path: screenshot, contentType: 'image/png' })
    await paused.resume()
    await recover.click()
    await expect.poll(() => hooks.agentPid(), { timeout: 20_000 }).not.toBe(pid)
    await expect.poll(() => page.evaluate(() => window.agent.getMemory().then(memory => typeof memory.revision === 'number', () => false)), { timeout: 20_000 }).toBe(true)
    await expect(page.locator('#send-btn')).toBeEnabled()
    await expect(draft).toHaveValue('停止后保留的草稿')
    await page.locator('#send-btn').click()
    await expect(page.locator('.msg-agent .msg-text').last()).toContainText('停止后保留的草稿')
  } finally { await paused.resume() }
})
