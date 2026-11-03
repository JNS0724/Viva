import { t } from '../../shared/i18n/translate.ts'
import { isProfileEmpty } from '../personal-state.ts'
import { catMood, greeting, setupView, statusView } from '../selectors.ts'
import { maidFor, maidMood } from './maid.ts'
import type { MaidMood, MaidSlots } from './maid.ts'
import { h } from './dom.ts'

const HERO_PX = 200
/** One wave (greeting-motion.webp plays once), the first time the home page shows after launch. */
const GREETING_MS = 1400
let greetingEnds: number | null = null
const heroMaids: MaidSlots = new Map()

const hasReady = (state: State) => state.followups.followups.some((f: Untyped) => f.status === 'ready')

/** She waves once, then rests: holding up the ✓ card while something is ready, offline until a model is connected. */
function heroMood(state: State, tone: string, now: number): { mood: MaidMood, moving: boolean } {
  const mood = maidMood(catMood(state), tone)
  if (mood !== 'idle') return { mood, moving: true }
  greetingEnds ??= now + GREETING_MS
  if (now < greetingEnds) return { mood: 'greeting', moving: true }
  return { mood: hasReady(state) ? 'done' : 'idle', moving: false }
}

/** The maid, whole, on her cream with a saucer's rim around it: the one bold thing on the page. */
function heroMaid(state: State, tone: string, now: number) {
  const { mood, moving } = heroMood(state, tone, now)
  return h('div', { class: 'maid-hero' }, maidFor(heroMaids, 'hero', mood, { size: HERO_PX, moving }))
}

/** What the greeting says under it: the setup, the background at work, or the usual question. */
function subtitle(state: State) {
  if (state.info.mode === 'setup') return t("home.connect.a.model.to.get.started")
  if (state.followups.state?.running) return t("home.i.ll.review.your.to.dos.in")
  return t("home.what.can.i.help.you.with.today")
}

function hero(state: State, now: number) {
  return h('section', { class: 'home-hero', 'aria-label': t("home.assistant") },
    heroMaid(state, statusView(state, now).tone, now),
    h('div', { class: 'hero-copy' },
      h('h1', { class: 'greeting', text: greeting(new Date(now)) }),
      h('p', { class: 'greeting-sub', text: subtitle(state) })))
}

const endOfDay = (ts: number) => new Date(ts).setHours(23, 59, 59, 999)
const OPEN = new Set(['scheduled', 'preparing', 'ready'])

/**
 * 今天: what waits for the user (drafts ready) and what will be reminded of before the day
 * ends; only on a day with something, and the way to the 后台 page.
 */
function todayCard(state: State, handlers: Handlers, now: number) {
  const followups: readonly Untyped[] = state.followups.followups
  const ready = followups.filter((f) => f.status === 'ready').length
  const later = followups.filter((f) => OPEN.has(f.status) && f.status !== 'ready' && f.remindAt && f.remindAt > now && f.remindAt <= endOfDay(now)).length
  if (!ready && !later) return null
  const parts = [ready ? t("home.ready", { ready: ready }) : null, later ? t("home.reminders.today", { later: later }) : null].filter(Boolean)
  return h('section', { class: 'home-card home-today', 'aria-label': t("selectors.today") },
    h('div', { class: 'home-card-copy' },
      h('h2', { class: 'setup-title', text: t("selectors.today") }),
      h('p', { class: 'setup-body', text: t("home.nothing.has.been.acted.on.waiting.for", { value1: parts.join(' · ') }) })),
    h('button', { class: 'btn btn-accent btn-small', type: 'button', text: t("home.take.a.look"), onClick: () => handlers.openTasks() }))
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
const introCard = (handlers: Handlers) => h('section', { class: 'home-card tile-intro', 'aria-label': t("home.let.the.assistant.get.to.know.you") },
  h('div', { class: 'home-card-copy' },
    h('h2', { class: 'intro-title', text: t("home.introduce.yourself") }),
    h('p', { class: 'setup-body', text: t("home.add.a.few.details.about.your.work") })),
  h('div', { class: 'intro-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'button', id: 'start-intro', text: t("home.get.started"), onClick: () => handlers.openProfile('intro') }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t("home.maybe.later"), onClick: handlers.skipIntro })))

const wantsIntro = (memory: State['memory']) => memory.loaded && memory.onboarding === 'pending' && isProfileEmpty(memory)

/** Before the first message: the maid and a greeting, and a card only when something needs doing first. */
export function renderHome(container: HTMLElement, state: State, handlers: Handlers, now: number) {
  const setup = setupView(state.info)
  const card = setup ? setupCard(setup, handlers) : wantsIntro(state.memory) ? introCard(handlers) : todayCard(state, handlers, now)
  container.replaceChildren(h('div', { class: 'home-simple' }, hero(state, now), card))
}
