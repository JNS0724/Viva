import { contextShare, NEAR_FULL, topicCount } from '../topics.ts'
import { h } from './dom.ts'

const NEW_TOPIC_KEY = () => (document.documentElement.dataset.platform === 'darwin' ? '⌘N' : 'Ctrl+N')

/** The page's Content-Security-Policy refuses style attributes; set through the DOM, the width is allowed. */
function barFill(percent) {
  const fill = h('i')
  fill.style.width = `${percent}%`
  return fill
}

/**
 * Above the input: what the assistant has in mind now, 本话题 · N 条 and how much of its context that takes
 * (near full it says so), and ＋ 新话题 beside it. A click on the label says what that means.
 * @param {HTMLElement} area #ctx-area
 * @param {object} state
 * @param {{ toggleTopicMenu: () => void, newSession: () => void }} handlers
 * @param {{ ready: boolean, busy: boolean }} options ready: connected to an agent; busy: a turn runs
 */
export function renderTopicLabel(area, state, handlers, { ready, busy }) {
  area.hidden = !ready
  if (!ready) return area.replaceChildren()
  const count = topicCount(state)
  const share = contextShare(state.usage)
  const percent = share === null ? null : Math.round(share * 100)
  const full = share !== null && share >= NEAR_FULL
  const chip = h('button', {
    class: 'chip ctx-chip', type: 'button', 'data-tone': full ? 'full' : null, 'aria-expanded': String(state.topic.menu),
    title: '助手现在记得的内容', onClick: () => handlers.toggleTopicMenu(),
  },
  h('span', { text: full ? '快满了 · 建议开新话题' : `本话题 · ${count} 条` }),
  percent === null ? null : h('span', { class: 'ctx-bar', 'aria-hidden': 'true' }, barFill(percent)),
  percent === null ? null : h('span', { class: 'ctx-pct', text: `${percent}%` }))
  const newTopic = h('button', {
    class: 'ctx-new', type: 'button', disabled: busy, title: busy ? '先停止当前任务，再开新话题' : `开新话题（${NEW_TOPIC_KEY()}）`,
    onClick: () => handlers.newSession(),
  }, h('span', { 'aria-hidden': 'true', text: '＋' }), '新话题')
  return area.replaceChildren(...[chip, newTopic, state.topic.menu ? topicInfo(count, percent) : null].filter(Boolean))
}

/** What the label means: how much is remembered, what happens when it is full. */
function topicInfo(count, percent) {
  const used = percent === null ? '还没算出用了多少' : `已用 ${percent}%`
  return h('div', { class: 'ctx-menu', role: 'dialog', 'aria-label': '本话题' },
    h('div', { class: 'ctx-menu-info' },
      h('b', { text: count ? `助手现在记得本话题的 ${count} 条` : '新话题：助手还什么都不记得' }),
      h('span', { text: `${used}；满了以后，最早的部分会被自动压缩。关于你的记忆不占这里。想换个话题，点「＋ 新话题」或按 ${NEW_TOPIC_KEY()}。` })))
}
