import { h, keepingInput, label } from './dom.js'
import { extensionsSection } from './extensions.js'
import { icon } from './icons.js'
import { modelsSection } from './models.js'

const SOURCE_COPY = { saved: '已保存在本机', env: '来自环境变量 DEEPSEEK_API_KEY' }

function keyStatus(settings) {
  return h('div', { class: 'key-status', 'data-has-key': String(settings.hasKey) },
    h('div', { class: 'key-status-copy' },
      label('DeepSeek key'),
      h('span', { class: 'key-status-text', text: settings.hasKey ? SOURCE_COPY[settings.source] : '还没有填写 key' })),
    h('span', { class: 'key-hint', text: settings.hasKey ? settings.keyHint : '----' }))
}

function keyForm(settings, handlers) {
  const input = h('input', {
    id: 'settings-key',
    class: 'field',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: settings.hasKey ? '输入新的 key 以替换' : 'sk-…',
    'aria-describedby': 'settings-help',
    disabled: settings.busy || !settings.encryptionAvailable,
  })
  const toggle = h('button', {
    type: 'button',
    class: 'btn btn-outline btn-field',
    text: '显示',
    onClick: () => {
      const reveal = input.type === 'password'
      input.type = reveal ? 'text' : 'password'
      toggle.textContent = reveal ? '隐藏' : '显示'
    },
  })
  const form = h('form', {
    class: 'settings-form',
    onSubmit: (event) => {
      event.preventDefault()
      handlers.saveKey(input.value)
    },
  },
  h('label', { class: 'label', for: 'settings-key', text: settings.hasKey ? '换一个 key' : 'DeepSeek API key' }),
  h('div', { class: 'field-row' }, input, toggle),
  h('div', { class: 'settings-actions' },
    h('button', {
      type: 'submit',
      class: 'btn btn-accent',
      disabled: settings.busy || !settings.encryptionAvailable,
      text: settings.busy ? '连接中…' : '保存并连接',
    }),
    settings.source === 'saved'
      ? h('button', { type: 'button', class: 'btn btn-outline btn-field', disabled: settings.busy, text: '清除已保存的 key', onClick: handlers.clearKey })
      : null))
  return { form, input }
}

function feedback(settings) {
  if (!settings.encryptionAvailable) return h('p', { class: 'form-error', role: 'alert', text: '系统钥匙串不可用，暂时无法安全保存 key。可以改用环境变量 DEEPSEEK_API_KEY 启动。' })
  if (settings.error) return h('p', { class: 'form-error', role: 'alert', text: settings.error })
  if (settings.notice) return h('p', { class: 'form-notice', role: 'status', text: settings.notice })
  return null
}

/** The shortcut as the keyboard of this platform writes it. */
const shortcutKeys = () => (document.documentElement.dataset.platform === 'darwin' ? '⌘ ⇧ Space' : 'Ctrl + Shift + Space')

/** The shortcut works with the island switched off too; another app may already hold it. */
function shortcutLine(settings) {
  if (!settings.shortcut) return null
  return settings.shortcut.held
    ? h('span', { class: 'help', text: `在任何程序里按 ${shortcutKeys()}，在岛上问 Viva。` })
    : h('span', { class: 'help form-error', text: `快捷键 ${shortcutKeys()} 被别的程序占用了，暂时不能在岛上提问。` })
}

/** The desktop island can be turned off (it is on by default) and put back at the top centre. */
function deskSection(settings, handlers) {
  return h('section', { class: 'ext', 'aria-label': '桌面岛' },
    h('label', { class: 'pref-row' },
      h('span', { class: 'pref-copy' },
        h('span', { class: 'profile-heading', text: '桌面岛' }),
        h('span', { class: 'help', text: '关闭窗口后 Viva 留在托盘里，桌面岛显示助手在做什么，需要你确认时可以直接在上面处理。可以拖到屏幕任意位置。' }),
        shortcutLine(settings)),
      h('input', {
        type: 'checkbox', class: 'switch', name: 'desk-island', checked: settings.deskIsland !== false, 'aria-label': '桌面岛',
        onChange: (event) => handlers.setDeskIsland(event.target.checked),
      })),
    h('button', { type: 'button', class: 'btn btn-outline desk-reset', text: '放回顶部正中', onClick: () => handlers.resetDeskPlace() }))
}

/**
 * Modal settings panel: the DeepSeek key, other models, the desktop island, then MCP servers and skills.
 * Re-rendered only when its slices change, and typed text survives a re-render.
 */
export function renderSettings(container, settings, models, extensions, handlers, { connected }) {
  if (!settings.open) {
    container.replaceChildren()
    return
  }
  const isFirstShow = !container.firstChild
  const { form, input } = keyForm(settings, handlers)
  keepingInput(container, () => container.replaceChildren(h('div', {
    class: 'overlay',
    onMousedown: (event) => {
      if (event.target === event.currentTarget) handlers.closeSettings()
    },
  },
  h('section', { class: 'settings', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
    h('div', { class: 'row-between' },
      h('h2', { class: 'settings-title', id: 'settings-title', text: '设置' }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭设置', onClick: handlers.closeSettings }, icon('close', 16))),
    keyStatus(settings),
    form,
    feedback(settings),
    h('p', {
      class: 'help',
      id: 'settings-help',
      text: '加密保存在本机，只显示末 4 位。换 key 会重新连接，当前对话清空；用其他模型时可以不填。',
    }),
    modelsSection(models, handlers),
    deskSection(settings, handlers),
    extensionsSection(extensions, handlers, { connected })))))
  if (isFirstShow && !input.disabled) input.focus()
}
