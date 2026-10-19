import { h, keepingInput, label } from './dom.js'
import { extensionsSection } from './extensions.js'
import { icon } from './icons.js'

const SOURCE_COPY = { saved: '已保存在本机', env: '来自环境变量 DEEPSEEK_API_KEY' }

function keyStatus(settings) {
  return h('div', { class: 'key-status', 'data-has-key': String(settings.hasKey) },
    h('div', { class: 'key-status-copy' },
      label(settings.hasKey ? 'KEY · ACTIVE' : 'KEY · NOT SET'),
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
  h('label', { class: 'label', for: 'settings-key', text: 'DEEPSEEK API KEY' }),
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

/**
 * Modal settings panel: the key, then MCP servers and skills. Re-rendered only when its slices change,
 * and typed text survives a re-render.
 */
export function renderSettings(container, settings, extensions, handlers, { connected }) {
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
      label('05 / SETTINGS'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭设置', onClick: handlers.closeSettings }, icon('close', 16))),
    h('h2', { class: 'settings-title', id: 'settings-title', text: '设置' }),
    keyStatus(settings),
    form,
    feedback(settings),
    h('p', {
      class: 'help',
      id: 'settings-help',
      text: 'key 用系统钥匙串（Electron safeStorage）加密后保存在本机，界面只显示末 4 位。保存后会用新 key 重新连接 DeepSeek Harness，当前对话会清空。',
    }),
    extensionsSection(extensions, handlers, { connected })))))
  if (isFirstShow && !input.disabled) input.focus()
}
