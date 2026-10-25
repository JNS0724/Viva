import { formatListTime, formatSize } from '../selectors.ts'
import { h, label } from './dom.ts'

/** The 消息源 part of the state (source-state.ts). */
type Sources = State['sources']
/** A field its viva-source.json declares (source-contract.ts ConfigField), with its key. */
type Field = { key: string, type: string, title: string, help?: string, required?: boolean, values?: readonly string[], default?: unknown }
/** A source as settings sees it (sources-ipc.ts sourceView): no secret values, only which are saved. */
type Source = {
  id: string, name: string, kind: string, reads: string, command: string, fields: readonly Field[], running: boolean,
  settings: { enabled: boolean, everyMinutes: number, values: Readonly<Record<string, unknown>>, savedSecrets: readonly string[], missing: readonly string[] },
  health: { lastOkAt: number | null, lastReceivedAt: number | null, lastError: string | null, lastErrorAt: number | null, failures: number, dropped: readonly string[], count: number },
  latest: ReadonlyArray<{ id: string, at: number, from: string, title: string }>,
}

/** A folder chosen to install (sources-ipc.ts pendingView). */
type Pending = { id: string, name: string, kind: string, reads: string, command: string, fields: readonly string[], from: string, files: number, bytes: number, replaces: boolean }

const KIND_LABEL: Readonly<Record<string, string>> = { mail: '邮件', alert: '告警', chat: '通讯', other: '其他' }
const SOURCE_DOCS_HINT = '消息源把邮件、告警、通讯工具里的新消息交给 Viva。每个消息源是一个文件夹，里面有 viva-source.json；'
  + '点「安装消息源…」选择文件夹。它读到的内容只当数据，碰不到助手的工具。'
const TRUST_WARNING = '消息源程序以你的权限运行，能读你的文件、能联网。只安装信得过的来源。'

const smallButton = (text: string, extra: Record<string, unknown>) => h('button', { class: 'btn btn-outline btn-small', type: 'button', text, ...extra })

/** One line on how the source is doing: off, failing, or when it last read and how much it has. */
function statusLine(source: Source) {
  const { settings, health } = source
  if (!settings.enabled) return { tone: 'off', text: settings.missing.length ? `未打开 · 还要填：${settings.missing.join('、')}` : '未打开' }
  if (source.running) return { tone: 'ok', text: '正在拉取…' }
  if (health.lastError) return { tone: 'off', text: `出错：${health.lastError}${health.failures > 1 ? `（连续 ${health.failures} 次，稍后再试）` : ''}` }
  const last = health.lastOkAt ? ` · 上次 ${formatListTime(health.lastOkAt)}` : ''
  return { tone: 'ok', text: `每 ${settings.everyMinutes} 分钟${last} · 存着 ${health.count} 条` }
}

function latestList(source: Source) {
  if (!source.settings.enabled || !source.latest.length) return null
  return h('ul', { class: 'source-latest', 'aria-label': `${source.name} 最近收到的` },
    source.latest.map((m) => h('li', null,
      h('span', { class: 'source-latest-time mono', text: formatListTime(m.at) }),
      m.from ? h('span', { class: 'source-latest-from', text: m.from }) : null,
      h('span', { class: 'source-latest-title ellipsis', title: m.title, text: m.title }))))
}

function sourceItem(source: Source, sources: Sources, handlers: Handlers) {
  const status = statusLine(source)
  const busy = sources.busy !== null
  return h('li', { class: 'ext-item source-item', 'data-id': source.id },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: source.name }),
        h('span', { class: 'badge', text: KIND_LABEL[source.kind] ?? source.kind }),
        h('span', { class: 'ext-status', 'data-tone': status.tone, text: status.text })),
      h('span', { class: 'ext-detail', text: `会读：${source.reads}` }),
      source.health.dropped.length ? h('span', { class: 'ext-detail', text: `上次有 ${source.health.dropped.length} 条格式不对，没收：${source.health.dropped[0]}` }) : null,
      latestList(source)),
    h('div', { class: 'ext-actions' },
      source.settings.enabled ? smallButton(sources.busy === source.id ? '拉取中…' : '现在拉一次', {
        disabled: busy || source.running, 'aria-label': `现在拉一次 ${source.name}`, onClick: () => handlers.pollSourceNow(source.id),
      }) : null,
      smallButton('设置', { disabled: busy, 'aria-label': `设置消息源 ${source.name}`, onClick: () => handlers.editSource(source.id) }),
      smallButton('移除', { disabled: busy || source.running, 'aria-label': `移除消息源 ${source.name}`, onClick: () => handlers.removeSource(source.id, source.name) }),
      h('input', {
        // Unnamed, so a re-render shows whether it is on rather than what was last clicked (a refused switch-on).
        type: 'checkbox', class: 'switch source-switch', checked: source.settings.enabled, disabled: busy, 'aria-label': `打开消息源 ${source.name}`,
        onChange: (event: Event) => handlers.toggleSource(source.id, (event.target as HTMLInputElement).checked),
      })))
}

/** The input for one declared field; a secret shows whether it is saved and is never filled in. */
function fieldInput(field: Field, source: Source, version: string) {
  const name = `source-field-${field.key}`
  const value = source.settings.values[field.key] ?? field.default
  const common = { name, 'data-version': version, 'aria-label': field.title }
  switch (field.type) {
    case 'boolean':
      return h('input', { ...common, type: 'checkbox', class: 'switch', checked: value === true })
    case 'enum':
      return h('select', { ...common, class: 'field' },
        (field.values ?? []).map((option) => h('option', { value: option, selected: option === value, text: option })))
    case 'secret': {
      const saved = source.settings.savedSecrets.includes(field.key)
      return h('input', { ...common, type: 'password', class: 'field', autocomplete: 'off', spellcheck: 'false', placeholder: saved ? '保持不变（已加密保存）· 填写则替换' : '' })
    }
    case 'number':
      return h('input', { ...common, type: 'number', class: 'field', value: value === undefined ? '' : String(value) })
    default:
      return h('input', { ...common, type: 'text', class: 'field mono', autocomplete: 'off', spellcheck: 'false', value: value === undefined ? '' : String(value) })
  }
}

/** What the form holds, as the main process takes it: numbers as numbers, checkboxes as true or false. */
function formValues(form: HTMLFormElement, source: Source) {
  const data = new FormData(form)
  const values: Record<string, unknown> = {}
  for (const field of source.fields) {
    const raw = data.get(`source-field-${field.key}`)
    if (field.type === 'boolean') values[field.key] = raw === 'on'
    else if (typeof raw !== 'string') continue
    else if (field.type === 'number') values[field.key] = raw.trim() === '' ? undefined : Number(raw)
    else values[field.key] = raw
  }
  const every = Number(data.get('source-every'))
  return { everyMinutes: Number.isFinite(every) && every > 0 ? every : undefined, values }
}

const formRow = (title: string, field: HTMLElement, help?: string) =>
  h('div', { class: 'ext-edit-row' }, label(title), h('div', { class: 'source-field' }, field, help ? h('span', { class: 'help', text: help }) : null))

function checkLine(sources: Sources, source: Source) {
  const check = sources.check
  if (!check || check.id !== source.id) return null
  return check.ok
    ? h('p', { class: 'form-notice', role: 'status', text: '连接正常' })
    : h('p', { class: 'form-error', role: 'alert', text: `连不上：${check.problem}` })
}

/** The source's settings in place: every field its viva-source.json declares, and how often to read. */
function editItem(source: Source, sources: Sources, handlers: Handlers) {
  const version = `${source.id}:${source.settings.savedSecrets.join(',')}`
  const busy = sources.busy !== null
  const form = h('form', {
    class: 'ext-edit', 'aria-label': `设置消息源 ${source.name}`,
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.saveSource(source.id, formValues(event.currentTarget as HTMLFormElement, source))
    },
  },
  h('div', { class: 'ext-edit-head' }, h('span', { class: 'ext-name', text: `设置「${source.name}」` })),
  source.fields.map((field) => formRow(field.required ? `${field.title} *` : field.title, fieldInput(field, source, version), field.help)),
  formRow('多久拉一次', h('input', {
    class: 'field', type: 'number', name: 'source-every', min: 1, max: 1440, step: 1, 'data-version': version,
    value: String(source.settings.everyMinutes), 'aria-label': '多久拉一次（分钟）',
  }), '分钟'),
  h('p', { class: 'ext-detail mono ellipsis', title: source.command, text: `运行：${source.command}` }),
  checkLine(sources, source),
  h('div', { class: 'ext-edit-foot' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: busy, text: sources.busy === source.id ? '处理中…' : '保存' }),
    smallButton('测试连接', { disabled: busy, onClick: () => handlers.checkSource(source.id, formValues(form, source)) }),
    smallButton('取消', { onClick: () => handlers.cancelSourceEdit() }),
    h('p', { class: 'help', text: '密钥加密保存在这台电脑上；保存后下次拉取就用新的设置' })))
  return h('li', { class: 'ext-item', 'data-id': source.id, 'data-editing': 'true' }, form)
}

/** The chosen folder, shown for a yes: who it is, what it runs and reads, what it will ask for. */
function pendingCard(pending: Pending, sources: Sources, handlers: Handlers) {
  const busy = sources.busy !== null
  const row = (title: string, text: string, mono = false) => h('div', { class: 'ext-edit-row' }, label(title), h('span', { class: mono ? 'ext-detail mono' : 'ext-detail', text }))
  return h('div', { class: 'ext-edit source-pending', role: 'group', 'aria-label': `安装消息源 ${pending.name}` },
    h('div', { class: 'ext-edit-head' },
      h('span', { class: 'ext-name', text: pending.replaces ? `更新「${pending.name}」？` : `安装「${pending.name}」？` }),
      h('span', { class: 'badge', text: KIND_LABEL[pending.kind] ?? pending.kind })),
    row('会读', pending.reads),
    row('会运行', pending.command, true),
    row('要你填', pending.fields.length ? pending.fields.join('、') : '不用填'),
    row('来自', `${pending.from} · ${pending.files} 个文件 · ${formatSize(pending.bytes)}`, true),
    h('p', { class: 'form-error', text: pending.replaces ? `${TRUST_WARNING}会替换已经装好的同名消息源，设置保留。` : TRUST_WARNING }),
    h('div', { class: 'ext-edit-foot' },
      h('button', { class: 'btn btn-accent btn-small', type: 'button', disabled: busy, text: pending.replaces ? '更新' : '安装', onClick: () => handlers.installSource() }),
      smallButton('取消', { disabled: busy, onClick: () => handlers.cancelSourceInstall() })))
}

function brokenItem(broken: { name: string, problem: string }) {
  return h('li', { class: 'ext-item' }, h('div', { class: 'ext-copy' },
    h('div', { class: 'ext-title' }, h('span', { class: 'ext-name mono', text: broken.name }), h('span', { class: 'ext-status', 'data-tone': 'off', text: '用不了' })),
    h('span', { class: 'ext-detail', text: broken.problem })))
}

/** The 消息源 part of settings: the sources in the sources folder, each switched on, set up and watched here. */
export function sourcesSection(sources: Sources, handlers: Handlers) {
  if (!sources.loaded) return h('section', { class: 'ext' }, label('消息源'), h('p', { class: 'help', text: '读取中…' }))
  const item = (source: Source) => (sources.editing === source.id ? editItem(source, sources, handlers) : sourceItem(source, sources, handlers))
  return h('section', { class: 'ext', 'aria-label': '消息源' },
    label('消息源'),
    h('p', { class: 'help source-hint', text: SOURCE_DOCS_HINT }),
    sources.pending ? pendingCard(sources.pending, sources, handlers) : null,
    sources.sources.length
      ? h('ul', { class: 'ext-list' }, sources.sources.map(item))
      : h('p', { class: 'help', text: '还没有消息源。' }),
    sources.broken.length ? h('ul', { class: 'ext-list', 'aria-label': '用不了的消息源' }, sources.broken.map(brokenItem)) : null,
    h('div', { class: 'source-folder' },
      h('span', { class: 'help mono ellipsis', title: sources.folder, text: sources.folder }),
      smallButton('安装消息源…', { disabled: sources.busy !== null, onClick: () => handlers.chooseSource() }),
      smallButton('打开文件夹', { onClick: () => handlers.openSourcesFolder() }),
      smallButton('刷新', { disabled: sources.busy !== null, onClick: () => handlers.loadSources() })),
    sources.error ? h('p', { class: 'form-error', role: 'alert', text: sources.error }) : null,
    sources.notice ? h('p', { class: 'form-notice', role: 'status', text: sources.notice }) : null)
}
