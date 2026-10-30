import { localeRevision } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import type { ResumeAsk } from '../resume-state.ts'
import { workspaceName } from '../selectors.ts'
import { h } from './dom.ts'

/**
 * 继续这个话题 waiting on the user (resume-state.ts): before switching to another directory; its directory gone;
 * its session gone. Going on from saved records says how much goes with it and that it is only for reference.
 */
const carryNote = () => t("merge.a.new.conversation.will.include.the.latest.turns.as.reference.only.instructions..36")

type Copy = { title: string, lines: Array<{ text: string, path?: boolean }>, main: string | null, choose: string | null }

function copyOf(asked: ResumeAsk): Copy {
  const dir = asked.cwd ?? t("merge.not.recorded.37")
  if (asked.stage === 'confirm-dir') {
    return {
      title: t("merge.switch.to.this.topic.s.folder.to.continue.38"),
      lines: [{ text: t("merge.this.topic.used.continuing.will.change.the.working.folder.to.39", { p0: workspaceName(dir) }) }, { text: dir, path: true }],
      main: t("merge.switch.and.continue.40"), choose: null,
    }
  }
  if (asked.stage === 'missing-dir') {
    return {
      title: t("merge.this.topic.s.folder.no.longer.exists.41"),
      lines: [{ text: t("merge.this.topic.used.which.cannot.be.found.the.original.session.requires.its.original.42", { p0: dir }) }, { text: t("merge.choose.a.folder.43", { p0: carryNote() }) }],
      main: null, choose: t("merge.choose.a.folder.and.continue.with.records.44"),
    }
  }
  return {
    title: t("merge.the.original.session.is.unavailable.45"),
    lines: [{ text: t("merge.the.assistant.no.longer.has.this.topic.s.session.46", { p0: carryNote() }) }, { text: t("merge.start.in.47", { p0: dir }) }],
    main: t("merge.continue.with.records.48"), choose: t("merge.choose.another.folder.49"),
  }
}

let shownLocale = -1
let shown: ResumeAsk | null = null

export function renderResumeDialog(root: HTMLElement, asked: ResumeAsk | null, handlers: Handlers) {
  if (asked === shown && shownLocale === localeRevision()) return
  shownLocale = localeRevision()
  shown = asked
  if (!asked) return root.replaceChildren()
  const copy = copyOf(asked)
  root.replaceChildren(h('div', { class: 'workdir-scrim', onClick: () => handlers.resumeDismiss() }),
    h('div', { class: 'workdir-sheet resume-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': copy.title },
      h('div', { class: 'workdir-sheet-title', text: copy.title }),
      ...copy.lines.map((line) => (line.path
        ? h('code', { class: 'resume-dir mono', text: line.text })
        : h('p', { class: 'workdir-sheet-text', text: line.text }))),
      h('div', { class: 'workdir-sheet-actions' },
        h('button', { class: 'btn btn-secondary', type: 'button', text: t("extensions.cancel"), onClick: () => handlers.resumeDismiss() }),
        copy.choose ? h('button', { class: `btn ${copy.main ? 'btn-secondary' : 'btn-primary resume-main'}`, type: 'button', text: copy.choose, onClick: () => handlers.resumeChooseDir() }) : null,
        copy.main ? h('button', { class: 'btn btn-primary resume-main', type: 'button', text: copy.main, onClick: () => handlers.resumeConfirm() }) : null)))
  return root.querySelector<HTMLElement>('.resume-main')?.focus()
}
