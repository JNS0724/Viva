import { expect, type Page, type TestInfo } from '@playwright/test'

/** Exercise production DOM and CSS in the existing app, with no additional startup or model turn. */
export async function checkIslandLayouts(page: Page, info: TestInfo): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    const { results, typography } = await page.evaluate(async () => {
      const { createIsland } = await import(new URL('./view/island-dom.js', location.href).href) as typeof import('../../src/renderer/view/island-dom.ts')
      const { createIslandInput } = await import(new URL('./view/island-input.js', location.href).href) as typeof import('../../src/renderer/view/island-input.ts')
      const base = { tone: 'idle', mood: 'idle', label: '', recent: [] }
      const question = {
        ...base, form: 'asking', tone: 'waiting', mood: 'ask', label: '需要你回答',
        question: { questionId: 'layout-question', id: 'choice', text: '你希望优先检查哪部分视觉表现？',
          options: ['头像与留白', '文字与操作'], skippable: true },
      }
      const cases: Array<{ name: string, view: IslandShown, up?: boolean, draft?: string, pinned?: boolean }> = [
        { name: 'circle', view: { ...base, form: 'mini' } },
        { name: 'working', view: { ...base, form: 'working', tone: 'working', mood: 'thinking', label: '正在处理',
          action: '核对桌面岛长标题、后台计数及停止按钮同时存在时的完整状态文字', startedAt: Date.now() - 83_000,
          background: { count: 3, done: 0, items: [] } } },
        { name: 'permission', view: { ...base, form: 'waiting', tone: 'waiting', mood: 'confirm', label: '需要你确认',
          permission: { requestId: 'layout-permission', title: '运行项目的本地测试', command: 'npm run typecheck && npm test',
            options: [{ optionId: 'allow', name: '允许这次', role: 'primary' }, { optionId: 'deny', name: '拒绝', role: 'secondary' }] } } },
        { name: 'question', view: question },
        { name: 'long-question', view: { ...question, question: { ...question.question,
          text: question.question.text.repeat(6), options: ['头像大小与四周留白'.repeat(12), '文字层次与操作按钮', '状态色与边框粗细', '展开和收起的过渡动画'] } } },
        { name: 'files', view: { ...base, form: 'input', files: Array.from({ length: 10 }, (_, index) => ({
          path: `/layout/${index}.pdf`, name: `项目资料-${index + 1}-桌面岛视觉评审与布局验收记录.pdf`, size: 1200000,
        })), images: [] } },
        { name: 'input', view: { ...base, form: 'input', files: [], images: [] }, draft: '保留的草稿' },
        { name: 'multiline-input', view: { ...base, form: 'input', files: [], images: [] }, draft: '第一行\n第二行\n第三行\n第四行' },
        { name: 'input-error', view: { ...base, form: 'input', files: [], images: [], error: '连接失败，草稿已保留。'.repeat(40) }, draft: '失败后保留的输入' },
        { name: 'up-question', view: question, up: true },
        { name: 'background', pinned: true, view: { ...base, form: 'working', tone: 'working', label: '正在处理',
          background: { count: 2, done: 0, items: [
            { id: 'one', title: '检查头像', status: 'running', startedAt: Date.now() - 90_000 },
            { id: 'two', title: '核对输入样式', status: 'running', startedAt: Date.now() - 60_000 },
          ] } } },
      ]
      const gallery = document.createElement('section')
      gallery.id = 'island-layout-gallery'
      gallery.style.cssText = 'position:fixed;top:60px;bottom:16px;left:16px;width:620px;z-index:100;overflow:auto;background:var(--bg)'
      document.body.append(gallery)
      const results = []
      for (const sample of cases) {
        const stage = document.createElement('div')
        stage.className = 'desk-stage'
        stage.id = `layout-${sample.name}`
        stage.style.cssText = 'width:600px;height:352px;position:relative;flex:none;background:var(--panel-2);overflow:hidden'
        stage.dataset.dir = sample.up ? 'up' : 'down'
        const input = createIslandInput({ send: () => {}, dismiss: () => {}, removeFile: () => {} })
        const island = createIsland('desk', () => {}, { input })
        island.el.dataset.dir = stage.dataset.dir
        island.update(sample.view, { pinned: sample.pinned })
        stage.append(island.el)
        gallery.append(stage)
        if (sample.draft) {
          input.field.value = sample.draft
          input.field.dispatchEvent(new Event('input'))
          island.update(sample.view, { now: Date.now() + 1000 })
        }
        await document.fonts.ready
        await Promise.all([...island.el.querySelectorAll('img')].map(image => image.decode()))
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const card = island.el.getBoundingClientRect()
        const bounds = stage.getBoundingClientRect()
        const face = island.el.querySelector('.maid')!.getBoundingClientRect()
        const footer = island.el.querySelector('.isl-footer')?.getBoundingClientRect()
        const body = island.el.querySelector<HTMLElement>('.isl-body')
        const list = island.el.querySelector<HTMLElement>('.isl-files')
        if (body) body.scrollTop = body.scrollHeight
        if (list) list.scrollTop = list.scrollHeight
        const last = list?.lastElementChild ?? body?.querySelector('.isl-choices')?.lastElementChild
        const lastBounds = last?.getBoundingClientRect()
        const visibleBody = (list ?? body)?.getBoundingClientRect()
        const label = island.el.querySelector<HTMLElement>('.isl-label')
        results.push({
          name: sample.name, layout: island.el.dataset.layout, width: card.width, height: card.height,
          inside: card.left >= bounds.left && card.right <= bounds.right && card.top >= bounds.top && card.bottom <= bounds.bottom,
          portrait: face.width, portraitCentered: Math.abs(face.left + face.width / 2 - card.left - card.width / 2) < 1,
          footerVisible: !footer || (footer.top >= card.top && footer.bottom <= card.bottom),
          statusClipped: Boolean(label && label.scrollWidth > label.clientWidth),
          optionsClipped: [...island.el.querySelectorAll<HTMLElement>('.isl-choices .isl-btn')].some(option => option.scrollHeight > option.clientHeight + 1 || option.scrollWidth > option.clientWidth + 1),
          lastItemVisible: !lastBounds || Boolean(visibleBody && lastBounds.top >= visibleBody.top - 1 && lastBounds.bottom <= visibleBody.bottom + 1),
          bodyScrollable: Boolean(body && body.scrollHeight > body.clientHeight),
          filesScrollable: Boolean(list && list.scrollHeight > list.clientHeight),
          themedScrollbars: [body, list].filter((element): element is HTMLElement => Boolean(element)).every(element =>
            getComputedStyle(element).scrollbarColor === 'auto'
            && getComputedStyle(element, '::-webkit-scrollbar-button').display === 'none'
            && getComputedStyle(element, '::-webkit-scrollbar-thumb').borderTopWidth === '0px'),
          draftRetained: !sample.draft || input.field.value === sample.draft,
          backgroundToggleRetained: !sample.pinned || Boolean(island.el.querySelector('.isl-head .isl-bg')),
        })
        if (body) body.scrollTop = 0
        if (list) list.scrollTop = 0
      }
      const mono = document.createElement('span')
      mono.id = 'island-cjk-probe'
      mono.className = 'mono'
      mono.textContent = '中文示例 iiiiWWWW'
      const profile = document.createElement('div')
      profile.className = 'profile'
      const field = document.createElement('input')
      field.className = 'field'
      field.placeholder = '占位文字 Placeholder'
      profile.append(field)
      gallery.append(mono, profile)
      const placeholder = getComputedStyle(field, '::placeholder')
      const range = document.createRange()
      range.setStart(mono.firstChild!, 5)
      range.setEnd(mono.firstChild!, 9)
      const narrowWidth = range.getBoundingClientRect().width
      range.setStart(mono.firstChild!, 9)
      range.setEnd(mono.firstChild!, 13)
      const wideWidth = range.getBoundingClientRect().width
      return { results, typography: { profileFamily: getComputedStyle(field).fontFamily,
        placeholder: placeholder.color, placeholderOpacity: placeholder.opacity, narrowWidth, wideWidth } }
    })
    expect(typography.profileFamily).toContain('Space Grotesk')
    expect(typography.placeholder).toBe('rgb(118, 134, 166)')
    expect(typography.placeholderOpacity).toBe('1')
    expect(Math.abs(typography.narrowWidth - typography.wideWidth)).toBeLessThan(0.1)
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('DOM.enable')
      await cdp.send('CSS.enable')
      const document = await cdp.send('DOM.getDocument')
      const node = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#island-cjk-probe' })
      const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId })
      expect(fonts.fonts.length).toBeGreaterThan(0)
      expect(fonts.fonts.some(font => /^(?:NSimSun|SimSun)$/i.test(font.familyName))).toBe(false)
      await info.attach('island-platform-fonts', { body: JSON.stringify({ ...typography, fonts: fonts.fonts }, null, 2), contentType: 'application/json' })
    } finally { await cdp.detach() }
    for (const result of results) {
      expect(result.inside, result.name).toBe(true)
      expect(result.height, result.name).toBeLessThanOrEqual(320.1)
      expect(result.footerVisible, result.name).toBe(true)
      expect(result.statusClipped, result.name).toBe(false)
      expect(result.optionsClipped, result.name).toBe(false)
      expect(result.lastItemVisible, result.name).toBe(true)
      expect(result.draftRetained, result.name).toBe(true)
      expect(result.themedScrollbars, result.name).toBe(true)
      expect(result.backgroundToggleRetained, result.name).toBe(true)
      if (result.name === 'circle') {
        expect(result.width).toBeCloseTo(80, 0)
        expect(result.portraitCentered).toBe(true)
      } else if (result.layout === 'input') {
        expect(result.width).toBeCloseTo(520, 0)
        expect(result.portrait).toBeCloseTo(56, 0)
      } else {
        expect(result.width).toBeCloseTo(440, 0)
        expect(result.portrait).toBeCloseTo(result.layout === 'content' ? 40 : 48, 0)
      }
      if (result.name === 'long-question') expect(result.bodyScrollable).toBe(true)
      if (result.name === 'files') expect(result.filesScrollable).toBe(true)
      await page.locator(`#layout-${result.name}`).screenshot({ path: info.outputPath(`island-layout-${result.name}.png`) })
    }
    await info.attach('island-layout-metrics', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  } finally {
    await page.locator('#island-layout-gallery').evaluateAll(elements => elements.forEach(element => element.remove()))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
}
