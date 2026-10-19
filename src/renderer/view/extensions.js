import { h, label } from './dom.js'

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

function textField(name, title, hint, { multiline = false } = {}) {
  const props = { class: 'field', name, placeholder: hint, 'aria-label': title, spellcheck: 'false', autocomplete: 'off' }
  return h('label', { class: 'intro-item' }, label(title), multiline ? h('textarea', { ...props, rows: 2 }) : h('input', props))
}

function serverForm(extensions, handlers) {
  const form = h('form', {
    class: 'ext-form', 'data-type': 'stdio',
    onSubmit: (event) => {
      event.preventDefault()
      const value = (name) => form.elements.namedItem(name)?.value ?? ''
      handlers.addServer({
        name: value('mcp-name'), type: value('mcp-type'), command: value('mcp-command'), args: value('mcp-args'),
        env: value('mcp-env'), url: value('mcp-url'), headers: value('mcp-headers'),
      })
    },
  },
  h('div', { class: 'intro-pair' },
    textField('mcp-name', '名称', '例如 github（英文、数字、- 和 _）'),
    h('label', { class: 'intro-item' }, label('连接方式'), h('select', {
      class: 'field', name: 'mcp-type', 'aria-label': '连接方式',
      onChange: (event) => { form.dataset.type = event.target.value },
    }, h('option', { value: 'stdio', text: '本地命令（stdio）' }), h('option', { value: 'http', text: '远程地址（HTTP）' })))),
  h('div', { class: 'ext-stdio' },
    textField('mcp-command', '启动命令', '例如 npx、uvx，或程序的完整路径'),
    textField('mcp-args', '参数（每行一个）', '-y\n@modelcontextprotocol/server-github', { multiline: true }),
    textField('mcp-env', '环境变量（名称=值，每行一个）', 'GITHUB_TOKEN=…', { multiline: true })),
  h('div', { class: 'ext-http' },
    textField('mcp-url', '服务器地址', 'https://example.com/mcp'),
    textField('mcp-headers', '请求头（名称=值，每行一个）', 'Authorization=Bearer …', { multiline: true })),
  h('p', { class: 'help', text: '环境变量和请求头的值用系统钥匙串加密保存，之后只显示名称。添加后会立即连接到当前对话。' }),
  h('div', { class: 'settings-actions' },
    h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: extensions.busy, text: extensions.busy ? '连接中…' : '添加并连接' }),
    h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '取消', onClick: () => handlers.toggleAddServer(false) })))
  return form
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

const memoryLine = (status) => h('p', { class: 'ext-memory', 'data-on': String(status.memory) },
  status.memory
    ? '记忆插件已加载：助手会自己记住重要的事，提到相关的人和事时带上记忆，也会在需要时自己回忆。'
    : '记忆插件没有加载，这次对话不会自动记忆。可以重启应用再试。')

/** The 扩展 part of settings: MCP servers the agent can call, and skills it can load. */
export function extensionsSection(extensions, handlers, { connected }) {
  if (!extensions.loaded) return h('section', { class: 'ext' }, label('EXTENSIONS · 扩展'), h('p', { class: 'help', text: '读取中…' }))
  return h('section', { class: 'ext', 'aria-label': '扩展' },
    label('EXTENSIONS · 扩展'),
    h('div', { class: 'ext-group' },
      h('div', { class: 'row-between' },
        h('h3', { class: 'profile-heading', text: 'MCP 服务器' }),
        extensions.adding ? null : h('button', {
          class: 'btn btn-outline btn-small', type: 'button', id: 'add-mcp', text: '添加', onClick: () => handlers.toggleAddServer(true),
        })),
      connected ? memoryLine(extensions.status) : null,
      extensions.servers.length
        ? h('ul', { class: 'ext-list' }, extensions.servers.map((server) => serverItem(server, extensions, handlers)))
        : h('p', { class: 'help', text: '还没有添加。MCP 服务器能让助手使用更多工具，比如读写 GitHub、查询数据库。' }),
      extensions.adding ? serverForm(extensions, handlers) : null),
    h('div', { class: 'ext-group' },
      h('div', { class: 'row-between' },
        h('h3', { class: 'profile-heading', text: 'Skills' }),
        h('div', { class: 'profile-head-actions' },
          h('button', { class: 'btn btn-outline btn-small', type: 'button', text: '打开文件夹', onClick: handlers.openSkillDir }),
          h('button', { class: 'btn btn-outline btn-small', type: 'button', id: 'import-skill', disabled: extensions.busy, text: '导入', onClick: handlers.importSkill }))),
      extensions.skills.length
        ? h('ul', { class: 'ext-list' }, extensions.skills.map((skill) => skillItem(skill, extensions, handlers)))
        : null,
      h('p', { class: 'help', text: 'skill 是一份带 SKILL.md 的说明，教助手按你的方式做某类事。放进 skill 文件夹后会自动生效，不用重启。' })),
    extensions.error ? h('p', { class: 'form-error', role: 'alert', text: extensions.error }) : null,
    extensions.notice ? h('p', { class: 'form-notice', role: 'status', text: extensions.notice }) : null)
}
