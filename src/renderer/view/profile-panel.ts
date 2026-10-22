import { PROFILE_FIELDS } from '../../shared/profile-fields.ts'
import { formatListTime } from '../selectors.ts'
import { h, keepingInput, label } from './dom.ts'
import { icon } from './icons.ts'

/** The 关于你 page's part of the state (personal-state.ts). */
type MemoryPage = State['memory']
/** A field of the profile the user fills in (shared/profile-fields.ts). */
type ProfileField = { key: string, label: string, hint: string }
/** A memory as the page lists it (main/memory-store.ts). */
type MemoryRow = {
  id: number, text: string, kind: string, source: string, createdAt: number, keywords?: readonly string[],
  invalidAt?: number, supersededBy?: number | null, invalidatedBy?: string | null,
}
type IntroItem = { key: string, label: string, hint: string, multiline: boolean }

const KIND_LABEL: Readonly<Record<string, string>> = { fact: '事实', preference: '偏好', person: '人', project: '项目', role: '身份' }
const SOURCE_LABEL: Readonly<Record<string, string>> = { user: '你添加', agent: '助手记下' }
const INTRO_ITEMS: readonly IntroItem[] = [
  { key: 'role', label: '你的工作', hint: '例如：支付平台部的后端负责人，负责清结算', multiline: false },
  { key: 'projects', label: '在推进的事', hint: '例如：Q4 对账系统重构', multiline: false },
  { key: 'preferences', label: '偏好与习惯', hint: '例如：回答先给结论；对比方案时用表格', multiline: false },
  { key: 'sources', label: '常用网站（只用来让助手读一遍）', hint: '一行一个网址，例如内部 wiki、项目看板', multiline: true },
]

function fieldEditor(field: ProfileField, entry: { value: string } | undefined, memory: MemoryPage, handlers: Handlers) {
  const input = h('textarea', {
    class: 'field profile-input', name: `field-${field.key}`, 'data-version': field.key, rows: 3,
    'aria-label': field.label, placeholder: field.hint, maxlength: 1000,
  })
  input.value = entry?.value ?? ''
  return h('form', {
    class: 'profile-edit',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.saveField(field.key, input.value)
    },
  },
  input,
  h('div', { class: 'profile-edit-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: memory.busy, text: '保存' }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '取消', onClick: () => handlers.editField(null) })))
}

function fieldCard(field: ProfileField, memory: MemoryPage, handlers: Handlers) {
  const entry = memory.profile[field.key]
  const editing = memory.editing === field.key
  return h('div', { class: 'profile-field', 'data-filled': String(Boolean(entry)), 'data-field': field.key },
    h('div', { class: 'profile-field-head' },
      label(field.label),
      editing ? null : h('button', {
        class: 'link-btn', type: 'button', text: entry ? '编辑' : '填写', 'aria-label': `编辑${field.label}`,
        onClick: () => handlers.editField(field.key),
      })),
    editing
      ? fieldEditor(field, entry, memory, handlers)
      : h('p', { class: 'profile-value', text: entry?.value ?? field.hint }))
}

/** Once there is something to say: it goes along with each conversation, so it is shown here too. */
const habitsRow = (habits: { text?: string, samples?: number }) => (habits.text
  ? h('p', { class: 'help', text: `使用习惯（根据最近 ${habits.samples} 次提问）：${habits.text}` })
  : null)

/** Read-only: it is rebuilt from the memories, so changing a memory is how it changes. */
function synthesisSection(memory: MemoryPage, now: number) {
  const synthesis = memory.synthesis
  return h('section', { class: 'profile-section' },
    h('div', { class: 'row-between' },
      h('h3', { class: 'profile-heading', text: '助手整理的画像' }),
      synthesis ? h('span', { class: 'memory-meta mono', text: `更新于 ${formatListTime(synthesis.createdAt, now)}` }) : null),
    synthesis
      ? h('p', { class: 'profile-synthesis', text: synthesis.text })
      : h('p', { class: 'empty', text: '助手记下一些关于你的事之后，会定期把它们整理成画像，大约每天一次。' }),
    h('p', { class: 'help', text: '由下面的记忆整理而来；想纠正，改对应的记忆即可。' }))
}

function memoryMeta(memory: MemoryRow, now: number) {
  const keywords = memory.keywords?.length ? `关键词：${memory.keywords.join('、')}` : ''
  return [KIND_LABEL[memory.kind], SOURCE_LABEL[memory.source], formatListTime(memory.createdAt, now), keywords].filter(Boolean).join(' · ')
}

function memoryItem(memory: MemoryRow, handlers: Handlers, now: number) {
  return h('li', { class: 'memory-item', 'data-source': memory.source },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: memory.text }),
      h('span', { class: 'memory-meta mono', text: memoryMeta(memory, now) })),
    h('button', {
      class: 'icon-btn memory-delete', type: 'button', 'aria-label': `删除记忆：${memory.text}`, title: '删除',
      onClick: () => handlers.deleteMemory(memory),
    }, icon('close', 14)))
}

function invalidReason(memory: MemoryRow, now: number) {
  const when = formatListTime(memory.invalidAt ?? 0, now)
  if (memory.supersededBy) return `${when} 被新的记忆取代`
  return memory.invalidatedBy === 'user' ? `${when} 按你的要求忘掉` : `${when} 助手判断已不成立`
}

function invalidItem(memory: MemoryRow, handlers: Handlers, now: number) {
  return h('li', { class: 'memory-item', 'data-invalid': 'true' },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: memory.text }),
      h('span', { class: 'memory-meta mono', text: invalidReason(memory, now) })),
    h('button', {
      class: 'btn btn-outline btn-small', type: 'button', text: '恢复', 'aria-label': `恢复记忆：${memory.text}`,
      onClick: () => handlers.reviveMemory(memory),
    }))
}

/** Memories that stopped counting stay here, so an update the user disagrees with can be undone. */
function invalidSection(memory: MemoryPage, handlers: Handlers, now: number) {
  if (memory.invalid === 0 && !memory.invalidOpen) return null
  return h('div', { class: 'memory-invalid' },
    h('button', {
      class: 'link-btn', type: 'button', 'aria-expanded': String(memory.invalidOpen),
      text: memory.invalidOpen ? '收起已失效的记忆' : `已失效 · ${memory.invalid}`, onClick: handlers.toggleInvalid,
    }),
    memory.invalidOpen && memory.invalidItems.length
      ? h('ul', { class: 'memory-list' }, memory.invalidItems.map((item: MemoryRow) => invalidItem(item, handlers, now)))
      : null)
}

function memoriesSection(memory: MemoryPage, handlers: Handlers, now: number) {
  const addInput = h('input', {
    class: 'field', name: 'memory-new', 'data-version': String(memory.lastAdded ?? ''), maxlength: 500,
    placeholder: '想让助手记住什么？例如：周报每周五下班前交', 'aria-label': '添加一条记忆',
  })
  const search = h('input', {
    class: 'field', name: 'memory-search', type: 'search', value: memory.query, placeholder: '搜索记忆…', 'aria-label': '搜索记忆',
    onInput: () => handlers.searchMemories(search.value),
  })
  const searching = memory.query.trim() !== ''
  const empty = searching
    ? `没有包含「${memory.query.trim()}」的记忆`
    : '还没有记忆。聊天时提到的重要信息，助手会自己记下来；你也可以直接在上面添加。'
  return h('section', { class: 'profile-section' },
    h('div', { class: 'row-between' }, h('h3', { class: 'profile-heading', text: `记忆 · ${memory.total}` }), search),
    h('form', {
      class: 'field-row',
      onSubmit: async (event: SubmitEvent) => {
        event.preventDefault()
        if (await handlers.addMemory(addInput.value)) addInput.value = ''
      },
    }, addInput, h('button', { class: 'btn btn-outline btn-field', type: 'submit', disabled: memory.busy, text: '添加' })),
    memory.items.length
      ? h('ul', { class: 'memory-list' }, memory.items.map((item: MemoryRow) => memoryItem(item, handlers, now)))
      : h('p', { class: 'empty', text: empty }),
    invalidSection(memory, handlers, now))
}

function profileView(memory: MemoryPage, handlers: Handlers, now: number): View[] {
  return [
    h('h2', { class: 'settings-title', id: 'profile-title', text: '关于你' }),
    h('p', { class: 'help', text: '助手对你的了解都在这里，每一条都可以改或删，只保存在这台电脑上。' }),
    memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
    h('section', { class: 'profile-section' },
      h('h3', { class: 'profile-heading', text: '你填写的画像' }),
      h('div', { class: 'profile-grid' }, PROFILE_FIELDS.map((field) => fieldCard(field, memory, handlers))),
      habitsRow(memory.habits)),
    synthesisSection(memory, now),
    memoriesSection(memory, handlers, now),
  ]
}

function introInput(item: IntroItem, value: string | undefined) {
  const props = { class: 'field', name: `intro-${item.key}`, placeholder: item.hint, 'aria-label': item.label }
  const input = item.multiline ? h('textarea', { ...props, rows: 3 }) : h('input', props)
  input.value = value ?? ''
  return h('label', { class: 'intro-item' }, label(item.label), input)
}

function introValues(form: HTMLFormElement) {
  const value = (key: string) => (form.elements.namedItem(`intro-${key}`) as HTMLInputElement | null)?.value ?? ''
  return { role: value('role'), projects: value('projects'), preferences: value('preferences'), sources: value('sources') }
}

function introView(memory: MemoryPage, handlers: Handlers): View[] {
  const current = (key: string) => memory.profile[key]?.value ?? ''
  const docs = memory.docs.length
    ? h('ul', { class: 'doc-chips' }, memory.docs.map((doc: { path: string, name: string }) => h('li', { class: 'chip', title: doc.path }, icon('file', 14), doc.name)))
    : null
  const form = h('form', {
    class: 'intro-form',
    onSubmit: (event: SubmitEvent) => {
      event.preventDefault()
      handlers.finishIntro(introValues(form), (form.elements.namedItem('intro-analyze') as HTMLInputElement).checked)
    },
  },
  ...INTRO_ITEMS.map((item) => introInput(item, current(item.key))),
  h('div', { class: 'intro-docs' },
    h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: memory.busy, onClick: handlers.addDocs }, '添加常用文档'),
    h('span', { class: 'help', text: '会复制一份到工作区的「我的资料」，原文件不动' })),
  docs,
  h('label', { class: 'intro-check' },
    h('input', { type: 'checkbox', name: 'intro-analyze', checked: true }),
    h('span', { text: '保存后让助手阅读这些网站和文档，补全画像（会在对话里进行，你能看到每一步）' })),
  memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent', type: 'submit', disabled: memory.busy, text: memory.busy ? '保存中…' : '保存' }),
    h('button', { class: 'btn btn-outline btn-field', type: 'button', text: '以后再说', onClick: handlers.skipIntro })))
  return [
    h('h2', { class: 'settings-title', id: 'profile-title', text: '让我认识你' }),
    h('p', { class: 'help', text: '每一项都可以留空，以后在「关于你」里随时改。' }),
    form,
  ]
}

/** The 关于你 page (view/hub.js), or the intro form in its place. Rebuilt only when its slice changes; typed text survives. */
export function renderProfilePanel(container: HTMLElement, memory: MemoryPage, handlers: Handlers, now = Date.now()) {
  if (!memory.open) {
    container.replaceChildren()
    return
  }
  const shownView = container.querySelector<HTMLElement>('.profile')?.dataset.view ?? null
  keepingInput(container, () => container.replaceChildren(
    h('section', { class: 'settings profile', 'aria-labelledby': 'profile-title', 'data-view': memory.view },
      ...(memory.view === 'intro' ? introView(memory, handlers) : profileView(memory, handlers, now)).filter(Boolean))))
  if (shownView !== 'intro' && memory.view === 'intro') container.querySelector<HTMLElement>('[name="intro-role"]')?.focus()
  container.querySelector<HTMLElement>('.profile-input')?.focus()
}
