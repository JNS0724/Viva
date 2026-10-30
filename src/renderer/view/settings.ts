import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { languageControl } from '../language.ts'
import { formatSize } from '../selectors.ts'
import { h, keepingInput, label } from './dom.ts'
import { extensionsSection } from './extensions.ts'
import { modelsSection } from './models.ts'
import { sourcesSection } from './sources.ts'
import { prepareSection } from './prepare-settings.ts'

/**
 * The 设置 page's part of the state (state.ts), with what only comes once the settings are read (settings:get):
 * whether the desktop island is on, and whether the ask shortcut is held.
 */
type Settings = State['settings'] & { deskIsland?: boolean, shortcut?: { held: boolean } | null, openAtLogin?: { on: boolean, available: boolean } }

let SOURCE_COPY: Readonly<Record<string, string>> = { saved: t("settings.saved.on.this.computer"), env: t("settings.from.deepseek.api.key.environment.variable") }

function keyStatus(settings: Settings) {
  return h('div', { class: 'key-status', 'data-has-key': String(settings.hasKey) },
    h('div', { class: 'key-status-copy' },
      label('DeepSeek key'),
      h('span', { class: 'key-status-text', text: settings.hasKey ? SOURCE_COPY[settings.source] : t("settings.no.key.entered.yet") })),
    h('span', { class: 'key-hint', text: settings.hasKey ? settings.keyHint : '----' }))
}

function keyForm(settings: Settings, handlers: Handlers) {
  const input = h('input', {
    id: 'settings-key', name: 'api-key',
    class: 'field',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: settings.hasKey ? t("settings.enter.a.new.key.to.replace") : 'sk-…',
    'aria-describedby': 'settings-help',
    disabled: settings.busy || !settings.encryptionAvailable,
  })
  const toggle = h('button', {
    type: 'button',
    class: 'btn btn-outline btn-field',
    text: t("settings.show"),
    onClick: () => {
      const reveal = input.type === 'password'
      input.type = reveal ? 'text' : 'password'
      toggle.textContent = reveal ? t("settings.hide") : t("settings.show")
    },
  })
  const form = h('form', {
    class: 'settings-form',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.saveKey(input.value)
    },
  },
  h('label', { class: 'label', for: 'settings-key', text: settings.hasKey ? t("settings.replace.key") : 'DeepSeek API key' }),
  h('div', { class: 'field-row' }, input, toggle),
  h('div', { class: 'settings-actions' },
    h('button', {
      type: 'submit',
      class: 'btn btn-accent',
      disabled: settings.busy || !settings.encryptionAvailable,
      text: settings.busy ? t("selectors.connecting") : t("settings.save.and.connect"),
    }),
    settings.source === 'saved'
      ? h('button', { type: 'button', class: 'btn btn-outline btn-field', disabled: settings.busy, text: t("settings.clear.saved.key"), onClick: handlers.clearKey })
      : null))
  return { form, input }
}

function feedback(settings: Settings) {
  if (!settings.encryptionAvailable) return h('p', { class: 'form-error', role: 'alert', text: t("settings.the.system.keychain.is.unavailable.so.the") })
  if (settings.error) return h('p', { class: 'form-error', role: 'alert', text: settings.error })
  if (settings.notice) return h('p', { class: 'form-notice', role: 'status', text: settings.notice })
  return null
}

/** The shortcut as the keyboard of this platform writes it. */
const shortcutKeys = () => (document.documentElement.dataset.platform === 'darwin' ? '⌘ ⇧ Space' : 'Ctrl + Shift + Space')

/** The shortcut works with the island switched off too; another app may already hold it. */
function shortcutLine(settings: Settings) {
  if (!settings.shortcut) return null
  return settings.shortcut.held
    ? h('span', { class: 'help', text: t("settings.press.in.any.app.to.ask.viva", { value1: shortcutKeys() }) })
    : h('span', { class: 'help form-error', text: t("settings.the.shortcut.is.used.by.another.app", { value1: shortcutKeys() }) })
}

/** The desktop island can be turned off (it is on by default) and put back at the top centre. */
function deskSection(settings: Settings, handlers: Handlers) {
  return h('section', { class: 'ext', 'aria-label': t("settings.desktop.island") },
    h('label', { class: 'pref-row' },
      h('span', { class: 'pref-copy' },
        h('span', { class: 'profile-heading', text: t("settings.desktop.island") }),
        h('span', { class: 'help', text: t("settings.after.closing.the.window.viva.stays.in") }),
        shortcutLine(settings)),
      h('input', {
        type: 'checkbox', class: 'switch', name: 'desk-island', checked: settings.deskIsland !== false, 'aria-label': t("settings.desktop.island"),
        onChange: (event: Event) => handlers.setDeskIsland((event.target as HTMLInputElement).checked),
      })),
    h('button', { type: 'button', class: 'btn btn-outline desk-reset', text: t("settings.move.to.top.center"), onClick: () => handlers.resetDeskPlace() }),
    openAtLoginRow(settings, handlers))
}

/** 开机启动: off by default; started so, Viva waits in the tray, so reminders reach the user without opening it. */
function openAtLoginRow(settings: Settings, handlers: Handlers) {
  const login = settings.openAtLogin
  if (!login) return null
  return h('label', { class: 'pref-row' },
    h('span', { class: 'pref-copy' },
      h('span', { class: 'profile-heading', text: t("settings.start.at.login") }),
      h('span', { class: 'help', text: login.available
        ? t("settings.viva.starts.in.the.tray.without.opening")
        : t("settings.start.at.login.is.available.in.the") })),
    h('input', {
      type: 'checkbox', class: 'switch', name: 'open-at-login', checked: login.on, disabled: !login.available, 'aria-label': t("settings.start.at.login"),
      'data-version': String(login.on),
      onChange: (event: Event) => handlers.setOpenAtLogin((event.target as HTMLInputElement).checked),
    }))
}

let CLEAR_WARNING = t("settings.after.clearing.images.in.older.conversations.show")

/** 贴过的图片: where they are and how much they take; open the folder, move it, or empty it (after a yes). */
function imagesSection(settings: Settings, handlers: Handlers) {
  const usage = settings.images
  if (!usage) return null
  const busy = settings.imagesBusy
  const actions = settings.imagesConfirm
    ? h('div', { class: 'images-confirm', role: 'alert' },
      h('span', { class: 'help', text: CLEAR_WARNING }),
      h('div', { class: 'settings-actions' },
        h('button', { type: 'button', class: 'btn btn-outline images-clear', text: t("settings.clear"), onClick: () => handlers.clearImages() }),
        h('button', { type: 'button', class: 'btn btn-outline', text: t("extensions.cancel"), onClick: () => handlers.cancelClearImages() })))
    : h('div', { class: 'settings-actions' },
      h('button', { type: 'button', class: 'btn btn-outline', text: t("settings.open.folder"), disabled: busy, onClick: () => handlers.openImagesFolder() }),
      h('button', { type: 'button', class: 'btn btn-outline', text: busy ? t("extensions.working") : t("settings.change.location"), disabled: busy, onClick: () => handlers.moveImages() }),
      h('button', { type: 'button', class: 'btn btn-outline', text: t("settings.clear"), disabled: busy || usage.bytes === 0, onClick: () => handlers.askClearImages() }))
  return h('section', { class: 'ext', 'aria-label': t("settings.pasted.images") },
    h('span', { class: 'pref-copy' },
      h('span', { class: 'profile-heading', text: t("settings.pasted.images") }),
      h('span', { class: 'help', text: t("settings.images", { count: usage.count, value2: formatSize(usage.bytes) }) }),
      h('span', { class: 'help mono images-dir', title: usage.dir, text: usage.dir })),
    actions)
}

/**
 * The 设置 page (view/hub.js): the DeepSeek key, other models, the desktop island, message sources, then MCP servers and skills.
 * Re-rendered only when its slices change, and typed text survives a re-render.
 */
export function renderSettings(container: HTMLElement, settings: Settings, models: State['models'], extensions: State['extensions'], sources: State['sources'],
  followups: State['followups'], handlers: Handlers, { connected }: { connected: boolean }) {
  if (!settings.open) {
    container.replaceChildren()
    return
  }
  const isFirstShow = !container.firstChild
  const { form, input } = keyForm(settings, handlers)
  keepingInput(container, () => container.replaceChildren(
    h('section', { class: 'settings', 'aria-labelledby': 'settings-title' },
      h('h2', { class: 'settings-title', id: 'settings-title', text: t("settings.settings") }),
      languageControl(),
      keyStatus(settings),
      form,
      feedback(settings),
      h('p', {
        class: 'help',
        id: 'settings-help',
        text: t("settings.encrypted.on.this.computer.only.the.last"),
      }),
      modelsSection(models, handlers),
      deskSection(settings, handlers),
      imagesSection(settings, handlers),
      h('section', { class: 'ext', 'aria-label': t("handoff.privacy.title") },
        h('span', { class: 'profile-heading', text: t("handoff.privacy.title") }),
        h('p', { class: 'help', text: t("handoff.privacy.scope") })),
      prepareSection(followups, handlers),
      sourcesSection(sources, handlers),
      extensionsSection(extensions, handlers, { connected }))))
  if (isFirstShow && !input.disabled) input.focus()
}

onLocaleChange(() => {
  SOURCE_COPY = { saved: t("settings.saved.on.this.computer"), env: t("settings.from.deepseek.api.key.environment.variable") }
  CLEAR_WARNING = t("settings.after.clearing.images.in.older.conversations.show")
})
