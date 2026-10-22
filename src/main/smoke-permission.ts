import { capture, report, run, UI_WAIT_MS, until, wait } from './smoke-kit.ts'

/**
 * The permission picker in the walkthrough smoke run (smoke.js): by the input it says what the assistant may
 * do without asking; its menu offers 仅可查看 / 工作区修改 / 自动 / 完全; picking 自动 restarts dsh on the
 * conversation on screen and the picker says so; then back to 工作区修改. Also the screenshots asked for:
 * the input with ＋ 新话题 above it, and the 关于你 page.
 */
const PICKER = `(() => {
  const chip = document.querySelector('#perm-area .perm-chip')
  return chip && { text: chip.textContent, disabled: chip.disabled, menu: [...document.querySelectorAll('#perm-area .perm-item .perm-name')].map((el) => el.textContent) }
})()`

/** Waits until the picker shows what `test` (page code over `seen`) asks, and returns what it showed. */
const pickerWhen = (win, test, what) => until(win, `(() => { const seen = ${PICKER}; return seen && (${test}) && seen })()`, what)
const pick = (level) => `document.querySelector('#perm-area .perm-item[data-level="${level}"]').click()`

/** @returns {Promise<string[]>} failures */
export async function checkPermission(win, outDir) {
  const failures = []
  const shown = await pickerWhen(win, 'true', 'the permission picker by the input')
  if (!shown.text.includes('工作区修改')) failures.push(`the picker should start on 工作区修改: ${JSON.stringify(shown)}`)
  await run(win, `document.getElementById('scroll').scrollTop = 1e9`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'permission-input')

  await run(win, `document.querySelector('#perm-area .perm-chip').click()`)
  const menu = await pickerWhen(win, 'seen.menu.length === 4', 'the permission menu')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'permission-menu')
  const names = ['仅可查看', '工作区修改', '自动实验', '完全']
  if (JSON.stringify(menu.menu) !== JSON.stringify(names)) failures.push(`the menu should offer ${names.join(' / ')}: ${JSON.stringify(menu.menu)}`)

  await run(win, pick('auto'))
  const auto = await pickerWhen(win, `seen.text.includes('自动') && !seen.disabled`, 'switched to 自动, dsh started again')
  await until(win, `document.getElementById('send-btn').dataset.busy === 'false' && !document.getElementById('send-btn').disabled`, 'the agent back after the restart')
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'permission-auto')
  await run(win, `document.querySelector('#perm-area .perm-chip').click()`)
  await until(win, `document.querySelector('#perm-area .perm-menu')`, 'the permission menu again')
  await run(win, pick('workspace-write'))
  await pickerWhen(win, `seen.text.includes('工作区修改') && !seen.disabled`, 'back to 工作区修改')

  // The 关于你 page: its sidebar on the title bar's ground.
  await run(win, `document.getElementById('open-profile').click()`)
  await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
  await until(win, `document.getElementById('hub').dataset.open === 'true'`, 'the 关于你 page')
  const grounds = await run(win, `(() => {
    const ground = (el) => getComputedStyle(el).backgroundColor
    return { side: ground(document.querySelector('.hub-side')), page: ground(document.body) }
  })()`)
  if (grounds.side !== grounds.page) failures.push(`the hub's sidebar should be on the title bar's ground: ${JSON.stringify(grounds)}`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'hub-profile')
  await run(win, `document.getElementById('hub-back').click()`)
  report(`permission: ${JSON.stringify({ shown, menu, auto, grounds })}`)
  return failures
}
