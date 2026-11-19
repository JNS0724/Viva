import { startFakeRegistry, type FakePackage } from '../fixtures/fake-registry.ts'
import { capture, run, UI_WAIT_MS, until, wait, type Expect, type SmokeWindow } from './smoke-kit.ts'
import { openCapabilityTab } from './smoke-mcp.ts'

/**
 * Smoke steps on 能力 · 插件 · 插件源: the form for the company's registry and token, and an address the main process
 * refuses (not https) said as such, with nothing saved and dsh left running. Then a source on this computer: what it
 * has listed under 添加插件, each with whether it works in Viva, one looked at before it is installed; and the source
 * taken away again, dsh running as before.
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
  await catalogSteps(win, outDir, expect)
}

const CATALOG_TOKEN = 'npm_smoke_catalog_token'
const bundle = { bundle: { patch: 'patch.yml' } }
/** Bundles with different compatibility findings and a package that is not a plugin. */
const CATALOG: Record<string, FakePackage> = {
  '@viva-smoke/dsh-notes': { name: '@viva-smoke/dsh-notes', version: '1.2.0', description: '团队笔记：把会议纪要整理成待办', dsh: bundle },
  'dsh-web-panel': { name: 'dsh-web-panel', version: '0.3.0', description: '网页端的侧边面板', dsh: bundle, dependencies: { '@deepseek-ai/dsh-web-app': '^1' } },
  'dsh-future': { name: 'dsh-future', version: '1.0.0', dsh: bundle, engines: { dsh: '>=99' } },
  'left-pad': { name: 'left-pad', version: '1.3.0', description: 'Not a plugin' },
}

const sourceRow = `[...document.querySelectorAll('#capabilities-root .cap-row')].find((row) => row.textContent.includes('插件源'))`
const live = `(async () => { const info = await window.agent.getInfo(); return info.mode === 'live' && Boolean(info.sessionId) })()`

async function catalogSteps(win: SmokeWindow, outDir: string, expect: Expect) {
  const registry = await startFakeRegistry(CATALOG)
  try {
    await run(win, `(() => {
      document.querySelector('#capabilities-root [name="plugin-source-registry"]').value = ${JSON.stringify(registry.url)}
      document.querySelector('#capabilities-root [name="plugin-source-token"]').value = ${JSON.stringify(CATALOG_TOKEN)}
      document.querySelector('#capabilities-root form.ext-edit').requestSubmit()
    })()`)
    await until(win, `(${sourceRow})?.querySelector('.ext-status')?.textContent.includes('127.0.0.1') || null`, 'the plugin source saved')
    await until(win, live, 'dsh started again with the plugin source')

    await run(win, `document.querySelector('#capabilities-root .cap-add').click()`)
    await until(win, `document.querySelector('#capabilities-root [name="plugin-catalog-query"]') || null`, 'the search of the plugin source')
    await run(win, `document.querySelector('#capabilities-root .cap-catalog form').requestSubmit()`)
    const listed = await until(win, `(() => {
      const items = [...document.querySelectorAll('#capabilities-root .cap-catalog-item')]
      return items.length ? items.map((item) => ({ name: item.dataset.name, fit: item.querySelector('.ext-status')?.textContent ?? '' })) : null
    })()`, 'the plugins on the source')
    expect(JSON.stringify(listed) === JSON.stringify([
      { name: '@viva-smoke/dsh-notes', fit: '未发现已知冲突' },
      { name: 'dsh-web-panel', fit: '需要 dsh 网页端' },
      { name: 'dsh-future', fit: 'dsh 版本不兼容' },
    ]), 'the catalog shows each bundle and its compatibility finding', listed)
    expect(registry.asked.some((request) => request.url.startsWith('/-/v1/search')) && registry.asked.every((request) => request.auth === `Bearer ${CATALOG_TOKEN}`),
      'the source should be searched with its token, and asked nothing without it', registry.asked)
    await wait(UI_WAIT_MS)
    await capture(win, outDir, 'plugin-catalog')

    await run(win, `document.querySelector('#capabilities-root .cap-catalog-item[data-name="dsh-web-panel"] button').click()`)
    const looked = await until(win, `(() => {
      const item = document.querySelector('#capabilities-root .cap-catalog-item[data-name="dsh-web-panel"]')
      const card = item?.querySelector('.ext-group[role="group"]')
      return card ? {
        fit: item.querySelector('.cap-catalog-head .ext-status')?.textContent ?? '',
        repeated: card.textContent.includes('网页端的侧边面板') || card.textContent.includes('需要 dsh 网页端'),
        install: [...card.querySelectorAll('button')].some((button) => button.textContent === '安装' && !button.disabled),
        spec: document.querySelector('#capabilities-root [name="plugin-spec"]')?.value ?? '',
      } : null
    })()`, 'the lookup of the one picked, under it')
    expect(looked.spec === 'dsh-web-panel@0.3.0' && looked.install && looked.fit === '需要 dsh 网页端' && !looked.repeated,
      'looked at as name@version, 安装 under it, its fit said once beside its name before anything is installed', looked)
    await run(win, `(document.querySelector('#capabilities-root .cap-catalog-item[data-name="dsh-web-panel"]')).scrollIntoView({ block: 'center' })`)
    await wait(UI_WAIT_MS)
    await capture(win, outDir, 'plugin-catalog-look')
    await run(win, `[...document.querySelectorAll('#capabilities-root .ext-group[role="group"] button')].find((button) => button.textContent === '取消').click()`)

    await run(win, `document.querySelector('#capabilities-root .cap-catalog-item[data-name="dsh-future"] button').click()`)
    const futureCard = '#capabilities-root .cap-catalog-item[data-name="dsh-future"] .ext-group[role="group"]'
    const incompatible = await until(win, `(() => {
      const card = document.querySelector(${JSON.stringify(futureCard)})
      return card ? {
        disabled: [...card.querySelectorAll('button')].find((button) => button.textContent === '安装')?.disabled,
        version: card.querySelector('summary')?.textContent,
        requirement: card.querySelector('details li')?.textContent,
      } : null
    })()`, 'the incompatible plugin lookup')
    expect(incompatible.disabled && incompatible.version?.startsWith('当前 dsh ') && incompatible.requirement === 'engines.dsh >=99',
      'the incompatible version disables installation and shows its requirements', incompatible)
    await run(win, `document.querySelector(${JSON.stringify(futureCard)}).querySelector('summary').click()`)
    await run(win, `document.querySelector(${JSON.stringify(futureCard)}).scrollIntoView({ block: 'center' })`)
    await wait(UI_WAIT_MS)
    await capture(win, outDir, 'plugin-catalog-incompatible')
  } finally {
    await run(win, `(${sourceRow}).click()`)
    await until(win, `[...document.querySelectorAll('#capabilities-root button')].find((button) => button.textContent === '移除插件源') || null`, 'the plugin source to take away')
    await run(win, `[...document.querySelectorAll('#capabilities-root button')].find((button) => button.textContent === '移除插件源').click()`)
    await until(win, `(${sourceRow})?.querySelector('.ext-status')?.textContent === '未设置' || null`, 'the plugin source taken away')
    await until(win, live, 'dsh running again without the plugin source')
    await registry.close()
  }
}
