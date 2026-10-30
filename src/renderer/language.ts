import { setLocale, type LanguageState, type Language } from '../shared/i18n/locale.ts'
import { t, translate } from '../shared/i18n/translate.ts'

interface LanguageApi {
  getLanguage: () => Promise<LanguageState>
  setLanguage: (language: Language) => Promise<LanguageState>
  onLanguage: (callback: (state: LanguageState) => void) => () => void
}
let state: LanguageState = { language: 'system', locale: 'zh-CN' }
let bridge: LanguageApi | null = null

const extraDocuments = new Set<Document>()
let observeDocument: ((doc: Document) => void) | null = null
const languageDocuments = () => [document, ...extraDocuments]

/** The isolated search field still shares language, drafts, focus and IME semantics with its parent. */
export function registerLanguageDocument(doc: Document): void {
  if (extraDocuments.has(doc)) return
  extraDocuments.add(doc)
  observeDocument?.(doc)
  applyDocument(doc, state)
}

function applyDocument(doc: Document, next: LanguageState): void {
  doc.documentElement.lang = next.locale
  for (const el of doc.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = translate(el.dataset.i18n ?? '')
  }
  for (const attr of ['aria-label', 'title', 'placeholder']) {
    for (const el of doc.querySelectorAll<HTMLElement>(`[data-i18n-${attr}]`)) {
      const text = translate(el.getAttribute(`data-i18n-${attr}`) ?? '')
      el.setAttribute(attr, text)
      if (attr === 'placeholder') el.dataset.placeholder = text
    }
  }
}

function apply(next: LanguageState): void {
  state = next
  setLocale(next.locale)
  for (const doc of languageDocuments()) applyDocument(doc, next)
}

export async function initializeLanguage(api: LanguageApi, redraw: () => void): Promise<void> {
  bridge = api
  // Register before fetching so an update during initialization cannot be lost.
  let received = false
  const update = (next: LanguageState) => {
    const fields = languageDocuments().flatMap(doc => [...doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select')])
      .filter(field => (field.id || field.name) && field.name !== 'language')
      .map(field => ({ field, value: field.value, checked: field instanceof HTMLInputElement ? field.checked : false,
        focused: field === field.ownerDocument.activeElement,
        start: field instanceof HTMLSelectElement ? null : field.selectionStart,
        end: field instanceof HTMLSelectElement ? null : field.selectionEnd,
      }))
    const scrolls = languageDocuments().flatMap(doc => [...doc.querySelectorAll<HTMLElement>('[id]')]).filter(el => el.scrollTop || el.scrollLeft)
      .map(el => ({ doc: el.ownerDocument, id: el.id, top: el.scrollTop, left: el.scrollLeft }))
    apply(next)
    redraw()
    for (const saved of fields) {
      const field = saved.field.isConnected ? saved.field : saved.field.ownerDocument.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        saved.field.id ? `#${CSS.escape(saved.field.id)}` : `[name="${CSS.escape(saved.field.name)}"]`)
      if (!field) continue
      field.value = saved.value
      if (field instanceof HTMLInputElement) field.checked = saved.checked
      if (saved.focused) {
        field.focus({ preventScroll: true })
        if (!(field instanceof HTMLSelectElement) && saved.start !== null) field.setSelectionRange(saved.start, saved.end)
      }
    }
    for (const saved of scrolls) {
      const el = saved.doc.getElementById(saved.id)
      if (el) { el.scrollTop = saved.top; el.scrollLeft = saved.left }
    }
  }
  const composing = new Set<Document>()
  let pending: LanguageState | null = null
  observeDocument = doc => {
    doc.addEventListener('compositionstart', () => { composing.add(doc) })
    doc.addEventListener('compositionend', () => {
      composing.delete(doc)
      if (!composing.size && pending) { const next = pending; pending = null; update(next) }
    })
  }
  languageDocuments().forEach(observeDocument)
  api.onLanguage((next) => { received = true; if (composing.size) pending = next; else update(next) })
  try {
    const initial = await api.getLanguage()
    if (!received) apply(initial)
  } finally {
    delete document.documentElement.dataset.languageLoading
  }
}

/** A stable control; changing language never reloads a page or reconnects the agent. */
export function languageControl(): HTMLElement {
  const row = document.createElement('label')
  row.className = 'pref-row'
  const copy = document.createElement('span')
  copy.className = 'pref-copy'
  const title = document.createElement('span')
  title.className = 'profile-heading'
  title.textContent = t('settings.language.label')
  const help = document.createElement('span')
  help.className = 'help'
  help.textContent = t('settings.language.help')
  copy.append(title, help)
  const select = document.createElement('select')
  select.className = 'field'
  select.name = 'language'
  select.setAttribute('aria-label', t('settings.language.label'))
  for (const [value, label] of [['system', t('settings.language.system')], ['zh-CN', '简体中文'], ['en', 'English']]) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = label
    select.append(option)
  }
  select.value = state.language
  select.dataset.version = state.language
  select.addEventListener('change', async () => {
    if (!bridge) return
    select.disabled = true
    try { apply(await bridge.setLanguage(select.value as Language)) }
    catch { select.value = state.language; help.textContent = t('errors.generic'); help.setAttribute('role', 'alert') }
    finally { select.disabled = false }
  })
  row.append(copy, select)
  return row
}
