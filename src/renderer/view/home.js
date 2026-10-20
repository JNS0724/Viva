import { isProfileEmpty } from '../personal-state.js'
import { catMood, formatHM, greeting, modeLine, setupView, statusView, workspaceName } from '../selectors.js'
import { catFor } from './cat.js'
import { h, label } from './dom.js'

const SUGGESTIONS = [
  '看看工作区里有哪些文件，按类型给我归个类',
  '读一下工作区的 README，告诉我这个项目是做什么的',
  '帮我起草一份今天的工作小结',
]
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const HERO_CAT_PX = 230
const heroCats = new Map()

/** The cat on its brand-blue disc (orange while it waits on the user), ears out past the edge. */
const heroCat = (state, tone) => h('div', { class: 'cat-hero', 'data-tone': tone },
  catFor(heroCats, 'hero', catMood(state), { size: HERO_CAT_PX, frame: true }))

function heroTile(state, date, now) {
  const status = statusView(state, now)
  const offline = state.info.mode === 'setup'
  return h('section', { class: 'tile tile-hero', 'aria-label': '助手' },
    h('div', { class: 'row-between' },
      label(offline ? '00 / AGENT · OFFLINE' : '00 / AGENT · ONLINE'),
      h('span', { class: 'pill', 'data-tone': status.tone, text: status.label })),
    h('div', { class: 'hero-mid' },
      heroCat(state, status.tone),
      h('div', { class: 'hero-copy' },
        h('h1', { class: 'greeting', text: greeting(date) }),
        h('p', { class: 'greeting-sub', text: offline ? '先连接模型，我们就能开始。' : '今天想让我帮你做什么？' }))),
    h('div', { class: 'hero-foot' }, label('MODE'), h('span', { text: modeLine(state.info) })))
}

/** Shown instead of the dashboard tiles while the agent cannot start: what is missing and how to fix it. */
function setupTile(setup, handlers) {
  return h('section', { class: 'tile tile-setup', 'aria-label': setup.title },
    label('01 / SETUP'),
    h('div', { class: 'setup-copy' },
      h('h2', { class: 'setup-title', text: setup.title }),
      h('p', { class: 'setup-body', text: setup.body })),
    setup.action ? h('button', { class: 'btn btn-accent setup-action', type: 'button', text: setup.action, onClick: handlers.openSettings }) : null)
}

const suggestTile = (handlers) => h('div', { class: 'tile tile-dark tile-suggest' },
  label('04 / TRY'),
  SUGGESTIONS.map((text) => h('button', { class: 'suggest', text, onClick: () => handlers.suggest(text) })))

/** First launches: a light invitation to the intro, until it is done or put off. */
const introTile = (handlers) => h('div', { class: 'tile tile-dark tile-intro', 'aria-label': '让助手认识你' },
  label('04 / 认识你'),
  h('div', { class: 'intro-copy' },
    h('h2', { class: 'intro-title', text: '让助手先认识你' }),
    h('p', { class: 'tile-foot muted', text: '花一分钟填几项，之后的回答会更贴合你的工作。都可以留空。' })),
  h('div', { class: 'intro-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'button', id: 'start-intro', text: '开始', onClick: () => handlers.openProfile('intro') }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '以后再说', onClick: handlers.skipIntro })))

const wantsIntro = (memory) => memory.loaded && memory.onboarding === 'pending' && isProfileEmpty(memory)

/** Bento dashboard shown before the first message. Every number on it is real (clock, workspace, model). */
export function renderHome(container, state, handlers, now) {
  const date = new Date(now)
  const setup = setupView(state.info)
  if (setup) {
    container.replaceChildren(h('div', { class: 'bento' }, heroTile(state, date, now), setupTile(setup, handlers)))
    return
  }
  container.replaceChildren(h('div', { class: 'bento' },
    heroTile(state, date, now),
    h('div', { class: 'tile tile-accent' },
      label('01 / TIME'),
      h('span', { class: 'dot-num dot-xl', text: formatHM(date) }),
      h('span', { class: 'tile-foot', text: `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${WEEKDAYS[date.getDay()]}` })),
    h('div', { class: 'tile tile-white' },
      label('02 / WORKSPACE'),
      h('span', { class: 'tile-big', text: workspaceName(state.info.cwd) }),
      h('span', { class: 'tile-foot mono ellipsis', title: state.info.cwd, text: state.info.cwd || '—' })),
    h('div', { class: 'tile tile-dark' },
      label('03 / MODEL'),
      h('span', { class: 'dot-num dot-lg accent', text: state.info.model || '—' }),
      h('span', { class: 'tile-foot muted', text: '思考与工具调用会出现在右侧「过程」' })),
    wantsIntro(state.memory) ? introTile(handlers) : suggestTile(handlers)))
}
