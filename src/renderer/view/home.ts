import { t } from '../../shared/i18n/translate.ts'
import { initializationNotice } from './initialization.ts'
import { sortedSchedules } from '../schedules-state.ts'
import { catMood, greeting, setupView, statusView } from '../selectors.ts'
import { maidFor, maidMood } from './maid.ts'
import type { MaidMood, MaidSlots } from './maid.ts'
import { h } from './dom.ts'

const HERO_PX = 200
/** One wave (greeting-motion.webp plays once), the first time the home page shows after launch. */
const GREETING_MS = 1400
let greetingEnds: number | null = null
const heroMaids: MaidSlots = new Map()

/** She waves once, then rests; offline until a model is connected. */
function heroMood(state: State, tone: string, now: number): { mood: MaidMood, moving: boolean } {
  const mood = maidMood(catMood(state), tone)
  if (mood !== 'idle') return { mood, moving: true }
  greetingEnds ??= now + GREETING_MS
  if (now < greetingEnds) return { mood: 'greeting', moving: true }
  return { mood: 'idle', moving: true }
}

/** The maid, whole, on her cream with a saucer's rim around it: the one bold thing on the page. */
function heroMaid(state: State, tone: string, now: number) {
  const { mood, moving } = heroMood(state, tone, now)
  return h('div', { class: 'maid-hero' }, maidFor(heroMaids, 'hero', mood, { size: HERO_PX, moving }))
}

/** What the greeting says under it: the setup, or the usual question. */
function subtitle(state: State) {
  if (state.info.mode === 'setup') return t("home.connect.a.model.to.get.started")
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

/**
 * 今天: the active schedules that run before the day ends; only on a day with something, and the way to 定时任务.
 */
export function todayCard(state: State, handlers: Handlers, now: number) {
  const cutoff = endOfDay(now)
  const dueToday = sortedSchedules(state).filter((schedule) => schedule.status === 'active' && Date.parse(schedule.nextAt) <= cutoff)
  const later = dueToday.length
  if (!later) return null
  return h('section', { class: 'home-card home-today', 'aria-label': t("selectors.today") },
    h('div', { class: 'home-card-copy' },
      h('h2', { class: 'setup-title', text: t("selectors.today") }),
      h('p', { class: 'setup-body', text: t("home.reminders.today", { later }) })),
    h('button', { class: 'btn btn-accent btn-small', type: 'button', text: t("home.take.a.look"), onClick: () => handlers.openSchedules(dueToday[0].id) }))
}

/** While the agent cannot start: what is missing and how to fix it. */
function setupCard(setup: NonNullable<ReturnType<typeof setupView>>, handlers: Handlers) {
  return h('section', { class: 'home-card home-card-setup', 'aria-label': setup.title },
    h('div', { class: 'home-card-copy' },
      h('h2', { class: 'setup-title', text: setup.title }),
      h('p', { class: 'setup-body', text: setup.body })),
    setup.action ? h('button', { class: 'btn btn-accent setup-action', type: 'button', text: setup.action, onClick: handlers.openSettings }) : null)
}

/** Before the first message: the maid and a greeting, and a card only when something needs doing first. */
export function renderHome(container: HTMLElement, state: State, handlers: Handlers, now: number) {
  const setup = setupView(state.info)
  const card = initializationNotice(state, handlers) ?? (setup ? setupCard(setup, handlers) : todayCard(state, handlers, now))
  container.replaceChildren(h('div', { class: 'home-simple' }, hero(state, now), card))
}
