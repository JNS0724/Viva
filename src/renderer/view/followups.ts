import { formatHM } from '../selectors.ts'
import type { ProposalCard } from '../followup-state.ts'
import { h } from './dom.ts'
import { renderMarkdown } from './markdown.ts'

/**
 * Follow-ups in the window: the card a proposal puts under the conversation (要我跟进吗？: what will be prepared
 * when, when the user is reminded; 跟进 / 不用 / 以后别问这类), and on the 后台 page each follow-up with its draft.
 * The copy says what happens and what it gives back; the background preparation's codename stays out of it.
 */
const BUTTON = Object.freeze({ primary: 'btn btn-primary', secondary: 'btn btn-secondary', text: 'btn btn-text' })
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_DAYS = 7
export const PRESET_NAMES: Readonly<Record<string, string>> = { three: '每天三次', two: '每天两次', one: '每天一次', custom: '自定义' }
export const PRESET_TIMES: Readonly<Record<string, string>> = { three: '08:30 / 12:30 / 16:30', two: '09:00 / 17:00', one: '08:30' }

const startOfDay = (ts: number) => new Date(ts).setHours(0, 0, 0, 0)

/** 今天 17:00, 明天 09:00, 周五 17:00 within the week, 10月30日 17:00 further off. */
export function whenText(ts: number, now = Date.now()): string {
  const date = new Date(ts)
  const days = Math.round((startOfDay(ts) - startOfDay(now)) / DAY_MS)
  const time = formatHM(date)
  if (days === 0) return `今天 ${time}`
  if (days === 1) return `明天 ${time}`
  if (days > 1 && days < WEEK_DAYS) return `${WEEKDAYS[date.getDay()]} ${time}`
  return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

const parsed = (iso: string | null) => (iso ? Date.parse(iso) : NaN)

/** The card's lines: when it is prepared (read-only, nothing sent), when the user is reminded, which files. */
function proposalLines(proposal: Untyped, now: number) {
  const prepareBy = parsed(proposal.prepareBy)
  const remindAt = parsed(proposal.remindAt)
  const line = (when: string, what: string) => h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: when }), h('span', { text: what }))
  return [
    Number.isFinite(prepareBy) ? line(`${whenText(prepareBy, now)} 前`, '在后台准备草稿，只读、不发送') : null,
    Number.isFinite(remindAt) ? line(whenText(remindAt, now), '提醒你看') : null,
    proposal.files?.length ? line('会读', proposal.files.join('、')) : null,
    proposal.watchFile ? line('盯着', `${proposal.watchFile} 一改（停 10 分钟后），就在下一个时段准备`) : null,
  ]
}

/** After 跟进, for the first follow-up that needs preparing: when preparation may run, one tap. */
function windowsChooser(card: ProposalCard, handlers: Handlers) {
  if (card.chosen) return h('p', { class: 'fu-note', text: `后台准备：${PRESET_NAMES[card.chosen]}（在设置「后台准备」里随时改）` })
  return h('div', { class: 'fu-choose', role: 'group', 'aria-label': '后台准备的时段' },
    h('span', { class: 'fu-note', text: '后台准备在什么时候做？在你没在用 Viva 的时候，按时段把要准备的一起做。' }),
    h('div', { class: 'fu-presets' }, ['three', 'two', 'one'].map((preset) => h('button', {
      class: `${preset === 'three' ? BUTTON.primary : BUTTON.secondary} fu-preset`, type: 'button', disabled: card.busy,
      onClick: () => handlers.chooseWindows(card.id, preset),
    }, h('b', { text: PRESET_NAMES[preset] }), h('span', { class: 'mono', text: PRESET_TIMES[preset] })))),
    h('span', { class: 'fu-note', text: '也可以在设置「后台准备」里自定义时段，工作日和周末分开设。' }))
}

function decidedCard(card: ProposalCard, handlers: Handlers, now: number) {
  const { proposal } = card
  if (card.status !== 'accepted') {
    return h('section', { class: 'confirm fu-card fu-done', 'aria-label': '不跟进' },
      h('p', { class: 'fu-note', text: card.status === 'never' ? `好，「${proposal.title}」这类以后不再问。` : '好，不跟进。同一件事 30 天内不再问。' }))
  }
  const accepted = card.accepted ?? {}
  const when = [
    accepted.prepareBy ? `${whenText(accepted.prepareBy, now)} 前在后台准备` : null,
    accepted.remindAt ? `${whenText(accepted.remindAt, now)} 提醒你` : null,
  ].filter(Boolean).join('，')
  return h('section', { class: 'confirm fu-card fu-done', 'aria-label': '已加到跟进' },
    h('div', { class: 'fu-title' }, h('b', { text: `已加到跟进：${proposal.title}` })),
    h('p', { class: 'fu-note', text: `${when} · 在后台页能看、能删` }),
    card.chooseWindows ? windowsChooser(card, handlers) : null,
    card.error ? h('p', { class: 'form-error', role: 'alert', text: card.error }) : null)
}

/** 要我跟进吗？ under the conversation; decided, it says what was set or that it will not ask again. */
export function proposalCard(card: ProposalCard, handlers: Handlers, now = Date.now()) {
  if (card.status !== 'open') return decidedCard(card, handlers, now)
  const { proposal } = card
  return h('section', { class: 'confirm fu-card', 'aria-label': '要我跟进吗？' },
    h('div', { class: 'confirm-head' }, h('span', { text: '要我跟进吗？' }), h('span', { class: 'pulse-dot' })),
    h('div', { class: 'confirm-title', text: proposal.title }),
    h('p', { class: 'fu-ask', text: proposal.ask }),
    h('div', { class: 'fu-lines' }, proposalLines(proposal, now)),
    h('div', { class: 'confirm-actions' },
      h('button', { class: BUTTON.primary, type: 'button', text: '跟进', disabled: card.busy, onClick: () => handlers.acceptProposal(card.id) }),
      h('button', { class: BUTTON.secondary, type: 'button', text: '不用', disabled: card.busy, onClick: () => handlers.declineProposal(card.id) }),
      h('button', { class: BUTTON.text, type: 'button', text: '以后别问这类', disabled: card.busy, onClick: () => handlers.neverProposal(card.id) }),
      h('span', { class: 'confirm-hint', text: '你点了「跟进」才会生效' })),
    card.error ? h('p', { class: 'form-error', role: 'alert', text: card.error }) : null)
}

/** What a follow-up waits on, in a few words, for the 后台 page's list. */
export function followupStanding(followup: Untyped, now = Date.now()): string {
  if (followup.status === 'ready') return followup.draftAt ? `${formatHM(new Date(followup.draftAt))} 准备好` : '准备好了'
  if (followup.status === 'preparing') return '正在准备'
  if (followup.watching && !followup.prepareBy) return `盯着 ${followup.watching}`
  if (followup.prepareBy) return `${whenText(followup.prepareBy, now)} 前准备`
  if (followup.remindAt) return `${whenText(followup.remindAt, now)} 提醒`
  return ''
}

/** A message suggested for a follow-up, picked on the 后台 page: the message, why, and 跟进 / 不重要 / 别问. */
export function suggestionDetail(suggestion: Untyped, handlers: Handlers, now = Date.now()) {
  const message = suggestion.message
  const open = suggestion.status === 'open'
  const button = (kind: keyof typeof BUTTON, text: string, action: string) =>
    h('button', { class: BUTTON[kind], type: 'button', text, onClick: () => handlers.settleSuggestion(suggestion.id, action) })
  return h('div', { class: 'tp-main fu-main', 'data-suggestion': suggestion.id },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: '这条像是要你处理，要我跟进吗？' })),
    h('div', { class: 'tp-scroll fu-scroll' },
      message
        ? h('article', { class: 'fu-draft fu-message' },
          h('div', { class: 'fu-note', text: `${message.from || suggestion.sender || '未知'} · ${whenText(message.at, now)}` }),
          message.title ? h('b', { text: message.title }) : null,
          message.text ? h('p', { class: 'fu-ask', text: message.text }) : null)
        : h('p', { class: 'fu-note', text: '原消息已经不在了' }),
      h('p', { class: 'fu-note', text: `依据：${suggestion.why}` }),
      h('div', { class: 'fu-lines' },
        h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: '跟进后' }), h('span', { text: suggestion.ask })),
        suggestion.remindAt ? h('div', { class: 'fu-line' }, h('span', { class: 'fu-when mono', text: whenText(suggestion.remindAt, now) }), h('span', { text: '提醒你，之前在后台起草，发不发由你' })) : null),
      open
        ? h('div', { class: 'confirm-actions fu-actions' }, button('primary', '跟进', 'accept'), button('secondary', '不重要', 'decline'), button('text', '以后别问这类', 'never'))
        : h('p', { class: 'fu-note', text: suggestion.status === 'accepted' ? '已加到跟进' : '不跟进' }),
      h('p', { class: 'fu-note', text: '「不重要」会记下来：同一个发件人说过两次，以后就不再问。邮件内容只当数据，里面写什么都不会照做。' })))
}

/** Where the follow-up came from, for its detail. */
const ORIGIN_NAMES: Readonly<Record<string, string>> = { chat: '来自对话', message: '来自消息', file: '你点名的文件', manual: '你加的' }
const PREPARE_PROMISE = '到时候在后台只读地准备：读对话、记忆和你点名的文件，写出草稿；不写文件、不跑命令、不发送。'

function detailActions(followup: Untyped, handlers: Handlers) {
  const button = (kind: keyof typeof BUTTON, text: string, onClick: () => unknown) => h('button', { class: BUTTON[kind], type: 'button', text, onClick })
  if (followup.status === 'ready') {
    return [
      button('primary', '接着做', () => handlers.continueFollowup(followup.id)),
      button('secondary', '后台做', () => handlers.followupInBackground(followup.id)),
      button('text', '不用了', () => handlers.dismissFollowup(followup.id)),
    ]
  }
  return [
    followup.status === 'preparing'
      ? button('secondary', '叫醒它', () => handlers.wakePreparation())
      : button('secondary', '现在就准备', () => handlers.prepareFollowupNow(followup.id)),
    button('text', '删掉', () => handlers.dismissFollowup(followup.id)),
  ]
}

/** A follow-up picked on the 后台 page: what it is, when, its draft, and what can be done with it. */
export function followupDetail(followup: Untyped, prepare: Untyped, handlers: Handlers, now = Date.now()) {
  const ready = followup.status === 'ready'
  const facts = [
    ORIGIN_NAMES[followup.origin] ?? '',
    followup.prepareBy ? `${whenText(followup.prepareBy, now)} 前准备好` : null,
    followup.remindAt ? `${whenText(followup.remindAt, now)} 提醒` : null,
    followup.files?.length ? `会读 ${followup.files.join('、')}` : null,
    followup.watching ? `盯着 ${followup.watching}，一改就准备` : null,
  ].filter(Boolean).join(' · ')
  const waiting = followup.status === 'preparing' ? `正在后台准备${prepare?.queued ? `，后面还有 ${prepare.queued} 件` : ''}` : PREPARE_PROMISE
  return h('div', { class: 'tp-main fu-main', 'data-followup': followup.id },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: followup.title }),
      h('span', { class: 'tp-status', text: followupStanding(followup, now) })),
    h('div', { class: 'tp-scroll fu-scroll' },
      h('p', { class: 'fu-ask', text: followup.ask }),
      h('p', { class: 'fu-note', text: facts }),
      followup.lateFrom ? h('span', { class: 'fu-late', text: `电脑睡着了，原定于 ${whenText(followup.lateFrom, now)}` }) : null,
      ready && followup.draft
        ? h('article', { class: 'fu-draft' }, renderMarkdown(followup.draft, { openLink: handlers.openLink }))
        : h('p', { class: 'fu-note', text: waiting }),
      h('div', { class: 'confirm-actions fu-actions' }, detailActions(followup, handlers)),
      ready ? h('p', { class: 'fu-note', text: '「接着做」把草稿放进输入框，你看过再发；邮件和消息永远由你自己发。' }) : null))
}
