import { h, label } from './dom.js'

function providerItem(provider, models, handlers) {
  return h('li', { class: 'ext-item', 'data-name': provider.name },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: provider.name }),
        h('span', { class: 'badge', text: models.protocols[provider.api] ?? provider.api })),
      h('span', { class: 'ext-detail mono ellipsis', title: provider.baseURL, text: provider.baseURL }),
      h('span', { class: 'ext-detail', text: `模型：${provider.models.join('、')}` }),
      h('span', { class: 'ext-detail', text: provider.keyHint ? `key 已加密保存：${provider.keyHint}` : '不使用 key' })),
    h('button', {
      class: 'btn btn-outline btn-small', type: 'button', disabled: models.busy, text: '删除',
      'aria-label': `删除模型提供方 ${provider.name}`, onClick: () => handlers.removeProvider(provider),
    }))
}

function textField(name, title, hint, { multiline = false, secret = false } = {}) {
  const props = { class: 'field', name, placeholder: hint, 'aria-label': title, spellcheck: 'false', autocomplete: 'off' }
  const input = multiline ? h('textarea', { ...props, rows: 2 }) : h('input', { ...props, type: secret ? 'password' : 'text' })
  return h('label', { class: 'intro-item' }, label(title), input)
}

function providerForm(models, handlers) {
  const form = h('form', {
    class: 'ext-form',
    onSubmit: (event) => {
      event.preventDefault()
      const value = (name) => form.elements.namedItem(name)?.value ?? ''
      handlers.addProvider({
        name: value('model-name'), api: value('model-api'), baseURL: value('model-url'), models: value('model-ids'), key: value('model-key'),
      })
    },
  },
  h('div', { class: 'intro-pair' },
    textField('model-name', '名称', '例如 Kimi、公司网关'),
    h('label', { class: 'intro-item' }, label('接口协议'), h('select', { class: 'field', name: 'model-api', 'aria-label': '接口协议' },
      Object.entries(models.protocols).map(([value, text]) => h('option', { value, text }))))),
  textField('model-url', '接口地址（baseURL）', 'https://api.example.com/v1'),
  textField('model-ids', '模型 ID（每行一个）', 'kimi-k2.6\nkimi-k2.7-code', { multiline: true }),
  textField('model-key', 'API key（本地模型可不填）', 'sk-…', { secret: true }),
  h('p', { class: 'help', text: 'key 加密保存，只显示末 4 位。添加后会重新连接，当前对话保留。' }),
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: models.busy, text: models.busy ? '连接中…' : '添加并连接' }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '取消', onClick: () => handlers.toggleAddProvider(false) })))
  return form
}

/** The 模型 part of settings: providers besides DeepSeek, each speaking one of the protocols dsh supports. */
export function modelsSection(models, handlers) {
  if (!models.loaded) return h('section', { class: 'ext' }, label('模型'), h('p', { class: 'help', text: '读取中…' }))
  return h('section', { class: 'ext', 'aria-label': '模型' },
    label('模型'),
    h('div', { class: 'ext-group' },
      h('div', { class: 'row-between' },
        h('h3', { class: 'profile-heading', text: '其他模型' }),
        models.adding ? null : h('button', {
          class: 'btn btn-outline btn-small', type: 'button', id: 'add-model', text: '添加', onClick: () => handlers.toggleAddProvider(true),
        })),
      models.providers.length
        ? h('ul', { class: 'ext-list' }, models.providers.map((provider) => providerItem(provider, models, handlers)))
        : h('p', { class: 'help', text: '可以接入 OpenAI 兼容或 Anthropic 兼容接口的模型，添加后在输入框左下角选择。' }),
      models.adding ? providerForm(models, handlers) : null),
    models.error ? h('p', { class: 'form-error', role: 'alert', text: models.error }) : null,
    models.notice ? h('p', { class: 'form-notice', role: 'status', text: models.notice }) : null)
}
