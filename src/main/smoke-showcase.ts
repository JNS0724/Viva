import fs from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { capture, finishTurn, newTopic, report, run, UI_WAIT_MS, until, wait, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { composeDesk, deskInput, deskWaiting } from './smoke-showcase-desk.ts'

/**
 * The README's pictures and demo (npm run showcase, scripts/showcase.mjs), made by the app itself on the real dsh
 * with the fake model's showcase answers (test/fixtures/showcase-llm.js), so they can be made again whenever the
 * look changes. Not a check: it stages each scene and captures it. The demo is a run of frames, taken while the
 * follow-up's whole way plays out: asked, proposed, followed up, prepared in the background, taken up.
 */
const WIDTH = 1440
const HEIGHT = 900
const FRAME_MS = 100
const TYPE_MS = 55
const PAUSE_MS = 1200
/** A toast stays a few seconds. */
const TOAST_TIMEOUT_MS = 15_000
const PREPARE_TIMEOUT_MS = 30_000
const HOUR_MS = 3_600_000
const PROMPTS = Object.freeze({
  report: '把这周的进展整理成一页，用表格列出各模块',
  followup: '周五下班前要交周报，到时候帮我按上周的格式起草',
  cleanup: '把 drafts 里的临时文件清理掉',
})
const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`
const clickText = (scope: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim() === ${JSON.stringify(text)})?.click()`
const setInput = (text: string) =>
  `(() => { const input = document.getElementById('composer-input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input')) })()`

/** The demo's frames, taken one after another while `start` … `stop` lasts. */
function recorder(win: SmokeWindow, dir: string) {
  let on = false
  let count = 0
  let done: Promise<void> = Promise.resolve()
  return {
    start() {
      on = true
      done = (async () => {
        while (on) {
          const started = Date.now()
          const image = await win.webContents.capturePage()
          await fs.writeFile(path.join(dir, `frame-${String(count).padStart(5, '0')}.png`), image.toPNG())
          count += 1
          await wait(Math.max(0, FRAME_MS - (Date.now() - started)))
        }
      })()
    },
    async stop() {
      on = false
      await done
      report(`demo: ${count} frames`)
    },
  }
}

/** Types into the input a character at a time, as someone would. */
async function typeIn(win: SmokeWindow, text: string) {
  for (let i = 1; i <= text.length; i += 1) {
    await run(win, setInput(text.slice(0, i)))
    await wait(TYPE_MS)
  }
}

const send = (win: SmokeWindow) => run(win, `document.getElementById('send-btn').click()`)
const closeHub = (win: SmokeWindow) => run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)

/** A workspace that reads like someone's: the week's notes, a template, drafts with temporary files beside them. */
async function seedWorkspace(cwd: string) {
  await fs.mkdir(path.join(cwd, 'drafts'), { recursive: true })
  await fs.writeFile(path.join(cwd, '本周进展.md'), [
    '# 本周进展', '', '## 对账系统重构', '', '- 数据迁移完成：1,284 万条，校验一致', '- 结算口径已与财务对齐', '- 退款链路回归测试：45%', '',
    '## 风险', '', '> 退款回归不足，灰度前要补到 90%。', '', '## 下周', '', '1. 周三前补齐回归测试', '2. 周五 18:00 前灰度上线', '',
  ].join('\n'))
  await fs.writeFile(path.join(cwd, '周报模板.md'), '# 周报\n\n## 本周进展\n\n## 风险\n\n## 下周计划\n')
  await fs.writeFile(path.join(cwd, '对账差异.csv'), '日期,笔数,金额\n10-21,12,"3,480.00"\n10-22,3,"920.50"\n10-23,0,0\n')
  for (const name of ['a.tmp', 'b.tmp', 'c.tmp']) await fs.writeFile(path.join(cwd, 'drafts', name), 'tmp')
  await fs.writeFile(path.join(cwd, 'drafts', '正式稿.md'), '# 正式稿\n')
}

/** What was there before the demo: a draft prepared overnight and a mail that needs the user, for 今天. */
function seedFollowups(hooks: SmokeHooks) {
  const { store } = hooks.followups()
  const review = store.add({ title: '设计评审意见', ask: '汇总设计稿 v3 的评审意见，列出要改的地方', origin: { kind: 'manual' }, prepareBy: Date.now() + HOUR_MS })
  store.moveStatus(review.id, 'scheduled', 'preparing')
  store.finishPreparing(review.id, '## 设计稿 v3 评审意见\n\n- 首页卡片间距偏大，建议 16px\n- 后台页的分组标题对比度不足\n\n**要你定的**：深色模式是否默认开启。', [])
  hooks.seedMail()
}

async function openSettings(win: SmokeWindow) {
  await run(win, `document.getElementById('hub').dataset.open === 'true' || document.getElementById('open-profile').click()`)
  await run(win, `${q('.hub-nav[data-page="settings"]')}.click()`)
  await until(win, q('#settings-root .settings'), 'the settings page')
}

/** The follow-up's whole way, recorded: asked, proposed, followed up, prepared in the background, taken up. */
async function demo(win: SmokeWindow, outDir: string, hooks: SmokeHooks) {
  const frames = path.join(outDir, 'frames')
  await fs.rm(frames, { recursive: true, force: true })
  await fs.mkdir(frames, { recursive: true })
  const rec = recorder(win, frames)
  rec.start()
  await wait(PAUSE_MS)
  await typeIn(win, PROMPTS.followup)
  await wait(UI_WAIT_MS)
  await send(win)
  await finishTurn(win)
  await until(win, q('#thread .fu-card[aria-label="要我跟进吗？"]'), 'the proposal card')
  await run(win, `${q('#thread .fu-card')}.scrollIntoView({ block: 'center', behavior: 'smooth' })`)
  await wait(PAUSE_MS * 2)
  await capture(win, outDir, 'followup-card')
  await run(win, clickText('#thread .fu-card', '跟进'))
  await until(win, q('#thread .fu-card .fu-choose'), 'the windows to choose')
  await wait(PAUSE_MS)
  await run(win, `${q('#thread .fu-card .fu-preset')}.click()`)
  await wait(PAUSE_MS * 1.5)
  hooks.openTasksPage()
  await until(win, `[...document.querySelectorAll('#hub-tasks-list .fu-row .tp-name')].some((el) => el.textContent === '周报')`, 'the follow-up on the 后台 page')
  await run(win, `[...document.querySelectorAll('#hub-tasks-list .fu-row')].find((el) => el.textContent.includes('周报')).click()`)
  await wait(PAUSE_MS)
  await run(win, clickText('#tasks-page .fu-main', '现在就准备'))
  await until(win, `${q('#island .isl-bg-prep')} || ${q('#hub-tasks-list .fu-state[data-on="true"]')}`, 'preparation at work')
  await wait(PAUSE_MS)
  await capture(win, outDir, 'preparing')
  await until(win, q('#tasks-page .fu-draft'), 'the draft, ready', PREPARE_TIMEOUT_MS)
  await wait(PAUSE_MS * 1.5)
  await capture(win, outDir, 'background')
  await run(win, clickText('#tasks-page .fu-main', '接着做'))
  await until(win, `document.getElementById('composer-input').value.startsWith('接着做')`, '接着做 puts the draft in the input')
  await wait(PAUSE_MS * 2)
  await rec.stop()
  await run(win, setInput(''))
}

async function chatScenes(win: SmokeWindow, outDir: string, desk: any) {
  await newTopic(win)
  await wait(UI_WAIT_MS)
  await run(win, setInput(PROMPTS.report))
  await send(win)
  await finishTurn(win)
  await wait(PAUSE_MS * 2)
  // This topic alone, from its question down: the demo's conversation stays above, out of the picture.
  await run(win, `[...document.querySelectorAll('#thread .msg-user-row')].at(-1).scrollIntoView({ block: 'start' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'chat')

  // 自动 lets ordinary steps through and asks before removing files, so the cleanup shows its permission card.
  await run(win, `${q('#perm-area .perm-chip')}.click()`)
  await run(win, `${q('#perm-area .perm-item[data-level="auto"]')}.click()`)
  await until(win, `${q('#perm-area .perm-chip[data-level="auto"]')} && !${q('#perm-area .perm-chip')}.disabled`, 'the 自动 level')
  // 「权限已换成」 is said in a toast; the pictures are taken once it has gone.
  await until(win, `!document.querySelector('.toast')`, 'the toast gone', TOAST_TIMEOUT_MS)
  const card = '#thread .confirm:not(.fu-card):not(.ask)'
  await run(win, setInput(PROMPTS.cleanup))
  // dsh restarts on the new level: sent once it is back.
  await until(win, `!document.getElementById('send-btn').disabled && document.getElementById('send-btn').dataset.busy === 'false'`, 'the agent back on the new level')
  await send(win)
  try {
    await until(win, q(card), 'the permission card')
  } catch (err) {
    await capture(win, outDir, 'approval-missing')
    throw err
  }
  await run(win, `${q(card)}.scrollIntoView({ block: 'center' })`)
  await wait(PAUSE_MS)
  await capture(win, outDir, 'approval')
  // The same step, asked on the desktop island.
  await deskWaiting(outDir, desk)
  await finishTurn(win)
}

async function suggestionScene(win: SmokeWindow, outDir: string, hooks: SmokeHooks) {
  hooks.openTasksPage()
  await until(win, q('#hub-tasks-list .fu-row[data-status="suggested"]'), 'the suggested mail')
  await run(win, `${q('#hub-tasks-list .fu-row[data-status="suggested"]')}.click()`)
  await until(win, q('#tasks-page .fu-message'), 'the mail and why')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'suggestion')
  await closeHub(win)
}

async function settingsScenes(win: SmokeWindow, outDir: string, hooks: SmokeHooks) {
  await openSettings(win)
  const section = '#settings-root section[aria-label="消息源"]'
  hooks.pickSourceFolder(path.join(hooks.fixtures, 'sources', 'showcase-mail'))
  await run(win, clickText(section, '安装消息源…'))
  await until(win, q(`${section} .source-pending`), 'the mail source offered')
  await run(win, clickText(`${section} .source-pending`, '安装'))
  const item = `${section} [data-id="company-mail"]`
  await until(win, q(item), 'the mail source installed')
  await run(win, `${q(`${item} .source-switch`)}.click()`)
  await until(win, q(`${item} [name="source-field-token"]`), 'its form')
  await run(win, `(() => { const input = ${q(`${item} [name="source-field-token"]`)}; input.value = 'showcase'; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await run(win, `${q(`${item} form`)}.requestSubmit()`)
  await until(win, q(`${item} .source-switch`), 'saved')
  await run(win, `${q(`${item} .source-switch`)}.click()`)
  await until(win, `document.querySelectorAll(${JSON.stringify(`${item} .source-latest li`)}).length === 3`, 'the mails in')
  await run(win, `${q(section)}.scrollIntoView({ block: 'start' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'sources')
  await run(win, `${q('#settings-root section[aria-label="后台准备"]')}.scrollIntoView({ block: 'start' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'prepare-settings')
  await closeHub(win)
}

async function filesScene(win: SmokeWindow, outDir: string) {
  await run(win, `document.getElementById('drawer').dataset.open === 'true' || document.getElementById('toggle-drawer').click()`)
  await run(win, `[...document.querySelectorAll('.drawer .tab')].find((el) => el.textContent === '文件').click()`)
  await until(win, `[...document.querySelectorAll('.file-row .file-name')].some((el) => el.textContent === '本周进展.md')`, 'the workspace tree')
  await run(win, `[...document.querySelectorAll('.file-row')].find((el) => el.querySelector('.file-name')?.textContent === '本周进展.md').click()`)
  await until(win, q('.file-doc h1, .file-doc h2, .file-doc h3'), 'the Markdown preview')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'files')
}

/** Every scene, in an order where each leaves what the next needs. */
export async function runShowcase(win: BrowserWindow, outDir: string, hooks: SmokeHooks): Promise<string[]> {
  win.setSize(WIDTH, HEIGHT)
  win.center()
  await seedWorkspace(hooks.cwd)
  await wait(UI_WAIT_MS)
  await run(win, clickText('#home', '以后再说'))
  seedFollowups(hooks)
  await until(win, q('#home .home-today'), 'the 今天 card on the home page')
  await wait(PAUSE_MS)
  await capture(win, outDir, 'home')
  await demo(win, outDir, hooks)
  await closeHub(win)
  await chatScenes(win, outDir, hooks.desk?.())
  await suggestionScene(win, outDir, hooks)
  await settingsScenes(win, outDir, hooks)
  await filesScene(win, outDir)
  await deskInput(outDir, hooks.desk?.())
  await composeDesk(outDir)
  return []
}
