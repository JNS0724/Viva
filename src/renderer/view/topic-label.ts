import { t } from '../../shared/i18n/translate.ts'
import { contextShare, NEAR_FULL, topicCount } from '../topics.ts'
import { h } from './dom.ts'

const NEW_TOPIC_KEY = () => (document.documentElement.dataset.platform === 'darwin' ? '⌘N' : 'Ctrl+N')

/** The page's Content-Security-Policy refuses style attributes; set through the DOM, the width is allowed. */
function barFill(percent: number) {
  const fill = h('i')
  fill.style.width = `${percent}%`
  return fill
}

/**
 * Above the input: what the assistant has in mind now, 本话题 · N 条 and how much of its context that takes
 * (near full it says so), and ＋ 新话题 beside it. A click on the label says what that means.
 * @param area #ctx-area
 * @param handlers toggleTopicMenu, newSession
 * @param options ready: connected to an agent; busy: a turn runs
 */
export function renderTopicLabel(area: HTMLElement, state: State, handlers: Handlers, { ready, busy }: { ready: boolean, busy: boolean }) {
  area.hidden = !ready
  if (!ready) return area.replaceChildren()
  const count = topicCount(state)
  const share = contextShare(state.usage)
  const percent = share === null ? null : Math.round(share * 100)
  const full = share !== null && share >= NEAR_FULL
  const chip = h('button', {
    class: 'chip ctx-chip', type: 'button', 'data-tone': full ? 'full' : null, 'aria-expanded': String(state.topic.menu),
    title: t("topic-label.what.the.assistant.currently.remembers"), onClick: () => handlers.toggleTopicMenu(),
  },
  h('span', { text: full ? t("topic-label.almost.full.consider.a.new.topic") : t("topic-label.this.topic.messages", { count: count }) }),
  percent === null ? null : h('span', { class: 'ctx-bar', 'aria-hidden': 'true' }, barFill(percent)),
  percent === null ? null : h('span', { class: 'ctx-pct', text: `${percent}%` }))
  const newTopic = h('button', {
    class: 'ctx-new', type: 'button', disabled: busy || state.switching,
    'aria-busy': String(state.switching),
    title: state.switching ? t("topic-label.you.can.type.now.and.send.when") : state.newTopicPending ? t("topic-label.retry.preparing.this.new.topic.keep.the") : busy ? t("new-topic-actions.stop.the.current.task.before.starting.a") : t("topic-label.new.topic", { value1: NEW_TOPIC_KEY() }),
    onClick: () => handlers.newSession(),
  }, h('span', { 'aria-hidden': 'true', text: '＋' }), state.switching ? t("topic-label.preparing") : state.newTopicPending ? t("topic-label.retry.new.topic") : t("earlier.new.topic"))
  return area.replaceChildren(...[chip, newTopic, state.topic.menu ? topicInfo(count, percent) : null].filter((part) => part !== null))
}

/** What the label means: how much is remembered, what happens when it is full. */
function topicInfo(count: number, percent: number | null) {
  const used = percent === null ? t("topic-label.usage.not.available.yet") : t("topic-label.used", { percent: percent })
  return h('div', { class: 'ctx-menu', role: 'dialog', 'aria-label': t("topic-label.this.topic") },
    h('div', { class: 'ctx-menu-info' },
      h('b', { text: count ? t("topic-label.the.assistant.remembers.messages.in.this.topic", { count: count }) : t("topic-label.new.topic.the.assistant.has.no.conversation") }),
      h('span', { text: t("topic-label.when.full.the.oldest.content.is.automatically", { used: used, value2: NEW_TOPIC_KEY() }) })))
}
