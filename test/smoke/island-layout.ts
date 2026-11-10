import { expect, type Page, type TestInfo } from '@playwright/test'

/**
 * The desktop island folded, state by state (view/island-dom.ts deskSignal): each its own ring, the sign on the
 * portrait only when it is alone, and the state's sign before its words. Reduced motion, so the rings are at rest.
 */
export async function checkDeskSignals(page: Page, info: TestInfo): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    const { rows: seen, blanks } = await page.evaluate(async () => {
      const { createIsland } = await import(new URL('./view/island-dom.js', location.href).href) as typeof import('../../src/renderer/view/island-dom.ts')
      const { placeDesktopIsland } = await import(new URL('./view/desktop-layout.js', location.href).href) as typeof import('../../src/renderer/view/desktop-layout.ts')
      const base = { tone: 'idle', mood: 'idle', label: '', recent: [] }
      const cases: Array<[string, IslandShown]> = [
        ['rest', { ...base, form: 'mini' }],
        ['working', { ...base, form: 'working', tone: 'working', mood: 'thinking', label: '正在处理', action: '读取文件', startedAt: Date.now() - 60_000 }],
        ['confirm', { ...base, form: 'waiting', tone: 'waiting', mood: 'confirm', label: '需要你确认', permission: { requestId: 'r', title: '运行测试', command: 'npm test', options: [] } }],
        ['asking', { ...base, form: 'asking', tone: 'waiting', mood: 'ask', label: '需要你回答', question: { questionId: 'q', id: 'c', text: '先看哪部分？', options: [] } }],
        ['done', { ...base, form: 'done', tone: 'done', mood: 'done', label: '已完成', elapsedMs: 72_000, detail: '周报整理好了' }],
        ['done-alone', { ...base, form: 'mini', tone: 'done', mood: 'done', label: '已完成' }],
        ['done-open', { ...base, form: 'done', tone: 'done', mood: 'done', label: '已完成', detail: '周报整理好了', desktopOpen: true, desktopPanel: 'status' }],
        ['error', { ...base, form: 'error', tone: 'error', mood: 'error', label: '出错了', detail: '连接中断' }],
        ['error-alone', { ...base, form: 'mini', tone: 'error', mood: 'error', label: '出错了' }],
        ['offline', { ...base, form: 'pending', tone: 'pending', mood: 'idle', label: '未连接', detail: '需要配置模型' }],
        ['rest-ended', { ...base, form: 'mini', background: { count: 0, done: 3, waiting: 0, items: [] } }],
        ['rest-running', { ...base, form: 'mini', background: { count: 1, done: 3, waiting: 0, items: [{ id: 't', title: '整理周报', status: 'running', now: '读取文件' }] } }],
      ]
      const gallery = document.createElement('section')
      gallery.id = 'desk-signal-gallery'
      gallery.style.cssText = 'position:fixed;top:60px;left:16px;z-index:100;display:grid;grid-template-columns:repeat(3,380px);gap:6px;background:var(--bg)'
      document.body.append(gallery)
      const rows = []
      for (const [name, view] of cases) {
        const stage = document.createElement('div')
        stage.className = 'desk-stage'
        stage.dataset.dir = 'down'
        stage.style.cssText = `width:380px;height:${view.desktopOpen ? 260 : 124}px;position:relative;flex:none;background:var(--panel-2);overflow:hidden`
        const island = createIsland('desk', () => {}, {})
        island.el.dataset.dir = 'down'
        island.update({ desktopOpen: false, ...view })
        stage.append(island.el)
        gallery.append(stage)
        placeDesktopIsland(island.el, stage, { anchor: { x: 54, y: 56 }, side: 'right', panelWidth: 440 })
        await Promise.all([...island.el.querySelectorAll('img')].map(image => image.decode()))
        const maid = getComputedStyle(island.el.querySelector('.isl-anchor > .maid')!)
        const sign = island.el.querySelector<HTMLElement>('.isl-sign')!
        const peek = island.el.querySelector<HTMLElement>('.isl-peek')!
        rows.push({
          name, signal: island.el.dataset.signal, ring: maid.boxShadow, outline: maid.outlineStyle, opacity: maid.opacity,
          arc: getComputedStyle(island.el.querySelector('.isl-anchor')!, '::before').content,
          sign: sign.hidden ? null : sign.textContent, signShown: !sign.hidden && sign.getBoundingClientRect().width > 0,
          peek: !peek.hidden, dot: peek.hidden ? null : peek.querySelector('.isl-dot')?.textContent ?? null,
          peekWidth: peek.hidden ? 0 : peek.getBoundingClientRect().width,
          corner: island.el.querySelector<HTMLElement>('.isl-corner:not([hidden])')?.textContent ?? null,
          cornerInside: (() => {
            const shown = island.el.querySelector<HTMLElement>('.isl-corner:not([hidden])')?.getBoundingClientRect()
            const round = island.el.querySelector('.isl-anchor')!.getBoundingClientRect()
            return !shown || (shown.left >= round.left - 0.5 && shown.right <= round.right + 0.5 && shown.top >= round.top - 0.5 && shown.bottom <= round.bottom + 0.5)
          })(),
        })
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      // Her mood changing (thinking to typing, as a turn goes): the portrait shown is never a picture still decoding,
      // which would blink her out for a frame (maid.ts showMaid).
      const swap = createIsland('desk', () => {}, {})
      const working = { ...base, form: 'working', tone: 'working', label: '正在处理', startedAt: Date.now() }
      swap.update({ ...working, mood: 'thinking', desktopOpen: false })
      await Promise.all([...swap.el.querySelectorAll('img')].map(image => image.decode()))
      const blanks = []
      for (const mood of ['typing', 'thinking', 'done', 'error']) {
        swap.update({ ...working, mood, desktopOpen: false })
        const shown = swap.el.querySelector<HTMLImageElement>('.isl-anchor img')
        if (!shown || !shown.complete || !shown.naturalWidth) blanks.push(mood)
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      return { rows, blanks }
    })
    await info.attach('desk-signals', { body: JSON.stringify(seen, null, 2), contentType: 'application/json' })
    expect(blanks, 'a mood changed never shows a picture still decoding').toEqual([])
    await page.locator('#desk-signal-gallery').screenshot({ path: info.outputPath('desk-signals.png') })
    const by = Object.fromEntries(seen.map(row => [row.name, row]))
    expect(seen.map(row => [row.name, row.signal])).toEqual([['rest', 'rest'], ['working', 'working'], ['confirm', 'confirm'], ['asking', 'asking'], ['done', 'done'],
      ['done-alone', 'done'], ['done-open', 'done'], ['error', 'error'], ['error-alone', 'error'], ['offline', 'offline'],
      ['rest-ended', 'rest'], ['rest-running', 'rest']])
    // The sign on the portrait only when it is alone; beside the words, the words carry it.
    expect(seen.map(row => [row.name, row.sign])).toEqual([['rest', null], ['working', null], ['confirm', null], ['asking', null], ['done', null],
      ['done-alone', '✓'], ['done-open', null], ['error', null], ['error-alone', '×'], ['offline', null], ['rest-ended', null], ['rest-running', null]])
    // At rest she is alone: no strip for what ended, only its count on her corner, inside her round (the window's
    // clicks reach only there); the strip comes back only for tasks going on.
    expect([by['rest-ended'].peek, by['rest-ended'].corner, by['rest-ended'].cornerInside]).toEqual([false, '✓ 3', true])
    expect([by['rest-running'].peek, by['rest-running'].corner]).toEqual([true, null])
    expect([by.rest.peek, by.rest.corner]).toEqual([false, null])
    // The strip is as long as what it says.
    expect(by.done.peekWidth).toBeLessThan(by.working.peekWidth + 1)
    expect(by['rest-running'].peekWidth).toBeLessThanOrEqual(320.5)
    expect([by['done-alone'].signShown, by['error-alone'].signShown]).toEqual([true, true])
    expect([by.confirm.dot, by.asking.dot, by.done.dot, by.error.dot, by.offline.dot, by.working.dot]).toEqual(['!', '?', '✓', '×', '–', ''])
    // Each its own ring: not one outline for all.
    const rings = ['confirm', 'done', 'error'].map(name => by[name].ring)
    expect(new Set(rings).size).toBe(3)
    expect(rings.every(ring => ring !== 'none')).toBe(true)
    expect(by.working.arc).not.toBe('none')
    expect(by.offline.outline).toBe('dashed')
    // At rest she stays sharp: no scaling or fading of her picture.
    expect(Number(by.rest.opacity)).toBe(1)
  } finally {
    await page.evaluate(() => document.getElementById('desk-signal-gallery')?.remove())
    await page.emulateMedia({ reducedMotion: null })
  }
}

/** Exercise production DOM and CSS in the existing app, with no additional startup or model turn. */
export async function checkIslandLayouts(page: Page, info: TestInfo): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  try {
    const { results, typography } = await page.evaluate(async () => {
      const { createIsland } = await import(new URL('./view/island-dom.js', location.href).href) as typeof import('../../src/renderer/view/island-dom.ts')
      const { createIslandInput } = await import(new URL('./view/island-input.js', location.href).href) as typeof import('../../src/renderer/view/island-input.ts')
      const { placeDesktopIsland } = await import(new URL('./view/desktop-layout.js', location.href).href) as typeof import('../../src/renderer/view/desktop-layout.ts')
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
        { name: 'done', view: { ...base, form: 'done', tone: 'done', mood: 'done', label: '已完成', elapsedMs: 72_000, detail: '桌面岛体验审查已整理',
          summary: '桌面岛体验审查已整理 头部只写状态，正文只写内容，每个动作只出现一次；话题名只留在输入的去向里。' } },
        { name: 'incomplete', view: { ...base, form: 'error', tone: 'error', mood: 'error', label: '未完成', incomplete: true,
          detail: '已达到本轮输出上限，回复可能不完整。已有内容已保留，可发送“继续”接着处理。' } },
        { name: 'not-connected', view: { ...base, form: 'pending', tone: 'pending', label: '未连接', detail: '需要配置模型' } },
        { name: 'coach', view: { ...base, form: 'coach', tone: 'done', label: 'Viva 在这儿' } },
        { name: 'steering', view: { ...base, form: 'input', files: [], images: [], steering: true,
          action: '读取 src/renderer/view/island-dom.ts 并核对桌面岛的状态卡片', startedAt: Date.now() - 42_000 } },
        { name: 'incoming-request', view: { ...base, form: 'input', files: [], images: [], waitingNotice: question }, draft: '继续编辑这份草稿' },
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
        const shown = { ...sample.view, desktopOpen: sample.name !== 'circle' && sample.name !== 'working', desktopPanel: sample.pinned ? 'background' : sample.view.form === 'input' ? 'input' : 'request' }
        island.update(sample.name === 'incoming-request' ? { ...shown, waitingNotice: null } : shown, { pinned: sample.pinned })
        stage.append(island.el)
        gallery.append(stage)
        const anchor = sample.up ? { x: 540, y: 302 } : { x: 60, y: 50 }
        placeDesktopIsland(island.el, stage, { anchor, side: sample.up ? 'left' : 'right', panelWidth: 440 })
        if (sample.draft) {
          input.field.value = sample.draft
          input.field.dispatchEvent(new Event('input'))
          if (sample.name === 'incoming-request') input.field.focus()
          island.update(shown, { now: Date.now() + 1000 })
        }
        await document.fonts.ready
        await Promise.all([...island.el.querySelectorAll('img')].map(image => image.decode()))
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const card = island.el.querySelector('.isl-surface:not([hidden]), .isl-peek:not([hidden])')?.getBoundingClientRect() ?? island.el.getBoundingClientRect()
        const avatar = island.el.querySelector('.isl-anchor')!.getBoundingClientRect()
        const bounds = stage.getBoundingClientRect()
        const face = island.el.querySelector('.maid')!.getBoundingClientRect()
        const footer = island.el.querySelector('.isl-footer')?.getBoundingClientRect()
        const entry = island.el.querySelector('.isl-entry')?.getBoundingClientRect()
        const body = island.el.querySelector<HTMLElement>('.isl-body')
        const list = island.el.querySelector<HTMLElement>('.isl-files')
        if (body) body.scrollTop = body.scrollHeight
        if (list) list.scrollTop = list.scrollHeight
        const last = list?.lastElementChild ?? body?.querySelector('.isl-choices')?.lastElementChild
        const lastBounds = last?.getBoundingClientRect()
        const visibleBody = body?.getBoundingClientRect()
        const label = island.el.querySelector<HTMLElement>('.isl-label')
        results.push({
          name: sample.name, layout: island.el.dataset.layout, width: card.width, height: card.height,
          inside: card.left >= bounds.left && card.right <= bounds.right && card.top >= bounds.top && card.bottom <= bounds.bottom,
          portrait: face.width, portraitCentered: Math.abs(face.left + face.width / 2 - avatar.left - avatar.width / 2) < 1,
          anchorStable: Math.abs(avatar.left + avatar.width / 2 - bounds.left - anchor.x) <= 1 && Math.abs(avatar.top + avatar.height / 2 - bounds.top - anchor.y) <= 1,
          footerVisible: !footer || (footer.top >= card.top && footer.bottom <= card.bottom),
          entryBeforeFooter: !entry || !footer || entry.bottom <= footer.top + 1,
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
          focusRetained: sample.name !== 'incoming-request' || document.activeElement === input.field,
          backgroundToggleRetained: !sample.pinned || Boolean(island.el.querySelector('button.isl-bg')),
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
      expect(result.entryBeforeFooter, result.name).toBe(true)
      expect(result.statusClipped, result.name).toBe(false)
      expect(result.optionsClipped, result.name).toBe(false)
      expect(result.lastItemVisible, result.name).toBe(true)
      expect(result.draftRetained, result.name).toBe(true)
      expect(result.focusRetained, result.name).toBe(true)
      expect(result.themedScrollbars, result.name).toBe(true)
      expect(result.backgroundToggleRetained, result.name).toBe(true)
      expect(result.anchorStable, result.name).toBe(true)
      if (result.name === 'circle') {
        expect(result.width).toBeCloseTo(80, 0)
        expect(result.portraitCentered).toBe(true)
      } else {
        expect(result.width).toBeCloseTo(result.name === 'working' ? 320 : 440, 0)
      }
      expect(result.portrait).toBeCloseTo(72, 0)
      if (result.name === 'long-question') expect(result.bodyScrollable).toBe(true)
      if (result.name === 'files') expect(result.bodyScrollable).toBe(true)
      await page.locator(`#layout-${result.name}`).screenshot({ path: info.outputPath(`island-layout-${result.name}.png`) })
    }
    await info.attach('island-layout-metrics', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    await checkIslandComposition(page, info)
  } finally {
    await page.locator('#island-layout-gallery').evaluateAll(elements => elements.forEach(element => element.remove()))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
  }
}

/** Browser-native composition must survive the state updates that arrive while a draft is edited. */
async function checkIslandComposition(page: Page, info: TestInfo): Promise<void> {
  const probe = await page.evaluateHandle(async () => {
    const { createIsland } = await import(new URL('./view/island-dom.js', location.href).href) as typeof import('../../src/renderer/view/island-dom.ts')
    const { createIslandInput } = await import(new URL('./view/island-input.js', location.href).href) as typeof import('../../src/renderer/view/island-input.ts')
    const sent: string[] = []
    const input = createIslandInput({ send: text => sent.push(text), dismiss: () => {}, removeFile: () => {} })
    const island = createIsland('desk', () => {}, { input })
    const view: IslandShown = { form: 'input', tone: 'idle', mood: 'idle', label: '', recent: [], files: [], images: [], desktopOpen: true, desktopPanel: 'input' }
    const stage = document.createElement('div')
    stage.className = 'desk-stage'
    stage.append(island.el)
    document.querySelector('#island-layout-gallery')!.prepend(stage)
    island.update(view)
    const events: Array<{ type: string, value: string }> = []
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'blur', 'focus']) {
      input.field.addEventListener(type, event => events.push({ type: event.type, value: input.field.value }))
    }
    return { island, input, view, events, sent, stage }
  })
  const cdp = await page.context().newCDPSession(page)
  const results = []
  try {
    for (const update of ['baseline', 'notice-added', 'steering-and-file', 'notice-removed']) {
      await probe.evaluate(probe => {
        probe.input.field.value = '前后'
        probe.input.field.focus()
        probe.input.field.setSelectionRange(1, 1)
        probe.input.field.dispatchEvent(new Event('input'))
        probe.events.length = 0
        probe.sent.length = 0
      })
      await cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 })
      await probe.evaluate((probe, update) => {
        if (update === 'baseline') return
        if (update === 'notice-added') probe.view = { ...probe.view, waitingNotice: { label: '需要你回答' } }
        if (update === 'steering-and-file') probe.view = { ...probe.view, steering: true, files: [{ path: '/ime.txt', name: 'ime.txt', size: 4 }] }
        if (update === 'notice-removed') probe.view = { ...probe.view, waitingNotice: null, steering: false }
        probe.island.update(probe.view)
      }, update)
      await cdp.send('Input.insertText', { text: '你' })
      const result = await probe.evaluate(probe => ({
        value: probe.input.field.value, active: document.activeElement === probe.input.field,
        start: probe.input.field.selectionStart, end: probe.input.field.selectionEnd,
        events: [...probe.events], files: probe.island.el.querySelectorAll('.isl-file').length,
      }))
      results.push({ update, ...result })
      expect(result.value, update).toBe('前你后')
      expect(result.active, update).toBe(true)
      expect([result.start, result.end], update).toEqual([2, 2])
      expect(result.events.some(event => event.type === 'blur'), update).toBe(false)
      expect(result.events.filter(event => event.type === 'compositionend'), update).toHaveLength(1)
      expect(result.files, update).toBe(update === 'steering-and-file' || update === 'notice-removed' ? 1 : 0)
      await page.keyboard.press('Enter')
      expect(await probe.evaluate(probe => probe.sent), update).toEqual(['前你后'])
    }
  } finally {
    await info.attach('island-composition-events', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    await cdp.detach()
    await probe.evaluate(probe => probe.stage.remove())
    await probe.dispose()
  }
}
