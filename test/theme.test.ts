import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHELL_PREFERENCES } from '../src/backend/preferences.ts'
import { getLocale, setLocale } from '../src/shared/i18n/locale.ts'
import { t } from '../src/shared/i18n/translate.ts'
import { isThemePreference, resolveTheme, type ResolvedTheme, type ThemePreference, type ThemeState } from '../src/shared/theme.ts'
import { checkedIpc, type RawIpc } from '../src/shared/ipc-contract.ts'
import { registerThemeIpc } from '../src/shell/theme-ipc.ts'
import { initialState, reduce } from '../src/renderer/state.ts'
import { createThemeActions } from '../src/renderer/theme-actions.ts'
import { applyThemeDocument, initializeDeskTheme, registerThemeDocument, resetThemeDocumentsForTest } from '../src/renderer/theme.ts'
import { renderSettings, updateThemeControl } from '../src/renderer/view/settings.ts'

test('theme preferences validate, resolve cleanly against OS dark mode, and are writable by the shell', () => {
  assert.equal(SHELL_PREFERENCES.has('theme'), true)
  assert.equal(isThemePreference('system'), true)
  assert.equal(isThemePreference('dark'), true)
  assert.equal(isThemePreference('light'), true)
  assert.equal(isThemePreference('sepia'), false)
  assert.equal(isThemePreference(null), false)

  assert.equal(resolveTheme('dark', false), 'dark')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
})

test('registerThemeIpc persists changes, updates nativeTheme before reading systemDark, and follows OS changes only on system', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const raw: RawIpc = {
    handle: (channel, fn) => { handlers.set(channel, fn as (...args: unknown[]) => unknown) },
    on: () => {},
  }
  let saved: ThemePreference = 'dark'
  let rejectSave = false
  let osDark = false
  let nativeSource: ThemePreference = 'dark'
  const applied: ThemeState[] = []
  const broadcasts: ThemeState[] = []
  const systemUpdates: { fire?: () => void } = {}

  const control = registerThemeIpc(checkedIpc(raw), {
    getTheme: () => saved,
    saveTheme: async (next) => {
      if (rejectSave) throw new Error('disk full')
      saved = next
    },
    // Simulate Electron's nativeTheme: explicit dark/light overrides shouldUseDarkColors until themeSource returns to 'system'.
    systemDark: () => (nativeSource === 'dark' ? true : nativeSource === 'light' ? false : osDark),
    syncNative: (next) => { nativeSource = next },
    applyWindow: (state) => { applied.push(state) },
    broadcast: (state) => { broadcasts.push(state) },
    onSystemThemeChange: (listener) => {
      systemUpdates.fire = listener
      return () => { delete systemUpdates.fire }
    },
  })

  assert.deepEqual(await handlers.get('theme:get')!({}), { theme: 'dark', resolved: 'dark' })
  assert.deepEqual(applied, [{ theme: 'dark', resolved: 'dark' }])

  assert.deepEqual(await handlers.get('theme:set')!({}, 'light'), { theme: 'light', resolved: 'light' })
  assert.equal(saved, 'light')
  assert.equal(nativeSource, 'light')
  assert.deepEqual(broadcasts.at(-1), { theme: 'light', resolved: 'light' })

  rejectSave = true
  await assert.rejects(async () => handlers.get('theme:set')!({}, 'dark'), /disk full/)
  assert.equal(saved, 'light')
  assert.equal(nativeSource, 'light')
  assert.deepEqual(await handlers.get('theme:get')!({}), { theme: 'light', resolved: 'light' })
  rejectSave = false

  osDark = true
  systemUpdates.fire?.()
  assert.equal(broadcasts.length, 1)

  assert.deepEqual(await handlers.get('theme:set')!({}, 'system'), { theme: 'system', resolved: 'dark' })
  assert.equal(nativeSource, 'system')
  assert.deepEqual(broadcasts.at(-1), { theme: 'system', resolved: 'dark' })

  osDark = false
  systemUpdates.fire?.()
  assert.deepEqual(broadcasts.at(-1), { theme: 'system', resolved: 'light' })
  assert.equal(broadcasts.length, 3)

  systemUpdates.fire?.()
  assert.equal(broadcasts.length, 3)

  control.dispose()
  assert.equal(systemUpdates.fire, undefined)
})

test('theme reducer transitions remain immutable across saving, failure, broadcasts, and new_session resets', () => {
  const s0 = initialState
  assert.deepEqual(s0.theme, { theme: 'dark', resolved: 'dark', pending: null, failed: false })

  const s1 = reduce(s0, { type: 'theme_saving', theme: 'light' })
  assert.deepEqual(s1.theme, { theme: 'dark', resolved: 'dark', pending: 'light', failed: false })
  assert.equal(s0.theme.pending, null)

  // External OS broadcast while a save is pending updates resolved colour without clearing pending
  const s1Broadcast = reduce(s1, { type: 'theme_synced', theme: { theme: 'system', resolved: 'light' } })
  assert.deepEqual(s1Broadcast.theme, { theme: 'system', resolved: 'light', pending: 'light', failed: false })

  const s2 = reduce(s1Broadcast, { type: 'theme_failed' })
  assert.deepEqual(s2.theme, { theme: 'system', resolved: 'light', pending: null, failed: true })

  // Resolution-only OS appearance flip under the same saved preference preserves the failed-save indicator
  const s2OsFlip = reduce(s2, { type: 'theme_synced', theme: { theme: 'system', resolved: 'dark' } })
  assert.deepEqual(s2OsFlip.theme, { theme: 'system', resolved: 'dark', pending: null, failed: true })

  // An actual preference change clears a prior failed-save indicator
  const s2PrefChange = reduce(s2OsFlip, { type: 'theme_synced', theme: { theme: 'dark', resolved: 'dark' } })
  assert.deepEqual(s2PrefChange.theme, { theme: 'dark', resolved: 'dark', pending: null, failed: false })

  const s3 = reduce(s2, { type: 'theme_applied', theme: { theme: 'light', resolved: 'light' } })
  assert.deepEqual(s3.theme, { theme: 'light', resolved: 'light', pending: null, failed: false })

  // Starting a new topic preserves the user's appearance preference
  const s4 = reduce(s3, { type: 'new_session_pending', at: 123 })
  assert.deepEqual(s4.theme, { theme: 'light', resolved: 'light', pending: null, failed: false })
})

class FakeNode {}

interface FakeElement extends FakeNode {
  tagName: string
  className: string
  name: string
  value: string
  disabled: boolean
  textContent: string
  dataset: Record<string, string>
  children: FakeNode[]
  firstChild: FakeNode | null
  setAttribute: (k: string, v: string) => void
  getAttribute: (k: string) => string | null
  removeAttribute: (k: string) => void
  append: (...nodes: FakeNode[]) => void
  appendChild: (node: FakeNode) => FakeNode
  replaceChildren: (...nodes: FakeNode[]) => void
  contains: (node: FakeNode | null) => boolean
  querySelector: (selector: string) => FakeElement | null
  querySelectorAll: (selector: string) => FakeElement[]
  addEventListener: (type: string, fn: (event: { target: FakeElement }) => unknown) => void
  focus: (options?: { preventScroll?: boolean }) => void
  dispatchEvent: (event: { type: string }) => boolean
  dispatch: (type: string) => void
}

interface FakeDocument {
  documentElement: FakeNode & { dataset: Record<string, string> }
  body: FakeNode
  activeElement: FakeNode | null
  createElement: (tag: string) => FakeElement
  createTextNode: (text: string) => FakeNode & { textContent: string }
  querySelectorAll: (selector: string) => FakeElement[]
}

function fakeDoc(): FakeDocument {
  const dataset: Record<string, string> = {}
  const documentElement = Object.assign(new FakeNode(), { dataset })
  const body = new FakeNode()

  const collect = (node: FakeNode | null, predicate: (el: FakeElement) => boolean, out: FakeElement[] = []): FakeElement[] => {
    if (!node || !('children' in node)) return out
    const el = node as FakeElement
    if (predicate(el)) out.push(el)
    for (const child of el.children) collect(child, predicate, out)
    return out
  }

  const containsNode = (root: FakeNode, target: FakeNode | null): boolean => {
    if (!target) return false
    if (root === target) return true
    if (!('children' in root)) return false
    return (root as FakeElement).children.some(child => containsNode(child, target))
  }

  const matchSelector = (el: FakeElement, selector: string): boolean => {
    if (selector === 'input[name], textarea[name], select[name]') {
      return (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') && Boolean(el.name)
    }
    if (selector === 'select[name="theme"]') return el.tagName === 'SELECT' && el.name === 'theme'
    if (selector === '[data-theme-help]') return el.getAttribute('data-theme-help') !== null
    if (selector === 'button.btn-outline') return el.tagName === 'BUTTON' && el.className.includes('btn-outline')
    const nameMatch = /^\[name="([^"]+)"\]$/.exec(selector)
    if (nameMatch) return el.name === nameMatch[1]
    return false
  }

  const doc: FakeDocument = {
    documentElement,
    body,
    activeElement: body,
    createElement: (tag: string) => {
      const listeners = new Map<string, Array<(event: { target: FakeElement }) => unknown>>()
      const attrs = new Map<string, string>()
      let isDisabled = false
      const el: FakeElement = Object.assign(new FakeNode(), {
        tagName: tag.toUpperCase(),
        className: '',
        name: '',
        value: '',
        disabled: false,
        textContent: '',
        dataset: {} as Record<string, string>,
        children: [] as FakeNode[],
        firstChild: null as FakeNode | null,
        setAttribute: (k: string, v: string) => {
          attrs.set(k, v)
          if (k === 'name') el.name = v
          if (k === 'value') el.value = v
          if (k === 'disabled') el.disabled = true
          if (k.startsWith('data-')) {
            const camel = k.slice(5).replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase())
            el.dataset[camel] = v
          }
        },
        getAttribute: (k: string) => attrs.get(k) ?? null,
        removeAttribute: (k: string) => {
          attrs.delete(k)
          if (k === 'disabled') el.disabled = false
        },
        append: (...nodes: FakeNode[]) => { el.children.push(...nodes) },
        appendChild: (node: FakeNode) => { el.children.push(node); return node },
        replaceChildren: (...nodes: FakeNode[]) => {
          const hadFocus = Boolean(doc.activeElement && containsNode(el, doc.activeElement))
          el.children = [...nodes]
          if (hadFocus && !nodes.some(node => containsNode(node, doc.activeElement))) doc.activeElement = body
        },
        contains: (target: FakeNode | null) => containsNode(el, target),
        querySelector: (selector: string) => collect(el, node => matchSelector(node, selector))[0] ?? null,
        querySelectorAll: (selector: string) => collect(el, node => matchSelector(node, selector)),
        addEventListener: (type: string, fn: (event: { target: FakeElement }) => unknown) => {
          listeners.set(type, [...(listeners.get(type) ?? []), fn])
        },
        focus: () => { if (!isDisabled) doc.activeElement = el },
        dispatchEvent: (event: { type: string }) => {
          for (const fn of listeners.get(event.type) ?? []) void fn({ target: el })
          return true
        },
        dispatch: (type: string) => {
          for (const fn of listeners.get(type) ?? []) void fn({ target: el })
        },
      })
      Object.defineProperty(el, 'disabled', {
        enumerable: true,
        get: () => isDisabled,
        set: (next: boolean) => {
          isDisabled = next
          if (next && doc.activeElement === el) doc.activeElement = body
        },
      })
      Object.defineProperty(el, 'firstChild', {
        enumerable: true,
        get: () => el.children[0] ?? null,
      })
      return el
    },
    createTextNode: (text: string) => Object.assign(new FakeNode(), { textContent: text }),
    querySelectorAll: () => [],
  }
  return doc
}

test('createThemeActions and renderSettings keep state in the reducer, preserve focus, and re-translate errors on redraw', async () => {
  const prevDoc = globalThis.document
  const prevNode = globalThis.Node
  const prevCss = globalThis.CSS
  const prevLocale = getLocale()
  const mainDoc = fakeDoc()
  const childDoc = fakeDoc()
  globalThis.document = mainDoc as unknown as Document
  globalThis.Node = FakeNode as unknown as typeof Node
  globalThis.CSS = { escape: (value: string) => value } as unknown as typeof CSS
  setLocale('zh-CN')
  resetThemeDocumentsForTest()

  try {
    let appState = reduce(initialState, { type: 'settings_open' })
    const container = mainDoc.createElement('div')
    const events: { fire?: (state: ThemeState) => void } = {}
    let calls = 0
    let dispatches = 0
    let pending: { resolve: (state: ThemeState) => void, reject: (err: Error) => void } | null = null

    const redraw = () => {
      renderSettings(container as unknown as HTMLElement, appState.settings, appState.models, handlers, appState.diagnostics, appState.theme)
    }

    const actions = createThemeActions({
      api: {
        getTheme: async () => ({ theme: 'light', resolved: 'light' }),
        setTheme: (_next) => {
          calls++
          return new Promise<ThemeState>((resolve, reject) => {
            pending = { resolve, reject }
          })
        },
        onTheme: (cb) => {
          events.fire = cb
          return () => { delete events.fire }
        },
      },
      getState: () => appState,
      seed: (action) => {
        appState = reduce(appState, action)
      },
      dispatch: (action) => {
        dispatches++
        appState = reduce(appState, action)
        if (!updateThemeControl(container as unknown as HTMLElement, appState.theme)) redraw()
      },
      applyDocument: (resolved: ResolvedTheme) => applyThemeDocument(resolved),
      isFocused: () => {
        const active = mainDoc.activeElement as FakeElement | null
        return Boolean(active && active.tagName === 'SELECT' && active.name === 'theme')
      },
      canRestoreFocus: () => mainDoc.activeElement === null || mainDoc.activeElement === mainDoc.body || mainDoc.activeElement === mainDoc.documentElement,
      focusControl: () => { container.querySelector('select[name="theme"]')?.focus({ preventScroll: true }) },
    })

    const handlers = {
      setTheme: (next: ThemePreference) => actions.setTheme(next),
      saveKey: () => {},
      clearKey: () => {},
      setDeskIsland: () => {},
      resetDeskPlace: () => {},
      setOpenAtLogin: () => {},
      setWebSearch: () => {},
      openImagesFolder: () => {},
      moveImages: () => {},
      askClearImages: () => {},
      clearImages: () => {},
      cancelClearImages: () => {},
      openAddModel: () => {},
      editModel: () => {},
      removeModel: () => {},
      exportDiagnostics: () => {},
      openDiagnosticsFolder: () => {},
      clearDiagnostics: () => {},
      toggleDiagnosticsDebug: () => {},
    }

    // Initialization seeds state and document attribute without triggering dispatch/publishIsland before boot renders
    await actions.initialize()
    assert.equal(dispatches, 0)
    assert.equal(mainDoc.documentElement.dataset.theme, 'light')
    assert.deepEqual(appState.theme, { theme: 'light', resolved: 'light', pending: null, failed: false })
    redraw()

    registerThemeDocument(childDoc as unknown as Document)
    assert.equal(childDoc.documentElement.dataset.theme, 'light')

    const findHelp = () => container.querySelector('[data-theme-help]')!

    // Focus selector and switch to dark
    const firstSelect = container.querySelector('select[name="theme"]')!
    assert.equal(firstSelect.getAttribute('aria-describedby'), 'settings-theme-help')
    assert.equal(findHelp().getAttribute('aria-live'), 'polite')
    firstSelect.focus()
    assert.equal(mainDoc.activeElement, firstSelect)
    firstSelect.value = 'dark'
    firstSelect.dispatch('change')
    assert.equal(calls, 1)

    // State moved to pending and selector disabled with the pending choice
    const pendingSelect = container.querySelector('select[name="theme"]')!
    assert.equal(pendingSelect.disabled, true)
    assert.equal(pendingSelect.value, 'dark')

    // Another Settings full redraw while pending keeps disabled pending value and never resubmits
    redraw()
    const redrawnSelect = container.querySelector('select[name="theme"]')!
    assert.equal(redrawnSelect.disabled, true)
    assert.equal(redrawnSelect.value, 'dark')
    redrawnSelect.dispatch('change')
    assert.equal(calls, 1)

    // Reject save: reverts to light, shows appearance-specific Chinese alert, and restores keyboard focus to the live select
    const firstPending = pending as { resolve: (state: ThemeState) => void, reject: (err: Error) => void } | null
    firstPending?.reject(new Error('boom'))
    await Promise.resolve()
    await Promise.resolve()
    const failedSelect = container.querySelector('select[name="theme"]')!
    assert.equal(failedSelect.disabled, false)
    assert.equal(failedSelect.value, 'light')
    assert.equal(findHelp().getAttribute('aria-live'), 'polite')
    assert.equal(findHelp().getAttribute('data-error'), 'true')
    assert.equal(findHelp().textContent, t('settings.theme.save.failed'))
    assert.equal(mainDoc.activeElement, failedSelect)

    // Switching locale redraws Settings and renders the specific error in English
    setLocale('en')
    redraw()
    assert.equal(findHelp().getAttribute('aria-live'), 'polite')
    assert.equal(findHelp().getAttribute('data-error'), 'true')
    assert.equal(findHelp().textContent, t('settings.theme.save.failed'))

    // If user moves focus to an unnamed Settings button (e.g. Show API key) during save, completion preserves that button's focus
    const retrySelect = container.querySelector('select[name="theme"]')!
    retrySelect.focus()
    retrySelect.value = 'dark'
    retrySelect.dispatch('change')
    assert.equal(calls, 2)
    const showKeyButton = container.querySelector('button.btn-outline')!
    showKeyButton.focus()
    assert.equal(mainDoc.activeElement, showKeyButton)
    const secondPending = pending as { resolve: (state: ThemeState) => void, reject: (err: Error) => void } | null
    secondPending?.resolve({ theme: 'dark', resolved: 'dark' })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(mainDoc.documentElement.dataset.theme, 'dark')
    assert.equal(childDoc.documentElement.dataset.theme, 'dark')
    assert.equal(findHelp().getAttribute('aria-live'), 'polite')
    assert.equal(findHelp().getAttribute('data-error'), null)
    assert.equal(mainDoc.activeElement, showKeyButton, 'preserves focus on an unnamed Settings button')

    // Incoming preference broadcast updates state and both documents
    const beforePrefBroadcast = dispatches
    events.fire?.({ theme: 'system', resolved: 'light' })
    assert.equal(dispatches, beforePrefBroadcast + 1)
    assert.equal(mainDoc.documentElement.dataset.theme, 'light')
    assert.equal(childDoc.documentElement.dataset.theme, 'light')
    assert.equal(container.querySelector('select[name="theme"]')?.value, 'system')

    // OS dark/light flip under Follow system updates document and state without triggering a full-app render/dispatch
    const beforeOsFlip = dispatches
    events.fire?.({ theme: 'system', resolved: 'dark' })
    assert.equal(dispatches, beforeOsFlip)
    assert.equal(mainDoc.documentElement.dataset.theme, 'dark')
    assert.equal(childDoc.documentElement.dataset.theme, 'dark')
    assert.equal(appState.theme.resolved, 'dark')

    // If a save fails while Follow system is saved, a subsequent OS appearance flip keeps the error visible
    const systemSelect = container.querySelector('select[name="theme"]')!
    systemSelect.value = 'light'
    systemSelect.dispatch('change')
    const thirdPending = pending as { resolve: (state: ThemeState) => void, reject: (err: Error) => void } | null
    thirdPending?.reject(new Error('disk full'))
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(appState.theme.failed, true)
    assert.equal(findHelp().getAttribute('data-error'), 'true')
    assert.equal(findHelp().textContent, t('settings.theme.save.failed'))
    const beforeFailedOsFlip = dispatches
    events.fire?.({ theme: 'system', resolved: 'light' })
    assert.equal(dispatches, beforeFailedOsFlip)
    assert.equal(mainDoc.documentElement.dataset.theme, 'light')
    assert.equal(appState.theme.resolved, 'light')
    assert.equal(appState.theme.failed, true)
    assert.equal(findHelp().getAttribute('data-error'), 'true')
    assert.equal(findHelp().textContent, t('settings.theme.save.failed'))

    // Deferred IME rebuild picks up a theme save that finished during composition
    const keyField = container.querySelector('[name="api-key"]')!
    keyField.focus()
    container.dispatch('compositionstart')
    renderSettings(container as unknown as HTMLElement, appState.settings, appState.models, handlers, appState.diagnostics, { theme: 'system', resolved: 'light', pending: 'dark', failed: false })
    assert.equal(updateThemeControl(container as unknown as HTMLElement, { theme: 'dark', resolved: 'dark', pending: null, failed: false }), true)
    container.dispatch('compositionend')
    await new Promise(resolve => setTimeout(resolve, 10))
    const afterCompositionSelect = container.querySelector('select[name="theme"]')!
    assert.equal(afterCompositionSelect.disabled, false)
    assert.equal(afterCompositionSelect.value, 'dark')
  } finally {
    setLocale(prevLocale)
    resetThemeDocumentsForTest()
    globalThis.document = prevDoc
    globalThis.Node = prevNode
    globalThis.CSS = prevCss
  }
})

test('failed theme initialization still lets later broadcasts dispatch UI updates', async () => {
  let appState: State = initialState
  let dispatched = 0
  const applied: ResolvedTheme[] = []
  const events: { fire?: (state: ThemeState) => void } = {}
  const actions = createThemeActions({
    api: {
      getTheme: async () => { throw new Error('ipc unavailable') },
      setTheme: async (theme) => ({ theme, resolved: theme === 'light' ? 'light' : 'dark' }),
      onTheme: (cb) => {
        events.fire = cb
        return () => { delete events.fire }
      },
    },
    getState: () => appState,
    seed: (action) => { appState = reduce(appState, action) },
    dispatch: (action) => { dispatched++; appState = reduce(appState, action) },
    applyDocument: (resolved) => { applied.push(resolved) },
  })

  await assert.rejects(() => actions.initialize(), /ipc unavailable/)
  events.fire?.({ theme: 'light', resolved: 'light' })
  assert.equal(dispatched, 1)
  assert.deepEqual(applied, ['light'])
  assert.equal(appState.theme.theme, 'light')
})

test('initializeDeskTheme follows read-only theme broadcasts without needing write access', async () => {
  const prevDoc = globalThis.document
  const deskDoc = fakeDoc()
  globalThis.document = deskDoc as unknown as Document
  resetThemeDocumentsForTest()
  try {
    const events: { fire?: (state: ThemeState) => void } = {}
    await initializeDeskTheme({
      getTheme: async () => ({ theme: 'light', resolved: 'light' }),
      onTheme: (cb) => {
        events.fire = cb
        return () => { delete events.fire }
      },
    })
    assert.equal(deskDoc.documentElement.dataset.theme, 'light')
    events.fire?.({ theme: 'dark', resolved: 'dark' })
    assert.equal(deskDoc.documentElement.dataset.theme, 'dark')
  } finally {
    resetThemeDocumentsForTest()
    globalThis.document = prevDoc
  }
})
