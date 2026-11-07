import { t } from '../../shared/i18n/translate.ts'
import type { SkillCandidateView, SkillScanView, SkillSourceView } from '../capability-types.ts'
import { importCounts } from '../skill-import-state.ts'
import { h } from './dom.ts'

/**
 * 能力 · 技能 · 导入 (skill-import-state.ts), in the place of the skill picked: where from (the folders found, or
 * 选择文件夹…), then what is there, each checked by dsh's rules: going in as it is, put right on the way in (renamed
 * in the copy), or not at all, with why. Those ticked go in.
 */

/** Why one goes in under another name, or not at all. */
function whyText(candidate: SkillCandidateView): string {
  if (candidate.fix === 'name-format') return t('capabilities.import.fix.name', { name: candidate.name })
  if (candidate.fix === 'taken') return t('capabilities.import.fix.taken', { name: candidate.name })
  if (candidate.status === 'ready') return t('capabilities.import.ready')
  const issue = candidate.issues[0]
  return issue === 'name-format' ? t('capabilities.import.no.kebab') : t(`capabilities.issue.${issue ?? 'frontmatter'}`)
}

const TONE: Readonly<Record<SkillCandidateView['status'], string>> = { ready: 'ok', fixable: 'off', blocked: 'off' }

function head(title: string, handlers: Handlers, status: string | null = null) {
  return h('header', { class: 'tp-head' },
    h('h2', { class: 'tp-title', text: title }),
    status ? h('span', { class: 'tp-status', text: status }) : null,
    h('button', { class: 'btn btn-text btn-small', type: 'button', text: t('extensions.cancel'), onClick: () => handlers.closeSkillImport() }))
}

function sourcesStep(state: State, handlers: Handlers) {
  const busy = Boolean(state.skillImport.busy)
  const sources = state.skillImport.sources as readonly SkillSourceView[]
  const source = (id: string, label: string, where: string, count: string) => h('button', {
    class: 'cap-source', type: 'button', disabled: busy, onClick: () => handlers.scanSkillSource(id),
  }, h('span', { class: 'cap-source-name', text: label }), where ? h('span', { class: 'cap-source-where mono', text: where }) : null,
  count ? h('span', { class: 'badge', text: count }) : null)
  return h('div', { class: 'tp-main' },
    head(t('capabilities.import.title'), handlers),
    h('div', { class: 'tp-scroll' },
      sources.length ? null : h('p', { class: 'help', text: t('capabilities.import.none.found') }),
      ...sources.map((found) => source(found.id, found.label, found.where, t('capabilities.import.count', { count: found.count }))),
      source('choose', t('capabilities.import.choose'), '', ''),
      h('p', { class: 'help', text: t('capabilities.import.copies') }),
      state.skillImport.error ? h('p', { class: 'form-error', role: 'alert', text: state.skillImport.error }) : null))
}

function candidateRow(candidate: SkillCandidateView, picked: boolean, busy: boolean, handlers: Handlers) {
  const blocked = candidate.status === 'blocked'
  return h('label', { class: 'cap-candidate', 'data-status': candidate.status },
    h('input', {
      type: 'checkbox', checked: picked, disabled: blocked || busy, name: `skill-${candidate.entry}`,
      'aria-label': candidate.name, onChange: (event: Event) => handlers.pickSkill(candidate.entry, (event.target as HTMLInputElement).checked),
    }),
    h('span', { class: 'cap-candidate-name', text: candidate.entry }),
    h('span', { class: 'ext-status', 'data-tone': TONE[candidate.status], text: whyText(candidate) }))
}

function reviewStep(scan: SkillScanView, state: State, handlers: Handlers) {
  const counts = importCounts(state)
  const busy = Boolean(state.skillImport.busy)
  const picks = state.skillImport.picks as readonly string[]
  return h('div', { class: 'tp-main' },
    head(scan.label, handlers, t('capabilities.import.summary', { ready: counts.ready, fixable: counts.fixable, blocked: counts.blocked })),
    h('div', { class: 'tp-scroll' },
      scan.candidates.length
        ? h('div', { class: 'cap-candidates' }, scan.candidates.map((candidate) => candidateRow(candidate, picks.includes(candidate.entry), busy, handlers)))
        : h('p', { class: 'help', text: t('capabilities.import.empty') }),
      h('div', { class: 'settings-actions' },
        h('button', { class: 'btn btn-accent btn-small', type: 'button', disabled: busy || !counts.picked, text: t('capabilities.import.go', { count: counts.picked }), onClick: () => handlers.importPickedSkills() }),
        h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('capabilities.import.back'), onClick: () => handlers.backToSkillSources() })),
      state.skillImport.error ? h('p', { class: 'form-error', role: 'alert', text: state.skillImport.error }) : null))
}

export function skillImportMain(state: State, handlers: Handlers): HTMLElement {
  const scan = state.skillImport.scan as SkillScanView | null
  return scan ? reviewStep(scan, state, handlers) : sourcesStep(state, handlers)
}
