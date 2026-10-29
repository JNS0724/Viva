import type { BrowserWindow } from 'electron'
import { capture, run, until, type SmokeHooks } from './smoke-kit.ts'

/** Runs against an isolated profile; no real model or user credentials are needed. */
export async function checkLanguage(win: BrowserWindow, outDir: string, hooks: SmokeHooks): Promise<string[]> {
  const problems: string[] = []
  await until(win, `!document.documentElement.hasAttribute('data-language-loading')`, 'language initialization')
  const before = await run(win, `window.agent.getInfo()`)
  await run(win, `window.agent.setLanguage('en')`)
  await until(win, `document.documentElement.lang === 'en' && document.querySelector('.setup-title')?.textContent === 'Connect a model'`, 'English setup')
  await capture(win, outDir, 'language-en-setup')
  await run(win, `document.querySelector('.setup-action').click()`)
  await until(win, `Boolean(document.querySelector('select[name="language"]'))`, 'language settings')
  await run(win, `(() => {
    const input = document.getElementById('settings-key'); input.value = 'unsaved-example'; input.focus(); input.setSelectionRange(2, 5);
  })()`)
  await run(win, `window.agent.setLanguage('zh-CN')`)
  await until(win, `document.getElementById('settings-title')?.textContent === '设置'`, 'Chinese settings')
  const preserved = await run(win, `(() => { const input = document.getElementById('settings-key'); return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: input === document.activeElement }; })()`)
  if (preserved.value !== 'unsaved-example' || preserved.start !== 2 || preserved.end !== 5 || !preserved.focused) problems.push('Language switching lost unsaved input or selection')
  await capture(win, outDir, 'language-zh-settings')
  await run(win, `(() => { const select = document.querySelector('select[name="language"]'); select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  await until(win, `document.getElementById('settings-title')?.textContent === 'Settings'`, 'English language control')
  await capture(win, outDir, 'language-en-settings')
  win.setSize(921, 648)
  await until(win, `window.innerWidth <= 921`, 'narrow English window')
  await capture(win, outDir, 'language-en-narrow')
  const overflow = await run(win, `document.documentElement.scrollWidth > document.documentElement.clientWidth`)
  if (overflow) problems.push('English settings overflow the narrow window horizontally')
  // A broadcast must not replace a field while its input method owns composition.
  await run(win, `document.getElementById('settings-key').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))`)
  await run(win, `window.agent.setLanguage('zh-CN')`)
  if (await run(win, `document.documentElement.lang !== 'en'`)) problems.push('Language changed during IME composition')
  await run(win, `document.getElementById('settings-key').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))`)
  await until(win, `document.documentElement.lang === 'zh-CN'`, 'deferred language after composition')
  for (const locale of ['en', 'zh-CN', 'en']) {
    await run(win, `window.agent.setLanguage('${locale}')`)
    await until(win, `document.documentElement.lang === '${locale}'`, 'repeated language switch')
  }
  const after = await run(win, `window.agent.getInfo()`)
  if (before.sessionId !== after.sessionId || before.mode !== after.mode) problems.push('Changing language changed the agent session')
  const desk = hooks.desk?.()
  if (desk) {
    desk.force(true)
    desk.openInput()
    const page = { webContents: desk.webContents() }
    await until(page, `document.documentElement.lang === 'en' && document.querySelector('.isl-field')?.getAttribute('aria-label') === 'Ask Viva…'`, 'English desktop island text')
    await run(page, `document.querySelector('.isl-field').value = 'island draft'`)
    await run(win, `window.agent.setLanguage('zh-CN')`)
    await until(page, `document.documentElement.lang === 'zh-CN'`, 'desktop island language broadcast')
    await until(page, `document.querySelector('.isl-field')?.getAttribute('aria-label') === '问 Viva…'`, 'Chinese desktop island text')
    if (await run(page, `document.querySelector('.isl-field')?.value !== 'island draft'`)) problems.push('Desktop island lost its draft during language switching')
    desk.force(false)
  } else problems.push('Desktop island missing from language smoke')
  return problems
}
