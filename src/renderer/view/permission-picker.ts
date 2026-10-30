import { onLocaleChange } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import { h } from './dom.ts'
import { icon } from './icons.ts'

/**
 * By the input: what the assistant may do without asking, and the menu to pick another level. The levels are
 * dsh's permission presets (plugins/permission); picking one restarts dsh on the conversation on screen.
 */
export let PERMISSION_LEVELS = Object.freeze([
  { value: 'read-only', name: t("permission-picker.read.only"), help: t("permission-picker.read.files.and.research.ask.before.changing") },
  { value: 'workspace-write', name: t("permission-picker.workspace.write"), help: t("permission-picker.change.files.and.run.commands.inside.the") },
  { value: 'auto', name: t("permission-picker.automatic"), tag: t("permission-picker.experimental"), help: t("permission-picker.the.model.reviews.each.step.routine.work") },
  { value: 'danger-full-access', name: t("permission-picker.full.access"), help: t("permission-picker.no.approval.prompts.can.change.any.file") },
])
const nameOf = (value: string) => PERMISSION_LEVELS.find((level) => level.value === value)?.name ?? value

/**
 * @param area #perm-area
 * @param handlers togglePermissionMenu, setPermission (level)
 * @param options ready: connected to an agent; busy: a turn runs
 */
export function renderPermissionPicker(area: HTMLElement, settings: { permission: string, permissionMenu: boolean, permissionBusy: boolean }, handlers: Handlers, { ready, busy }: { ready: boolean, busy: boolean }) {
  area.hidden = !ready
  if (!ready) return area.replaceChildren()
  const switching = settings.permissionBusy
  const button = h('button', {
    class: 'chip perm-chip', type: 'button', 'data-level': settings.permission, 'aria-haspopup': 'menu', 'aria-expanded': String(settings.permissionMenu),
    disabled: switching || busy, title: busy ? t("permission-picker.wait.for.this.turn.to.finish.before") : t("permission-picker.what.the.assistant.can.do.without.asking"),
    onClick: () => handlers.togglePermissionMenu(),
  }, h('span', { text: switching ? t("permission-picker.switching") : nameOf(settings.permission) }), icon('chevron', 14))
  const menu = settings.permissionMenu
    ? h('div', { class: 'perm-menu', role: 'menu' },
      h('div', { class: 'perm-menu-head', text: t("permission-picker.what.the.assistant.can.do.without.asking") }),
      ...PERMISSION_LEVELS.map((level) => h('button', {
        class: 'perm-item', type: 'button', role: 'menuitemradio', 'aria-checked': String(level.value === settings.permission), 'data-level': level.value,
        onClick: () => handlers.setPermission(level.value),
      },
      h('span', { class: 'perm-name' }, level.name, level.tag ? h('small', { class: 'perm-tag', text: level.tag }) : null),
      h('span', { class: 'perm-help', text: level.help }))))
    : null
  return area.replaceChildren(...[button, menu].filter((part) => part !== null))
}

onLocaleChange(() => {
  PERMISSION_LEVELS = Object.freeze([
  { value: 'read-only', name: t("permission-picker.read.only"), help: t("permission-picker.read.files.and.research.ask.before.changing") },
  { value: 'workspace-write', name: t("permission-picker.workspace.write"), help: t("permission-picker.change.files.and.run.commands.inside.the") },
  { value: 'auto', name: t("permission-picker.automatic"), tag: t("permission-picker.experimental"), help: t("permission-picker.the.model.reviews.each.step.routine.work") },
  { value: 'danger-full-access', name: t("permission-picker.full.access"), help: t("permission-picker.no.approval.prompts.can.change.any.file") },
])
})
