import fs from 'node:fs'
import path from 'node:path'
import { capture, report, run, UI_WAIT_MS, until, wait, type SmokeWindow } from './smoke-kit.ts'

/**
 * 消息源 in the setup smoke run (smoke.ts), on the settings page it has just opened: 安装消息源… on the fake
 * source (test/fixtures/sources/fake-alerts, picked through a hook as the dialog cannot be clicked) shows it for a
 * yes, and 安装 lists it; switching it on with its token empty opens its form; 测试连接 with a wrong and then the
 * right token says so without saving; saving and switching on reads its first messages, which the page lists on
 * its own; 移除 takes it off the list and out of the sources folder.
 */
const SECTION = '#settings-root section[aria-label="消息源"]'
const SOURCE = `${SECTION} [data-id="fake-alerts"]`
const SWITCH = `${SOURCE} .source-switch`
const q = (selector: string) => `document.querySelector(${JSON.stringify(selector)})`

/** Types `value` into the field as the user would. */
const type = (name: string, value: string) => `(() => {
  const input = ${q(`${SOURCE} [name="${name}"]`)}
  input.value = ${JSON.stringify(value)}
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`

const clickButton = (scope: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent === ${JSON.stringify(text)}).click()`

/** @returns failures */
export async function checkSources(win: SmokeWindow, outDir: string, { userData, fixtures, pick }: {
  userData: string, fixtures: string, pick: (dir: string) => Promise<void>
}): Promise<string[]> {
  const failures: string[] = []
  await pick(path.join(fixtures, 'sources', 'fake-alerts'))
  await run(win, clickButton(SECTION, '安装消息源…'))
  await until(win, q(`${SECTION} .source-pending`), 'the chosen folder shown for a yes')
  const offer = await run(win, `${q(`${SECTION} .source-pending`)}.textContent`)
  if (!offer.includes('安装「假告警」？') || !offer.includes('node index.js') || !offer.includes('以你的权限运行')) failures.push(`the offer should say what it is, runs and risks: ${offer}`)
  await run(win, `${q(`${SECTION} .source-pending`)}.scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'sources-install')
  await run(win, clickButton(`${SECTION} .source-pending`, '安装'))
  await until(win, q(SOURCE), 'the fake source listed once installed')
  if (!fs.existsSync(path.join(userData, 'sources', 'fake-alerts', 'viva-source.json'))) failures.push('the source should be copied into the sources folder')
  await run(win, `${q(SOURCE)}.scrollIntoView({ block: 'center' })`)
  await wait(UI_WAIT_MS)
  await capture(win, outDir, 'sources-listed')

  await run(win, `${q(SWITCH)}.click()`)
  await until(win, q(`${SOURCE}[data-editing="true"]`), 'switching on without a token opens the form')

  await run(win, type('source-field-token', 'wrong'))
  await run(win, clickButton(SOURCE, '测试连接'))
  await until(win, `${q(`${SECTION} .form-error`)}?.textContent.includes('令牌不对')`, 'a wrong token said so')
  await run(win, type('source-field-token', 'good'))
  await run(win, clickButton(SOURCE, '测试连接'))
  await until(win, `${q(`${SECTION} .form-notice`)}?.textContent === '连接正常'`, 'the right token said so')
  await capture(win, outDir, 'sources-form')

  await run(win, `${q(`${SOURCE} form`)}.requestSubmit()`)
  await until(win, `${q(SWITCH)} && !${q(`${SOURCE}[data-editing="true"]`)}`, 'saved, the form closed')
  await run(win, `${q(SWITCH)}.click()`)
  await until(win, `document.querySelectorAll(${JSON.stringify(`${SOURCE} .source-latest li`)}).length === 2`, 'the first two messages listed on their own', 15_000)
  const seen = await run(win, `(() => ({
    on: ${q(SWITCH)}?.checked,
    status: ${q(`${SOURCE} .ext-status`)}?.textContent,
    latest: [...document.querySelectorAll(${JSON.stringify(`${SOURCE} .source-latest-title`)})].map((el) => el.textContent),
  }))()`)
  report(`sources: ${JSON.stringify(seen)}`)
  if (!seen.on || !String(seen.status).includes('每 5 分钟')) failures.push(`the source should be on and say how often it reads: ${JSON.stringify(seen)}`)
  if (JSON.stringify(seen.latest) !== JSON.stringify(['告警 2', '告警 1'])) failures.push(`the newest messages should be listed first: ${JSON.stringify(seen)}`)
  if (fs.readFileSync(path.join(userData, 'source-settings.json'), 'utf8').includes('"good"')) failures.push('the token should be kept encrypted')
  await capture(win, outDir, 'sources-on')

  await run(win, clickButton(SOURCE, '移除'))
  await until(win, `!${q(SOURCE)}`, 'the source off the list once removed')
  if (fs.existsSync(path.join(userData, 'sources', 'fake-alerts'))) failures.push('a removed source should leave the sources folder')
  return failures
}
