import { h, label } from './dom.ts'
import { icon } from './icons.ts'

/** The 扩展 part of the state (personal-state.ts). */
type Extensions = State['extensions']
/** An MCP server as the user set it up (mcp-config.ts), its secrets known only by name. */
type Server = {
  name: string, type: string, url?: string, command?: string, args: readonly string[],
  envNames: readonly string[], headerNames: readonly string[], missingNames?: readonly string[],
}
/** A skill dsh found, where, and whether it can be removed here. */
type Skill = { id: string, name: string, rootLabel: string, description?: string, problem?: string, managed?: boolean }
/** What the agent loaded this time (session-info.ts): servers connected or dropped, the memory plugin. */
type ExtensionStatus = { active: readonly string[], dropped: ReadonlyArray<{ name: string, reason: string }>, memory?: boolean, plugins?: ReadonlyArray<{ contract: string, problem?: string }> }
/** The server being edited (personal-state.ts EditDraft): the state's types widen it away, so it is written out here. */
type Draft = { name: string, type: string, keys: ReadonlyArray<{ id: number, name: string, saved: boolean }> }

const TYPE_LABEL: Readonly<Record<string, string>> = { stdio: '本地命令', http: '远程地址' }

/** A server still missing a key cannot work as it should, whatever the agent says about it. */
function serverStatus(server: Server, status: ExtensionStatus) {
  if (server.missingNames?.length) return { tone: 'off', text: `缺少密钥：${server.missingNames.join('、')}` }
  if (status.active.includes(server.name)) return { tone: 'ok', text: '已连接' }
  const dropped = status.dropped.find((item) => item.name === server.name)
  return { tone: 'off', text: dropped ? `未连接：${dropped.reason}` : '未连接' }
}

const smallButton = (text: string, extra: Record<string, unknown>) => h('button', { class: 'btn btn-outline btn-small', type: 'button', text, ...extra })

function serverItem(server: Server, extensions: Extensions, handlers: Handlers) {
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
    h('div', { class: 'ext-actions' },
      smallButton('编辑', { disabled: extensions.busy, 'aria-label': `编辑 MCP 服务器 ${server.name}`, onClick: () => handlers.editServer(server) }),
      smallButton('删除', { disabled: extensions.busy, 'aria-label': `删除 MCP 服务器 ${server.name}`, onClick: () => handlers.removeServer(server.name) })))
}

/** A key of the form: its name (typed, for a new one), and a value that, left blank, keeps the saved one. */
function keyRow(key: Draft['keys'][number], version: string, handlers: Handlers) {
  const nameCell = key.name
    ? h('span', { class: 'secret-key mono', text: key.name })
    : h('input', { class: 'field mono', name: `mcp-key-name-${key.id}`, 'data-version': version, placeholder: '名称，例如 API_TOKEN', autocomplete: 'off', spellcheck: 'false', 'aria-label': '密钥名称' })
  const placeholder = key.saved ? '保持不变（已加密保存）· 填写则替换' : key.name ? '还没有值，填上就能连接' : '值'
  return h('div', { class: 'secret-row', 'data-missing': String(Boolean(key.name) && !key.saved) },
    nameCell,
    h('input', {
      class: 'field', type: 'password', name: `mcp-key-${key.id}`, 'data-version': version, placeholder, autocomplete: 'off', spellcheck: 'false',
      'aria-label': key.name ? `${key.name} 的值` : '密钥的值',
    }),
    h('button', { class: 'secret-del', type: 'button', title: '删除这个密钥', 'aria-label': `删除密钥 ${key.name}`, onClick: () => handlers.removeEditKey(key.id) }, icon('close', 14)))
}

/** What the form holds, as extensions-ipc.ts formChanges takes it; fields of the other type are left out. */
function formValues(form: HTMLFormElement, draft: Draft) {
  const data = new FormData(form)
  const text = (name: string) => {
    const value = data.get(name)
    return typeof value === 'string' ? value : undefined
  }
  return {
    name: text('mcp-name'),
    type: draft.type,
    command: draft.type === 'stdio' ? text('mcp-command') : undefined,
    args: draft.type === 'stdio' ? text('mcp-args') : undefined,
    url: draft.type === 'http' ? text('mcp-url') : undefined,
    keys: draft.keys.map((key) => ({ name: key.name || (text(`mcp-key-name-${key.id}`) ?? '').trim(), value: text(`mcp-key-${key.id}`) ?? '' }))
      .filter((key) => key.name),
  }
}

const formRow = (title: string, field: HTMLElement, top = false) => h('div', { class: top ? 'ext-edit-row top' : 'ext-edit-row' }, label(title), field)

/** The server in place, as a form: what it runs or where it is, and its keys; saved keys stay unless typed again. */
function editItem(server: Server, draft: Draft, extensions: Extensions, handlers: Handlers) {
  const version = server.name
  const input = (name: string, value: string, extra: Record<string, unknown> = {}) =>
    h('input', { class: 'field mono', name, value, 'data-version': version, autocomplete: 'off', spellcheck: 'false', ...extra })
  const typeButton = (kind: string) => h('button', {
    type: 'button', 'aria-pressed': String(draft.type === kind), text: TYPE_LABEL[kind], onClick: () => handlers.setEditType(kind),
  })
  return h('li', { class: 'ext-item', 'data-name': server.name, 'data-editing': 'true' },
    h('form', {
      class: 'ext-edit', 'aria-label': `编辑 MCP 服务器 ${server.name}`,
      onSubmit: (event: SubmitEvent) => {
        event.preventDefault()
        handlers.saveServer(draft.name, formValues(event.currentTarget as HTMLFormElement, draft))
      },
    },
    h('div', { class: 'ext-edit-head' }, h('span', { class: 'ext-name', text: `编辑「${server.name}」` })),
    formRow('名称', input('mcp-name', server.name, { 'aria-label': '名称' })),
    formRow('连接方式', h('div', { class: 'seg', role: 'group', 'aria-label': '连接方式' }, typeButton('stdio'), typeButton('http'))),
    draft.type === 'http'
      ? formRow('地址', input('mcp-url', server.url ?? '', { placeholder: 'https://…', 'aria-label': '服务器地址' }))
      : [
        formRow('启动命令', input('mcp-command', server.command ?? '', { placeholder: '例如 npx', 'aria-label': '启动命令' })),
        formRow('参数', h('textarea', {
          class: 'field', name: 'mcp-args', rows: 2, 'data-version': version, spellcheck: 'false', placeholder: '每行一个', 'aria-label': '参数', text: server.args.join('\n'),
        }), true),
      ],
    formRow(draft.type === 'http' ? '请求头' : '环境变量', h('div', { class: 'secret-rows' },
      draft.keys.map((key) => keyRow(key, version, handlers)),
      h('button', { class: 'link-btn ext-add-key', type: 'button', text: '＋ 添加密钥', onClick: () => handlers.addEditKey() })), true),
    h('div', { class: 'ext-edit-foot' },
      h('button', { class: 'btn btn-accent btn-small', type: 'submit', disabled: extensions.busy, text: extensions.busy ? '保存中…' : '保存' }),
      smallButton('取消', { onClick: () => handlers.cancelEdit() }),
      h('p', { class: 'help', text: '密钥加密保存在这台电脑上；保存后会话自动重新连接一次' }))))
}

/** 从 dsh 导入, with where from: dsh's default folder, the one used last time, or another the user picks. */
function importButton(extensions: Extensions, handlers: Handlers) {
  const { dsh, importMenu } = extensions
  const item = (name: string, path: string, from: string) => h('button', {
    class: 'workdir-item', type: 'button', role: 'menuitem', onClick: () => handlers.importDsh(from),
  }, h('span', { class: 'workdir-item-name', text: name }), path ? h('span', { class: 'workdir-item-path mono', title: path, text: path }) : null)
  return h('div', { class: 'import-area' },
    h('button', {
      class: 'btn btn-outline btn-small import-btn', type: 'button', disabled: extensions.busy, 'aria-haspopup': 'menu', 'aria-expanded': String(importMenu),
      onClick: () => handlers.toggleImportMenu(),
    }, h('span', { text: extensions.busy && !extensions.editing ? '处理中…' : '从 dsh 导入' }), icon('chevron', 14)),
    importMenu ? [
      h('div', { class: 'import-scrim', onClick: () => handlers.closeImportMenu() }),
      h('div', { class: 'workdir-menu import-menu', role: 'menu', 'aria-label': '从哪个 dsh 导入' },
        h('div', { class: 'workdir-head', text: '从哪个 dsh 导入' }),
        item('默认位置', dsh.defaultLabel, 'default'),
        dsh.lastLabel ? item('上次用过', dsh.lastLabel, 'last') : null,
        h('div', { class: 'workdir-sep' }),
        item('选择其他 .dsh 文件夹…', '', 'choose'),
        h('p', { class: 'import-menu-foot', text: '密钥一起带过来；只读取，不会改动原来的 dsh 配置' })),
    ] : null)
}

function skillItem(skill: Skill, extensions: Extensions, handlers: Handlers) {
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
const memoryProblem = (status: ExtensionStatus) => (status.plugins ?? []).find((plugin) => plugin.contract === 'memory')?.problem

/** Said only when memory is off: when it works there is nothing to say. */
function memoryLine(status: ExtensionStatus) {
  if (status.memory) return null
  const problem = memoryProblem(status)
  return h('p', { class: 'ext-memory', 'data-on': 'false' },
    problem ? `记忆插件版本不兼容，这次对话不会自动记忆：${problem}` : '记忆插件没有加载，这次对话不会自动记忆。可以重启应用再试。')
}

const HINT = '想接入新的服务，或者把一套做法存下来，直接在对话里说，例如「帮我接入 GitHub」「把刚才的做法存成 skill」。'
  + '已经在 dsh 里配好的 MCP，点「从 dsh 导入」直接搬过来，密钥一起带上。'

/** The 扩展 part of settings: what is set up, each editable or removable; new servers come from dsh or the conversation. */
export function extensionsSection(extensions: Extensions, handlers: Handlers, { connected }: { connected: boolean }) {
  if (!extensions.loaded) return h('section', { class: 'ext' }, label('扩展'), h('p', { class: 'help', text: '读取中…' }))
  const editing = extensions.editing
  const serverView = (server: Server) => (editing?.name === server.name ? editItem(server, editing, extensions, handlers) : serverItem(server, extensions, handlers))
  return h('section', { class: 'ext', 'aria-label': '扩展' },
    label('扩展'),
    h('p', { class: 'help ext-hint', text: HINT }),
    connected ? memoryLine(extensions.status) : null,
    h('div', { class: 'ext-group' },
      h('div', { class: 'ext-group-head' },
        h('h3', { class: 'profile-heading', text: 'MCP 服务器' }),
        importButton(extensions, handlers)),
      extensions.importNote ? h('p', { class: 'ext-import-note', role: 'status', text: extensions.importNote }) : null,
      extensions.servers.length
        ? h('ul', { class: 'ext-list' }, extensions.servers.map(serverView))
        : h('p', { class: 'help', text: '还没有接入。' })),
    h('div', { class: 'ext-group' },
      h('h3', { class: 'profile-heading', text: 'Skills' }),
      extensions.skills.length
        ? h('ul', { class: 'ext-list' }, extensions.skills.map((skill: Skill) => skillItem(skill, extensions, handlers)))
        : h('p', { class: 'help', text: '还没有。' })),
    extensions.error ? h('p', { class: 'form-error', role: 'alert', text: extensions.error }) : null,
    extensions.notice ? h('p', { class: 'form-notice', role: 'status', text: extensions.notice }) : null)
}
