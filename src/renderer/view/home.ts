import { isProfileEmpty } from '../personal-state.ts'
import { catMood, greeting, setupView, statusView } from '../selectors.ts'
import { catFor } from './cat.ts'
import { h } from './dom.ts'

const HERO_CAT_PX = 230
const heroCats = new Map()

/** The cat on its brand-blue disc (orange while it waits on the user), ears out past the edge. */
const heroCat = (state, tone) => h('div', { class: 'cat-hero', 'data-tone': tone },
  catFor(heroCats, 'hero', catMood(state), { size: HERO_CAT_PX, frame: true }))

function hero(state, now) {
  const offline = state.info.mode === 'setup'
  return h('section', { class: 'home-hero', 'aria-label': '助手' },
    heroCat(state, statusView(state, now).tone),
    h('div', { class: 'hero-copy' },
      h('h1', { class: 'greeting', text: greeting(new Date(now)) }),
      h('p', { class: 'greeting-sub', text: offline ? '先连接模型，我们就能开始。' : '今天想让我帮你做什么？' })))
}

/** While the agent cannot start: what is missing and how to fix it. */
function setupCard(setup, handlers) {
  return h('section', { class: 'home-card home-card-setup', 'aria-label': setup.title },
    h('div', { class: 'home-card-copy' },
      h('h2', { class: 'setup-title', text: setup.title }),
      h('p', { class: 'setup-body', text: setup.body })),
    setup.action ? h('button', { class: 'btn btn-accent setup-action', type: 'button', text: setup.action, onClick: handlers.openSettings }) : null)
}

/** First launches only: a light invitation to the intro, until it is done or put off. */
const introCard = (handlers) => h('section', { class: 'home-card tile-intro', 'aria-label': '让助手认识你' },
  h('div', { class: 'home-card-copy' },
    h('h2', { class: 'intro-title', text: '让助手先认识你' }),
    h('p', { class: 'setup-body', text: '填几项你的工作，之后的回答会更贴合你。' })),
  h('div', { class: 'intro-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'button', id: 'start-intro', text: '开始', onClick: () => handlers.openProfile('intro') }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '以后再说', onClick: handlers.skipIntro })))

const wantsIntro = (memory) => memory.loaded && memory.onboarding === 'pending' && isProfileEmpty(memory)

/** Before the first message: the cat and a greeting, and a card only when something needs doing first. */
export function renderHome(container, state, handlers, now) {
  const setup = setupView(state.info)
  const card = setup ? setupCard(setup, handlers) : wantsIntro(state.memory) ? introCard(handlers) : null
  container.replaceChildren(h('div', { class: 'home-simple' }, hero(state, now), card))
}
