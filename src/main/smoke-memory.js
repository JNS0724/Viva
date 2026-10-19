import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Smoke steps for memory, run on the real dsh with the memory plugin and the fake model
 * (test/fixtures/fake-llm.js): the intro, the agent remembering through the plugin's tool, the profile
 * page, a remembered name bringing its memory along, the trace saying so, and the 扩展 section.
 */
const UI_WAIT_MS = 600
const POLL_MS = 200
const TURN_TIMEOUT_MS = 60_000
const ROLE = '支付平台部的后端负责人'
const FACT = '周报每周五下班前交给张三'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const run = (win, code) => win.webContents.executeJavaScript(code)

async function capture(win, outDir, name, report) {
  const file = path.join(outDir, `${name}.png`)
  await fs.writeFile(file, (await win.webContents.capturePage()).toPNG())
  report(`saved ${file}`)
}

const submit = (win, text) => run(win, `(() => {
  document.getElementById('composer-input').value = ${JSON.stringify(text)}
  document.getElementById('composer').requestSubmit()
})()`)

/** Waits for the turn to end, allowing any permission card on the way. @returns {number} cards allowed */
async function finishTurn(win) {
  const deadline = Date.now() + TURN_TIMEOUT_MS
  let allowed = 0
  while (Date.now() < deadline) {
    const seen = await run(win, `(() => {
      const card = document.querySelector('.confirm .btn-ink')
      if (card) card.click()
      const send = document.getElementById('send-btn')
      return { card: Boolean(card), idle: send.dataset.busy === 'false' && !send.disabled && !document.querySelector('.caret') }
    })()`)
    if (seen.card) allowed += 1
    else if (seen.idle) return allowed
    await wait(POLL_MS)
  }
  throw new Error('a turn never finished')
}

async function steps(win, outDir, report, expect) {
  await run(win, `document.getElementById('new-session').click()`)
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  expect(await run(win, `Boolean(document.getElementById('start-intro'))`), 'a fresh profile should offer the intro on the home page')
  await capture(win, outDir, 'memory-home', report)

  await run(win, `document.getElementById('start-intro').click()`)
  await wait(UI_WAIT_MS)
  await run(win, `(() => {
    const field = (name) => document.querySelector('[name="' + name + '"]')
    field('intro-role').value = ${JSON.stringify(ROLE)}
    field('intro-projects').value = 'Q4 对账系统重构'
    field('intro-analyze').checked = false
  })()`)
  await capture(win, outDir, 'memory-intro', report)
  await run(win, `document.querySelector('.intro-form').requestSubmit()`)
  await wait(UI_WAIT_MS)
  const afterIntro = await run(win, `({ panel: Boolean(document.querySelector('.profile')), intro: Boolean(document.getElementById('start-intro')) })`)
  expect(!afterIntro.panel && !afterIntro.intro, 'saving the intro should close it and retire the home tile', afterIntro)

  await submit(win, `记住：${FACT}`)
  const asked = await finishTurn(win)
  await wait(UI_WAIT_MS)
  const toast = await run(win, `document.querySelector('.toast')?.textContent ?? ''`)
  expect(asked === 0, 'memory tools should run without a permission card', asked)
  expect(toast.includes(`已记住：${FACT}`), 'the toast should say what was remembered', toast)
  await capture(win, outDir, 'memory-remembered', report)

  await run(win, `document.getElementById('open-profile').click()`)
  await wait(UI_WAIT_MS)
  const page = await run(win, `({
    role: document.querySelector('[data-field="role"] .profile-value')?.textContent ?? '',
    memories: [...document.querySelectorAll('.memory-text')].map((el) => el.textContent),
    agentMarked: Boolean(document.querySelector('.memory-item[data-source="agent"]')),
  })`)
  expect(page.role === ROLE && page.memories.includes(FACT) && page.agentMarked, 'the profile page should show the intro and the memory', page)
  const meta = await run(win, `document.querySelector('.memory-item[data-source="agent"] .memory-meta')?.textContent ?? ''`)
  expect(meta.includes('关键词：周报、张三'), 'the memory should show the keywords the agent gave it', meta)
  await capture(win, outDir, 'memory-profile', report)
  await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await wait(UI_WAIT_MS)

  await submit(win, '帮我写这周的周报')
  await finishTurn(win)
  await wait(UI_WAIT_MS)
  // The fake model says what background came with the question; 周报 is a keyword of the memory.
  const answers = await run(win, `[...document.querySelectorAll('.msg-agent .msg-text')].map((el) => el.textContent)`)
  expect(answers.some((text) => text.startsWith('我已经了解你的背景（1 条相关记忆）')), 'naming 周报 should bring its memory along', answers.map((t) => t.slice(0, 24)))
  await run(win, `document.querySelector('.rail-btn[aria-label="过程"]')?.click()`)
  await wait(UI_WAIT_MS)
  const trace = await run(win, `[...document.querySelectorAll('.trace-row')].map((row) => row.textContent)`)
  expect(trace.some((row) => row.includes('带上记忆') && row.includes(`因为提到「周报」：${FACT}`)), 'the trace should show which memory went along and why', trace)
  await capture(win, outDir, 'memory-trace', report)

  await run(win, `document.getElementById('open-settings').click()`)
  await wait(UI_WAIT_MS * 2)
  const ext = await run(win, `({
    memoryOn: document.querySelector('.ext-memory')?.dataset.on,
    add: Boolean(document.getElementById('add-mcp')),
  })`)
  expect(ext.memoryOn === 'true' && ext.add, 'settings should show the memory tool connected and offer MCP servers', ext)
  await run(win, `document.querySelector('.ext').scrollIntoView()`)
  await capture(win, outDir, 'memory-settings', report)
}

/** @returns {Promise<string[]>} failed expectations */
export async function checkMemory(win, outDir, report) {
  const failures = []
  const expect = (ok, message, seen) => { if (!ok) failures.push(`${message}${seen === undefined ? '' : `: ${JSON.stringify(seen)}`}`) }
  try {
    await steps(win, outDir, report, expect)
  } catch (err) {
    failures.push(`memory: ${err instanceof Error ? err.message : String(err)}`)
  }
  return failures
}
