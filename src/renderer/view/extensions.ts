import { h, label } from './dom.ts'

const TYPE_LABEL = { stdio: '本地命令', http: '远程地址' }

function serverStatus(server, status) {
  if (status.active.includes(server.name)) return { tone: 'ok', text: '已连接' }
  const dropped = status.dropped.find((item) => item.name === server.name)
  return { tone: 'off', text: dropped ? `未连接：${dropped.reason}` : '未连接' }
}

function serverItem(server, extensions, handlers) {
  const target = server.type === 'http' ? server.url : [server.command, ...server.args].join(' ')
  const secrets = [...server.envNames, ...server.headerNames]
  const status = serverStatus(server, extensions.status)
  return h('li', { class: 'ext-item', 'data-name': server.name },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: server.name }),
        h('span', { class: 'badge', text: TYPE_LABEL[server.type] }),
        h('span', { class: 'ext-status', 'data-tone': status.tone, text: status.text })),
      h('span', { class: 'ext-detail mono ellipsis', title: target, text: target }),
      secrets.length ? h('span', { class: 'ext-detail', text: `已加密保存：${secrets.join('、')}` }) : null),
    h('button', {
      class: 'btn btn-outline btn-small', type: 'button', disabled: extensions.busy, text: '删除',
      'aria-label': `删除 MCP 服务器 ${server.name}`, onClick: () => handlers.removeServer(server.name),
    }))
}

function skillItem(skill, extensions, handlers) {
  return h('li', { class: 'ext-item', 'data-name': skill.name },
    h('div', { class: 'ext-copy' },
      h('div', { class: 'ext-title' },
        h('span', { class: 'ext-name', text: skill.name }),
        h('span', { class: 'badge', text: skill.rootLabel }),
        skill.problem ? h('span', { class: 'ext-status', 'data-tone': 'off', text: `不会生效：${skill.problem}` }) : null),
      skill.description ? h('span', { class: 'ext-detail', text: skill.description }) : null),
    skill.managed ? h('button', {
      class: 'btn btn-outline btn-small', type: 'button', disabled: extensions.busy, text: '移除',
      'aria-label': `移除 skill ${skill.name}`, onClick: () => handlers.removeSkill(skill),
    }) : null)
}

/** Why the memory plugin was left out of the profile, if it was. */
const memoryProblem = (status) => (status.plugins ?? []).find((plugin) => plugin.contract === 'memory')?.problem

/** Said only when memory is off: when it works there is nothing to say. */
function memoryLine(status) {
  if (status.memory) return null
  const problem = memoryProblem(status)
  return h('p', { class: 'ext-memory', 'data-on': 'false' },
    problem ? `记忆插件版本不兼容，这次对话不会自动记忆：${problem}` : '记忆插件没有加载，这次对话不会自动记忆。可以重启应用再试。')
}

const HINT = '想接入新的服务，或者把一套做法存下来，直接在对话里说，例如「帮我接入 GitHub」「把刚才的做法存成 skill」。助手会先请你确认，需要密钥时请你在窗口里填写。'

/** The 扩展 part of settings: what is set up, each removable; adding happens in the conversation (viva-config). */
export function extensionsSection(extensions, handlers, { connected }) {
  if (!extensions.loaded) return h('section', { class: 'ext' }, label('扩展'), h('p', { class: 'help', text: '读取中…' }))
  return h('section', { class: 'ext', 'aria-label': '扩展' },
    label('扩展'),
    h('p', { class: 'help ext-hint', text: HINT }),
    connected ? memoryLine(extensions.status) : null,
    h('div', { class: 'ext-group' },
      h('h3', { class: 'profile-heading', text: 'MCP 服务器' }),
      extensions.servers.length
        ? h('ul', { class: 'ext-list' }, extensions.servers.map((server) => serverItem(server, extensions, handlers)))
        : h('p', { class: 'help', text: '还没有接入。' })),
    h('div', { class: 'ext-group' },
      h('h3', { class: 'profile-heading', text: 'Skills' }),
      extensions.skills.length
        ? h('ul', { class: 'ext-list' }, extensions.skills.map((skill) => skillItem(skill, extensions, handlers)))
        : h('p', { class: 'help', text: '还没有。' })),
    extensions.error ? h('p', { class: 'form-error', role: 'alert', text: extensions.error }) : null,
    extensions.notice ? h('p', { class: 'form-notice', role: 'status', text: extensions.notice }) : null)
}
