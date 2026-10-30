import { localeRevision } from '../../shared/i18n/locale.ts'
import { t } from '../../shared/i18n/translate.ts'
import type { ResumeAsk } from '../resume-state.ts'
import { workspaceName } from '../selectors.ts'
import { h } from './dom.ts'

/**
 * 继续这个话题 waiting on the user (resume-state.ts): before switching to another directory; its directory gone;
 * its session gone. Going on from saved records says how much goes with it and that it is only for reference.
 */
const carryNote = () => t("resume.reference.note")

type Copy = { title: string, lines: Array<{ text: string, path?: boolean }>, main: string | null, choose: string | null }

function copyOf(asked: ResumeAsk): Copy {
  const dir = asked.cwd ?? t("resume.folder.unrecorded")
  if (asked.stage === 'confirm-dir') {
    return {
      title: t("resume.switch.folder.title"),
      lines: [{ text: t("resume.switch.folder.description", { p0: workspaceName(dir) }) }, { text: dir, path: true }],
      main: t("resume.switch.folder.confirm"), choose: null,
    }
  }
  if (asked.stage === 'missing-dir') {
    return {
      title: t("resume.folder.missing.title"),
      lines: [{ text: t("resume.folder.missing.description", { p0: dir }) }, { text: t("resume.choose.folder.note", { p0: carryNote() }) }],
      main: null, choose: t("resume.choose.folder.continue"),
    }
  }
  return {
    title: t("resume.session.gone.title"),
    lines: [{ text: t("resume.session.gone.description", { p0: carryNote() }) }, { text: t("resume.start.folder", { p0: dir }) }],
    main: t("resume.continue.records"), choose: t("resume.choose.another.folder"),
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
