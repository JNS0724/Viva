import { capture, run, UI_WAIT_MS, until, wait, type Expect, type SmokeWindow } from './smoke-kit.ts'
import { openCapabilityTab } from './smoke-mcp.ts'

/**
 * Smoke steps on 能力 · 插件 · 插件源: the form for the company's registry and token, and an address the main process
 * refuses (not https) said as such, with nothing saved and dsh left running.
 */
export async function pluginSourceSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  await openCapabilityTab(win, 'plugins')
  await run(win, `[...document.querySelectorAll('#capabilities-root .cap-row')].find((row) => row.textContent.includes('插件源')).click()`)
  await until(win, `document.querySelector('#capabilities-root [name="plugin-source-registry"]') || null`, 'the plugin source form')
  const form = await run(win, `(() => {
    const row = [...document.querySelectorAll('#capabilities-root .cap-row')].find((one) => one.textContent.includes('插件源'))
    const token = document.querySelector('#capabilities-root [name="plugin-source-token"]')
    return { status: row?.querySelector('.ext-status')?.textContent ?? '', token: token?.type, placeholder: token?.placeholder ?? '' }
  })()`)
  expect(form.status === '未设置' && form.token === 'password' && form.placeholder === '没有可以不填', 'no source to begin with, the token typed hidden', form)
  await capture(win, outDir, 'plugin-source')
  await run(win, `(() => {
    document.querySelector('#capabilities-root [name="plugin-source-registry"]').value = 'npm.example.com'
    document.querySelector('#capabilities-root form.ext-edit').requestSubmit()
  })()`)
  const error = await until(win, `document.querySelector('#capabilities-root .cap-feedback[role="alert"]')?.textContent || null`, 'why the address was refused')
  expect(error.includes('https://'), 'an address that is not https should be refused, saying so', error)
  await wait(UI_WAIT_MS)
  const status = await run(win, `[...document.querySelectorAll('#capabilities-root .cap-row')].find((row) => row.textContent.includes('插件源'))?.querySelector('.ext-status')?.textContent ?? ''`)
  expect(status === '未设置', 'nothing should be saved', status)
}
