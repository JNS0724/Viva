import { isProfileEmpty } from '../personal-state.ts'
import { catMood, greeting, setupView, statusView } from '../selectors.ts'
import { catFor } from './cat.ts'
import { h } from './dom.ts'

const HERO_CAT_PX = 64
const heroCats = new Map<string, { key: string, el: HTMLElement }>()

/** The cat's head on its brand-blue disc (orange while it waits on the user), above the greeting. */
const heroCat = (state: State, tone: string) => h('div', { class: 'cat-hero', 'data-tone': tone },
  catFor(heroCats, 'hero', catMood(state), { size: HERO_CAT_PX, frame: true, variant: 'head' }))

/** What the greeting says under it: the setup, the background at work, or the usual question. */
function subtitle(state: State) {
  if (state.info.mode === 'setup') return '先连接模型，我们就能开始。'
  if (state.followups.state?.running) return '我在后台把你的待办过一遍，你忙你的。'
  return '今天想让我帮你做什么？'
}

function hero(state: State, now: number) {
  return h('section', { class: 'home-hero', 'aria-label': '助手' },
    heroCat(state, statusView(state, now).tone),
    h('div', { class: 'hero-copy' },
      h('h1', { class: 'greeting', text: greeting(new Date(now)) }),
      h('p', { class: 'greeting-sub', text: subtitle(state) })))
}

const endOfDay = (ts: number) => new Date(ts).setHours(23, 59, 59, 999)
const OPEN = new Set(['scheduled', 'preparing', 'ready'])

/**
 * 今天: what waits for the user (drafts ready, messages suggested) and what will be reminded of before the day
 * ends; only on a day with something, and the way to the 后台 page.
 */
function todayCard(state: State, handlers: Handlers, now: number) {
  const followups: readonly Untyped[] = state.followups.followups
  const ready = followups.filter((f) => f.status === 'ready').length
  const suggested = state.followups.suggestions.filter((s: Untyped) => s.status === 'open').length
  const later = followups.filter((f) => OPEN.has(f.status) && f.status !== 'ready' && f.remindAt && f.remindAt > now && f.remindAt <= endOfDay(now)).length
  if (!ready && !suggested && !later) return null
  const parts = [ready ? `准备好 ${ready} 件` : null, suggested ? `${suggested} 条消息要你看看` : null, later ? `今天要提醒 ${later} 件` : null].filter(Boolean)
  return h('section', { class: 'home-card home-today', 'aria-label': '今天' },
    h('div', { class: 'home-card-copy' },
      h('h2', { class: 'setup-title', text: '今天' }),
      h('p', { class: 'setup-body', text: `${parts.join(' · ')}。都还没动，等你点头。` })),
    h('button', { class: 'btn btn-accent btn-small', type: 'button', text: '去看看', onClick: () => handlers.openTasks() }))
}

/** While the agent cannot start: what is missing and how to fix it. */
function setupCard(setup: NonNullable<ReturnType<typeof setupView>>, handlers: Handlers) {
  return h('section', { class: 'home-card home-card-setup', 'aria-label': setup.title },
    h('div', { class: 'home-card-copy' },
      h('h2', { class: 'setup-title', text: setup.title }),
      h('p', { class: 'setup-body', text: setup.body })),
    setup.action ? h('button', { class: 'btn btn-accent setup-action', type: 'button', text: setup.action, onClick: handlers.openSettings }) : null)
}

/** First launches only: a light invitation to the intro, until it is done or put off. */
const introCard = (handlers: Handlers) => h('section', { class: 'home-card tile-intro', 'aria-label': '让助手认识你' },
  h('div', { class: 'home-card-copy' },
    h('h2', { class: 'intro-title', text: '让助手先认识你' }),
    h('p', { class: 'setup-body', text: '填几项你的工作，之后的回答会更贴合你。' })),
  h('div', { class: 'intro-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'button', id: 'start-intro', text: '开始', onClick: () => handlers.openProfile('intro') }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '以后再说', onClick: handlers.skipIntro })))

const wantsIntro = (memory: State['memory']) => memory.loaded && memory.onboarding === 'pending' && isProfileEmpty(memory)

/** Before the first message: the cat and a greeting, and a card only when something needs doing first. */
export function renderHome(container: HTMLElement, state: State, handlers: Handlers, now: number) {
  const setup = setupView(state.info)
  const card = setup ? setupCard(setup, handlers) : wantsIntro(state.memory) ? introCard(handlers) : todayCard(state, handlers, now)
  container.replaceChildren(h('div', { class: 'home-simple' }, hero(state, now), card))
}
