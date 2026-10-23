import fs from 'node:fs'
import path from 'node:path'
import { capture, run, UI_WAIT_MS, until, wait, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'

/**
 * Smoke steps in settings' 扩展 section, after the conversation set up the demo server: editing it in place
 * (a key added, the saved one kept without being typed again) and importing a dsh home's servers with their
 * keys (one new, one skipped as its name is in use, one key left missing).
 */
const IMPORT_KEY = 'smoke-import-key-9c1'
/** No such command: the imported server is left out of the session rather than started (mcp-config.ts toAcpServers). */
const IMPORTED_COMMAND = 'viva-smoke-imported-mcp'

const PATCH = [
  '- insert:',
  '  - id: mcp-imported',
  "    name: '@deepseek-ai/dsh-mcp-client'",
  '    config:',
  '      serverName: imported',
  '      transport: stdio',
  `      command: ${IMPORTED_COMMAND}`,
  '      env:',
  '        SMOKE_IMPORT_TOKEN: !!js process.env.SMOKE_IMPORT_TOKEN',
  '        NEED_TOKEN: !!js process.env.SMOKE_UNSET_TOKEN',
  '  - id: mcp-demo',
  "    name: '@deepseek-ai/dsh-mcp-client'",
  '    config: { serverName: demo, transport: stdio, command: node }',
  '',
].join('\n')

const itemText = (name: string) => `document.querySelector('.ext-item[data-name="${name}"]')?.textContent ?? ''`

async function editSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await run(win, `document.querySelector('.ext-item[data-name="demo"] .ext-actions button').click()`)
  await wait(UI_WAIT_MS)
  const form = await run(win, `(() => {
    const form = document.querySelector('.ext-edit')
    return form && {
      command: form.querySelector('[name="mcp-command"]')?.value,
      keys: [...form.querySelectorAll('.secret-key')].map((el) => el.textContent),
      placeholder: form.querySelector('.secret-row input[type="password"]')?.placeholder ?? '',
    }
  })()`)
  expect(form?.command === 'node' && form.keys.join() === 'DEMO_TOKEN' && form.placeholder.startsWith('保持不变'),
    'the edit form should be filled in, the saved key shown by name only', form)
  await run(win, `document.querySelector('.ext-add-key').click()`)
  await wait(UI_WAIT_MS)
  await run(win, `(() => {
    const row = [...document.querySelectorAll('.ext-edit .secret-row')].at(-1)
    row.querySelector('input[name^="mcp-key-name-"]').value = 'EXTRA_FLAG'
    row.querySelector('input[type="password"]').value = 'flag-value'
  })()`)
  await run(win, `document.querySelector('.ext-edit').scrollIntoView({ block: 'center' })`)
  await capture(win, outDir, 'mcp-edit')
  await run(win, `document.querySelector('.ext-edit').requestSubmit()`)
  const edited = await until(win, `(() => { const item = document.querySelector('.ext-item[data-name="demo"]'); return item && !item.dataset.editing && item.textContent })()`, 'the edited server')
  expect(edited.includes('已加密保存：DEMO_TOKEN、EXTRA_FLAG'), 'the saved key should stay and the new one join it', edited)
  const stored = fs.readFileSync(path.join(hooks.userData, 'mcp-servers.json'), 'utf8')
  expect(!stored.includes('flag-value'), 'the new key should be stored encrypted', stored.length)
}

async function importSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const dshHome = path.join(outDir, 'dsh-import')
  fs.mkdirSync(path.join(dshHome, 'profiles', 'web'), { recursive: true })
  fs.writeFileSync(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), PATCH)
  process.env.DSH_HOME = dshHome
  process.env.SMOKE_IMPORT_TOKEN = IMPORT_KEY
  try {
    // Settings read where dsh's home is when they open: open them again to see the fixture's.
    await run(win, `document.querySelector('.hub-nav[data-page="profile"]').click()`)
    await wait(UI_WAIT_MS)
    await run(win, `document.querySelector('.hub-nav[data-page="settings"]').click()`)
    await until(win, `document.querySelector('.import-btn') && !document.querySelector('.import-btn').disabled || null`, 'the settings page again')
    await run(win, `document.querySelector('.ext-group').scrollIntoView({ block: 'start' })`)
    await run(win, `document.querySelector('.import-btn').click()`)
    await wait(UI_WAIT_MS)
    const menu = await run(win, `[...document.querySelectorAll('.import-menu .workdir-item')].map((el) => el.textContent)`)
    expect(menu[0]?.startsWith('默认位置') && menu[0].endsWith('dsh-import') && menu.at(-1) === '选择其他 .dsh 文件夹…', 'the menu should offer the default folder and another', menu)
    await capture(win, outDir, 'mcp-import-menu')
    await run(win, `document.querySelector('.import-menu .workdir-item').click()`)
    const note = await until(win, `document.querySelector('.ext-import-note')?.textContent || null`, 'the import note')
    expect(note.includes('导入 1 个：imported') && note.includes('跳过 1 个重名的（demo）') && note.includes('imported 还缺 NEED_TOKEN'),
      'the note should say what came over, what was skipped and what is missing', note)
    const item = await run(win, itemText('imported'))
    expect(item.includes('缺少密钥：NEED_TOKEN') && item.includes('已加密保存：SMOKE_IMPORT_TOKEN'), 'the imported server should carry its key and name the missing one', item)
    await run(win, `document.querySelector('.ext-group').scrollIntoView({ block: 'start' })`)
    await capture(win, outDir, 'mcp-imported')
    const stored = fs.readFileSync(path.join(hooks.userData, 'mcp-servers.json'), 'utf8')
    expect(stored.includes('imported') && !stored.includes(IMPORT_KEY), 'the imported key should be stored encrypted', stored.length)
    const sent = JSON.stringify(hooks.model?.()?.requests ?? [])
    expect(!sent.includes(IMPORT_KEY), 'the imported key should never reach the model', sent.length)
  } finally {
    delete process.env.DSH_HOME
    delete process.env.SMOKE_IMPORT_TOKEN
  }
}

/** Run on the settings page, with the demo server listed. */
export async function mcpSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  await editSteps(win, outDir, expect, hooks)
  await importSteps(win, outDir, expect, hooks)
}
