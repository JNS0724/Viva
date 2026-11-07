import { t } from '../../shared/i18n/translate.ts'
import type { ImportCandidateView, ImportKind, ImportScanView, ImportSourceView } from '../capability-types.ts'
import { importCounts } from '../import-flow-state.ts'
import { h } from './dom.ts'

/**
 * 能力 · 导入 (import-flow-state.ts), in the place of the one picked, on the skills or the MCP tab: where from (the
 * places found, and for skills 选择文件夹…), then what is there, each checked: going in as it is, put right on the way
 * in, or not at all, with why. Those ticked go in. The kinds share all of it but their words.
 */
const TONE: Readonly<Record<ImportCandidateView['status'], string>> = { ready: 'ok', fixable: 'off', blocked: 'off' }
/** Only skills come from a folder of the user's choosing; MCP servers come from a client's settings. */
const CHOOSES: Readonly<Record<ImportKind, boolean>> = { skills: true, mcp: false }

/** Each kind's words for why one goes in as it does; one not listed (a reader newer than this) says what it was given. */
type Why = (candidate: ImportCandidateView) => string
const WHY: Readonly<Record<ImportKind, Readonly<Record<string, Why>>>> = {
  skills: {
    ready: () => t('capabilities.import.skills.why.ready'),
    name: (candidate) => t('capabilities.import.skills.why.name', { name: candidate.name }),
    taken: (candidate) => t('capabilities.import.skills.why.taken', { name: candidate.name }),
    'no-kebab': () => t('capabilities.import.skills.why.no-kebab'),
    frontmatter: () => t('capabilities.import.skills.why.frontmatter'),
    fields: () => t('capabilities.import.skills.why.fields'),
    invocation: () => t('capabilities.import.skills.why.invocation'),
  },
  mcp: {
    ready: () => t('capabilities.import.mcp.why.ready'),
    missing: (candidate) => t('capabilities.import.mcp.why.missing', { detail: candidate.detail ?? '' }),
    name: (candidate) => t('capabilities.import.mcp.why.name', { name: candidate.name }),
    taken: (candidate) => t('capabilities.import.mcp.why.taken', { name: candidate.name }),
    sse: () => t('capabilities.import.mcp.why.sse'),
    command: (candidate) => t('capabilities.import.mcp.why.command', { detail: candidate.detail ?? '' }),
    'inline-ref': () => t('capabilities.import.mcp.why.inline-ref'),
    invalid: (candidate) => t('capabilities.import.mcp.why.invalid', { detail: candidate.detail ?? '' }),
  },
}

const whyText = (kind: ImportKind, candidate: ImportCandidateView): string =>
  WHY[kind][candidate.why]?.(candidate) ?? candidate.detail ?? candidate.why

function head(title: string, handlers: Handlers) {
  return h('header', { class: 'tp-head' },
    h('h2', { class: 'tp-title', text: title }),
    h('button', { class: 'btn btn-text btn-small', type: 'button', text: t('extensions.cancel'), onClick: () => handlers.closeImport() }))
}

const errorLine = (state: State) => (state.importFlow.error ? h('p', { class: 'form-error', role: 'alert', text: state.importFlow.error }) : null)

function sourcesStep(kind: ImportKind, state: State, handlers: Handlers) {
  const busy = Boolean(state.importFlow.busy)
  const sources = state.importFlow.sources as readonly ImportSourceView[]
  const source = (id: string, label: string, where: string, count: string) => h('button', {
    class: 'cap-source', type: 'button', disabled: busy, onClick: () => handlers.scanImportSource(id),
  }, h('span', { class: 'cap-source-name', text: label }), where ? h('span', { class: 'cap-source-where mono', text: where }) : null,
  count ? h('span', { class: 'badge', text: count }) : null)
  return h('div', { class: 'tp-main' },
    head(t(`capabilities.import.${kind}.title`), handlers),
    h('div', { class: 'tp-scroll' },
      sources.length ? null : h('p', { class: 'help', text: t(`capabilities.import.${kind}.none`) }),
      ...sources.map((found) => source(found.id, found.label, found.where, t('capabilities.import.count', { count: found.count }))),
      CHOOSES[kind] ? source('choose', t('capabilities.import.choose'), '', '') : null,
      h('p', { class: 'help', text: t(`capabilities.import.${kind}.copies`) }),
      errorLine(state)))
}

function candidateRow(kind: ImportKind, candidate: ImportCandidateView, picked: boolean, busy: boolean, handlers: Handlers) {
  return h('label', { class: 'cap-candidate', 'data-status': candidate.status },
    h('input', {
      type: 'checkbox', checked: picked, disabled: candidate.status === 'blocked' || busy, name: `import-${candidate.entry}`,
      'aria-label': candidate.name, onChange: (event: Event) => handlers.pickImport(candidate.entry, (event.target as HTMLInputElement).checked),
    }),
    h('span', { class: 'cap-candidate-name', text: candidate.entry }),
    h('span', { class: 'ext-status', 'data-tone': TONE[candidate.status], text: whyText(kind, candidate) }))
}

function reviewStep(kind: ImportKind, scan: ImportScanView, state: State, handlers: Handlers) {
  const counts = importCounts(state)
  const busy = Boolean(state.importFlow.busy)
  const picks = state.importFlow.picks as readonly string[]
  return h('div', { class: 'tp-main' },
    head(scan.label, handlers),
    h('div', { class: 'tp-scroll' },
      h('p', { class: 'help', text: t('capabilities.import.summary', { ready: counts.ready, fixable: counts.fixable, blocked: counts.blocked }) }),
      scan.candidates.length
        ? h('div', { class: 'cap-candidates' }, scan.candidates.map((candidate) => candidateRow(kind, candidate, picks.includes(candidate.entry), busy, handlers)))
        : h('p', { class: 'help', text: t('capabilities.import.empty') }),
      h('div', { class: 'settings-actions' },
        h('button', { class: 'btn btn-accent btn-small', type: 'button', disabled: busy || !counts.picked, text: t('capabilities.import.go', { count: counts.picked }), onClick: () => handlers.importPicked() }),
        h('button', { class: 'btn btn-outline btn-small', type: 'button', disabled: busy, text: t('capabilities.import.back'), onClick: () => handlers.backToImportSources() })),
      errorLine(state)))
}

export function importMain(kind: ImportKind, state: State, handlers: Handlers): HTMLElement {
  const scan = state.importFlow.scan as ImportScanView | null
  return scan ? reviewStep(kind, scan, state, handlers) : sourcesStep(kind, state, handlers)
}
