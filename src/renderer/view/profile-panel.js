import { PROFILE_FIELDS } from '../../shared/profile-fields.js'
import { formatListTime } from '../selectors.js'
import { h, keepingInput, label } from './dom.js'
import { icon } from './icons.js'

const KIND_LABEL = { fact: '事实', preference: '偏好', person: '人', project: '项目', role: '身份' }
const SOURCE_LABEL = { user: '你添加', agent: '助手记下' }
const INTRO_ITEMS = [
  { key: 'role', label: '你的工作', hint: '例如：支付平台部的后端负责人，负责清结算', multiline: false },
  { key: 'projects', label: '最近在推进的事', hint: '例如：Q4 对账系统重构', multiline: false },
  { key: 'sources', label: '常用网站', hint: '一行一个网址，例如内部 wiki、项目看板', multiline: true },
]
const PRIVACY_NOTE = '这些内容只保存在这台电脑上。每次对话开始时会把画像和偏好发给模型；你提到画像或记忆里的人和事时，才会带上相关的几条记忆。删除对话不会删除这里的记忆。'

function fieldEditor(field, entry, memory, handlers) {
  const input = h('textarea', {
    class: 'field profile-input', name: `field-${field.key}`, 'data-version': field.key, rows: 3,
    'aria-label': field.label, placeholder: field.hint, maxlength: 1000,
  })
  input.value = entry?.value ?? ''
  return h('form', {
    class: 'profile-edit',
    onSubmit: (event) => {
      event.preventDefault()
      handlers.saveField(field.key, input.value)
    },
  },
  input,
  h('div', { class: 'profile-edit-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: memory.busy, text: '保存' }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '取消', onClick: () => handlers.editField(null) })))
}

function fieldCard(field, memory, handlers) {
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

/** Read-only: it is rebuilt from the memories, so changing a memory is how it changes. */
function synthesisSection(memory, now) {
  const synthesis = memory.synthesis
  return h('section', { class: 'profile-section' },
    h('div', { class: 'row-between' },
      h('h3', { class: 'profile-heading', text: '助手整理的画像' }),
      synthesis ? h('span', { class: 'memory-meta mono', text: `更新于 ${formatListTime(synthesis.createdAt, now)}` }) : null),
    synthesis
      ? h('p', { class: 'profile-synthesis', text: synthesis.text })
      : h('p', { class: 'empty', text: '助手记下一些关于你的事之后，会定期把它们整理成画像，大约每天一次。' }),
    h('p', { class: 'help', text: '由下面的记忆整理而来：想纠正哪一点，修改或删除对应的记忆即可，下次整理时会更新。' }))
}

function habitsRow(habits) {
  const text = habits.text
    ? `${habits.text}（根据最近 ${habits.samples} 次提问）`
    : `提问满 20 次后，会根据你的使用时段自动分析（目前 ${habits.samples} 次）`
  return h('div', { class: 'profile-habits' }, label('使用习惯 · 自动分析'), h('span', { text }))
}

function memoryMeta(memory, now) {
  const keywords = memory.keywords?.length ? `关键词：${memory.keywords.join('、')}` : ''
  return [KIND_LABEL[memory.kind], SOURCE_LABEL[memory.source], formatListTime(memory.createdAt, now), keywords].filter(Boolean).join(' · ')
}

function memoryItem(memory, handlers, now) {
  return h('li', { class: 'memory-item', 'data-source': memory.source },
    h('div', { class: 'memory-copy' },
      h('span', { class: 'memory-text', text: memory.text }),
      h('span', { class: 'memory-meta mono', text: memoryMeta(memory, now) })),
    h('button', {
      class: 'icon-btn memory-delete', type: 'button', 'aria-label': `删除记忆：${memory.text}`, title: '删除',
      onClick: () => handlers.deleteMemory(memory),
    }, icon('close', 14)))
}

function invalidReason(memory, now) {
  const when = formatListTime(memory.invalidAt, now)
  if (memory.supersededBy) return `${when} 被新的记忆取代`
  return memory.invalidatedBy === 'user' ? `${when} 按你的要求忘掉` : `${when} 助手判断已不成立`
}

function invalidItem(memory, handlers, now) {
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
function invalidSection(memory, handlers, now) {
  if (memory.invalid === 0 && !memory.invalidOpen) return null
  return h('div', { class: 'memory-invalid' },
    h('button', {
      class: 'link-btn', type: 'button', 'aria-expanded': String(memory.invalidOpen),
      text: memory.invalidOpen ? '收起已失效的记忆' : `已失效 · ${memory.invalid}`, onClick: handlers.toggleInvalid,
    }),
    memory.invalidOpen && memory.invalidItems.length
      ? h('ul', { class: 'memory-list' }, memory.invalidItems.map((item) => invalidItem(item, handlers, now)))
      : null)
}

function memoriesSection(memory, handlers, now) {
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
      onSubmit: async (event) => {
        event.preventDefault()
        if (await handlers.addMemory(addInput.value)) addInput.value = ''
      },
    }, addInput, h('button', { class: 'btn btn-outline btn-field', type: 'submit', disabled: memory.busy, text: '添加' })),
    memory.items.length
      ? h('ul', { class: 'memory-list' }, memory.items.map((item) => memoryItem(item, handlers, now)))
      : h('p', { class: 'empty', text: empty }),
    invalidSection(memory, handlers, now))
}

function profileView(memory, handlers, now) {
  return [
    h('div', { class: 'row-between' },
      label('06 / ABOUT YOU'),
      h('div', { class: 'profile-head-actions' },
        h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '快速引导', onClick: () => handlers.openProfile('intro') }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onClick: handlers.closeProfile }, icon('close', 16)))),
    h('div', { class: 'profile-intro' },
      h('h2', { class: 'settings-title', id: 'profile-title', text: '关于你' }),
      h('p', { class: 'help', text: `助手对你的了解都在这里，每一条都可以修改或删除。${PRIVACY_NOTE}` })),
    memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
    h('section', { class: 'profile-section' },
      h('h3', { class: 'profile-heading', text: '你填写的画像' }),
      h('div', { class: 'profile-grid' }, PROFILE_FIELDS.map((field) => fieldCard(field, memory, handlers))),
      habitsRow(memory.habits)),
    synthesisSection(memory, now),
    memoriesSection(memory, handlers, now),
  ]
}

function introInput(item, value) {
  const props = { class: 'field', name: `intro-${item.key}`, placeholder: item.hint, 'aria-label': item.label }
  const input = item.multiline ? h('textarea', { ...props, rows: 3 }) : h('input', props)
  input.value = value ?? ''
  return h('label', { class: 'intro-item' }, label(item.label), input)
}

function introValues(form) {
  const value = (key) => form.elements.namedItem(`intro-${key}`)?.value ?? ''
  return { role: value('role'), projects: value('projects'), sources: value('sources'), email: value('email'), im: value('im') }
}

function introView(memory, handlers) {
  const current = (key) => memory.profile[key]?.value ?? ''
  const docs = memory.docs.length
    ? h('ul', { class: 'doc-chips' }, memory.docs.map((doc) => h('li', { class: 'chip', title: doc.path }, icon('file', 14), doc.name)))
    : null
  const form = h('form', {
    class: 'intro-form',
    onSubmit: (event) => {
      event.preventDefault()
      handlers.finishIntro(introValues(form), form.elements.namedItem('intro-analyze').checked)
    },
  },
  ...INTRO_ITEMS.map((item) => introInput(item, current(item.key))),
  h('div', { class: 'intro-docs' },
    h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: memory.busy, onClick: handlers.addDocs }, '添加常用文档'),
    h('span', { class: 'help', text: '会复制一份到工作区的「我的资料」，原文件不动' })),
  docs,
  h('div', { class: 'intro-pair' },
    introInput({ key: 'email', label: '工作邮箱（可留空）', hint: 'name@company.com' }, current('email')),
    introInput({ key: 'im', label: '工作 IM（可留空）', hint: '飞书、钉钉、企业微信、Slack…' }, current('im'))),
  h('label', { class: 'intro-check' },
    h('input', { type: 'checkbox', name: 'intro-analyze', checked: true }),
    h('span', { text: '保存后让助手阅读这些网站和文档，补全画像（会在对话里进行，你能看到每一步）' })),
  memory.error ? h('p', { class: 'form-error', role: 'alert', text: memory.error }) : null,
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent', type: 'submit', disabled: memory.busy, text: memory.busy ? '保存中…' : '保存' }),
    h('button', { class: 'btn btn-outline btn-field', type: 'button', text: '以后再说', onClick: handlers.skipIntro })))
  return [
    h('div', { class: 'row-between' },
      label('06 / GET TO KNOW YOU'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onClick: handlers.closeProfile }, icon('close', 16))),
    h('div', { class: 'profile-intro' },
      h('h2', { class: 'settings-title', id: 'profile-title', text: '让我认识你' }),
      h('p', { class: 'help', text: `花一分钟，之后的回答会更贴合你的工作。每一项都可以留空，以后在「关于你」里随时补充。${PRIVACY_NOTE}` })),
    form,
  ]
}

/** Modal "关于你" page, or the intro form. Rebuilt only when its slice changes; typed text survives. */
export function renderProfilePanel(container, memory, handlers, now = Date.now()) {
  if (!memory.open) {
    container.replaceChildren()
    return
  }
  const shownView = container.querySelector('.profile')?.dataset.view ?? null
  keepingInput(container, () => container.replaceChildren(h('div', {
    class: 'overlay',
    onMousedown: (event) => {
      if (event.target === event.currentTarget) handlers.closeProfile()
    },
  },
  h('section', { class: 'settings profile', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'profile-title', 'data-view': memory.view },
    ...(memory.view === 'intro' ? introView(memory, handlers) : profileView(memory, handlers, now)).filter(Boolean)))))
  if (shownView !== 'intro' && memory.view === 'intro') container.querySelector('[name="intro-role"]')?.focus()
  container.querySelector('.profile-input')?.focus()
}
