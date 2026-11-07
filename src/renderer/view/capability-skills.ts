import { t } from '../../shared/i18n/translate.ts'
import { shownSkill, skillGroups } from '../capabilities-state.ts'
import type { SkillIssueCode, SkillView } from '../capability-types.ts'
import { h } from './dom.ts'
import { importing } from '../import-flow-state.ts'
import { importMain } from './import-flow.ts'

/**
 * 能力 · 技能 (view/capabilities.ts): the skills dsh finds, by where they are, and the one picked: what it says, where it
 * is, and dsh's checks on it, as far as it passes them. Only the app's own can be removed; the workspace's are the
 * project's files.
 */

/** dsh's checks, in the order it makes them; a skill passes those before its first issue. */
const CHECKS: ReadonlyArray<{ issue: SkillIssueCode, passed: () => string }> = [
  { issue: 'frontmatter', passed: () => t('capabilities.check.frontmatter') },
  { issue: 'fields', passed: () => t('capabilities.check.fields') },
  { issue: 'name-format', passed: () => t('capabilities.check.name') },
  { issue: 'invocation', passed: () => t('capabilities.check.invocation') },
]

const standing = (skill: SkillView) => (skill.issues?.length ? { tone: 'off', text: t('capabilities.skill.skipped') }
  : skill.shadowedBy ? { tone: 'off', text: t('capabilities.skill.hidden') }
    : { tone: 'ok', text: t('capabilities.skill.ready') })

export function skillsSide(state: State, handlers: Handlers): Node[] {
  const groups = skillGroups(state)
  const shown = shownSkill(state)
  const search = h('input', {
    class: 'field cap-search', type: 'search', name: 'skill-search', value: state.capabilities.query,
    placeholder: t('capabilities.search.skills'), 'aria-label': t('capabilities.search.skills'), autocomplete: 'off', spellcheck: 'false',
    onInput: (event: Event) => handlers.searchSkills((event.target as HTMLInputElement).value),
  })
  const rows = groups.flatMap((group) => [
    h('div', { class: 'tp-group' }, group.label, h('span', { class: 'tp-group-count', text: String(group.skills.length) })),
    ...group.skills.map((skill) => h('button', {
      class: 'tp-row cap-row', type: 'button', 'data-name': skill.name, 'aria-current': skill.id === shown?.id ? 'page' : null,
      onClick: () => handlers.selectCapability(skill.id),
    },
    h('span', { class: 'tp-name', text: skill.name }),
    h('span', { class: 'ext-status', 'data-tone': standing(skill).tone, text: skill.problem || standing(skill).text }))),
  ])
  const empty = (state.extensions.skills as readonly SkillView[]).length ? t('capabilities.no.match') : t('extensions.none.yet')
  const importing = h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t('capabilities.import'), onClick: () => handlers.openImport('skills') })
  return [h('div', { class: 'cap-search-row' }, search, importing), ...(rows.length ? rows : [h('p', { class: 'help cap-empty', text: empty })])]
}

/** dsh's checks the skill passed, then the one it fails, and whether another of its name is loaded instead. */
function checks(skill: SkillView) {
  const failed = CHECKS.findIndex((check) => skill.issues?.includes(check.issue))
  const passed = failed < 0 ? CHECKS : CHECKS.slice(0, failed)
  return h('ul', { class: 'cap-checks', 'aria-label': t('capabilities.checks') },
    passed.map((check) => h('li', { 'data-tone': 'ok', text: check.passed() })),
    failed >= 0 ? h('li', { 'data-tone': 'off', text: skill.problem ?? '' }) : null,
    failed < 0 ? h('li', { 'data-tone': skill.shadowedBy ? 'off' : 'ok', text: skill.shadowedBy ? t('capabilities.skill.hidden.by', { root: skill.shadowedBy }) : t('capabilities.check.unique') }) : null)
}

export function skillMain(state: State, handlers: Handlers): HTMLElement {
  if (importing(state, 'skills')) return importMain('skills', state, handlers)
  const skill = shownSkill(state)
  if (!skill) return h('div', { class: 'tp-main tp-empty' }, h('p', { class: 'empty', text: t('extensions.none.yet') }))
  const busy = Boolean(state.extensions.busy)
  return h('div', { class: 'tp-main' },
    h('header', { class: 'tp-head' },
      h('h2', { class: 'tp-title', text: skill.name }),
      h('span', { class: 'ext-status cap-standing', 'data-tone': standing(skill).tone, text: standing(skill).text })),
    h('div', { class: 'tp-scroll' },
      skill.description ? h('p', { class: 'cap-text', text: skill.description }) : null,
      h('dl', { class: 'cap-facts' },
        h('dt', { text: t('capabilities.where') }), h('dd', { text: skill.managed ? skill.rootLabel : `${skill.rootLabel} · ${t('capabilities.read.only')}` })),
      checks(skill),
      h('div', { class: 'settings-actions' },
        h('button', { class: 'btn btn-outline btn-small', type: 'button', text: t('capabilities.reveal'), onClick: () => handlers.revealSkill(skill.id) }),
        skill.managed ? h('button', {
          class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('extensions.remove'),
          'aria-label': t('extensions.remove.skill', { name: skill.name }), onClick: () => handlers.removeSkill(skill),
        }) : null)))
}
