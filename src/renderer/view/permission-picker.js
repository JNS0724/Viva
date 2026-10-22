import { h } from './dom.js'
import { icon } from './icons.js'

/**
 * By the input: what the assistant may do without asking, and the menu to pick another level. The levels are
 * dsh's permission presets (plugins/permission); picking one restarts dsh on the conversation on screen.
 */
export const PERMISSION_LEVELS = Object.freeze([
  { value: 'read-only', name: '仅可查看', help: '只读文件、查资料；要改文件或跑会改东西的命令，先问你' },
  { value: 'workspace-write', name: '工作区修改', help: '在工作目录里随便改、跑命令；碰到工作目录外面的，先问你（默认）' },
  { value: 'auto', name: '自动', tag: '实验', help: '每一步先由模型判断：平常的直接做，删除原有文件、发出去、改系统设置才问你；会多用一些 token，也可能判断错' },
  { value: 'danger-full-access', name: '完全', help: '什么都不问，能改电脑上的任何文件。只在你信得过这件事时用' },
])
const nameOf = (value) => PERMISSION_LEVELS.find((level) => level.value === value)?.name ?? value

/**
 * @param {HTMLElement} area #perm-area
 * @param {{ permission: string, permissionMenu: boolean, permissionBusy: boolean }} settings
 * @param {{ togglePermissionMenu: () => void, setPermission: (level: string) => void }} handlers
 * @param {{ ready: boolean, busy: boolean }} options ready: connected to an agent; busy: a turn runs
 */
export function renderPermissionPicker(area, settings, handlers, { ready, busy }) {
  area.hidden = !ready
  if (!ready) return area.replaceChildren()
  const switching = settings.permissionBusy
  const button = h('button', {
    class: 'chip perm-chip', type: 'button', 'data-level': settings.permission, 'aria-haspopup': 'menu', 'aria-expanded': String(settings.permissionMenu),
    disabled: switching || busy, title: busy ? '等这一轮结束再换权限' : '助手不问你就能做什么',
    onClick: () => handlers.togglePermissionMenu(),
  }, h('span', { text: switching ? '切换中…' : nameOf(settings.permission) }), icon('chevron', 14))
  const menu = settings.permissionMenu
    ? h('div', { class: 'perm-menu', role: 'menu' },
      h('div', { class: 'perm-menu-head', text: '助手不问你就能做什么' }),
      ...PERMISSION_LEVELS.map((level) => h('button', {
        class: 'perm-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(level.value === settings.permission), 'data-level': level.value,
        onClick: () => handlers.setPermission(level.value),
      },
      h('span', { class: 'perm-name' }, level.name, level.tag ? h('small', { class: 'perm-tag', text: level.tag }) : null),
      h('span', { class: 'perm-help', text: level.help }))))
    : null
  return area.replaceChildren(...[button, menu].filter(Boolean))
}
