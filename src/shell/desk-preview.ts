import type { MenuItemConstructorOptions } from 'electron'
import type { DeskPreviewDraft } from '../shared/desk-preview.ts'
import { t } from '../shared/i18n/translate.ts'
import type { createDeskIsland } from './desk-island.ts'

type Island = ReturnType<typeof createDeskIsland>
type Frame = Parameters<Island['showPreview']>[0]
const GROUPS = [
  'desk.preview.approval', 'desk.preview.question', 'desk.preview.attachments', 'desk.preview.offline',
  'desk.preview.switching', 'desk.preview.notice', 'desk.preview.answer', 'desk.preview.pending',
] as const

function frames(restored: boolean): readonly Frame[] {
  const idle = { form: 'idle', tone: 'idle', mood: 'idle', label: t('island-view.idle'), recent: [], still: true }
  const permission = {
    requestId: 'preview-approval', title: t('desk.preview.command'), command: 'npm test',
    options: [
      { optionId: 'allow', name: t('desk.preview.allow'), role: 'primary' },
      { optionId: 'always', name: t('desk.preview.always'), role: 'secondary' },
      { optionId: 'deny', name: t('approval.deny'), role: 'secondary' },
      { optionId: 'never', name: t('approval.always.deny'), role: 'secondary' },
    ],
  }
  const question = {
    questionId: 'preview-question', id: 'reader', text: t('desk.preview.readers') + ' ' + t('desk.preview.readers.detail'),
    options: [t('desk.preview.team'), t('desk.preview.department'), t('desk.preview.review.first')], skippable: true,
  }
  const approvalTask = { id: 'preview-check', title: t('desk.preview.check'), status: 'waiting', permission }
  const questionTask = { id: 'preview-sync', title: t('desk.preview.sync'), status: 'waiting', question }
  const background = { count: 2, waiting: 2, alsoWaiting: 1, items: [approvalTask, questionTask] }
  const asking = { ...idle, form: 'asking', tone: 'waiting', mood: 'ask', label: t('selectors.needs.your.answer'), question }
  const waiting = { ...idle, form: 'waiting', tone: 'waiting', mood: 'confirm', label: t('selectors.needs.your.approval'),
    permission, task: approvalTask.title, taskId: approvalTask.id, background }
  const draft: DeskPreviewDraft = { text: t('desk.preview.draft'), files: [
    { path: '/preview/meeting.txt', name: t('desk.preview.meeting.file'), size: 16_500 },
  ] }
  return [
    { view: { ...idle, tone: 'working', background }, panel: 'background', width: 364 },
    { view: asking, panel: 'request', focusBody: true },
    { view: idle, panel: 'input', focusBody: true, draft: { text: '', files: Array.from({ length: 10 }, (_, index) => ({
      path: '/preview/week-' + (index + 1) + '.pdf', name: t('desk.preview.report.file', { number: index + 1 }), size: 1_160_000,
    })) } },
    { view: { ...idle, form: 'pending', tone: 'pending', mood: 'offline', label: t('island-view.not.connected'), detail: t('selectors.set.up.a.model') }, panel: 'input' },
    { view: { ...idle, target: { blocked: !restored, label: t('desk.preview.topic') } }, panel: 'input', draft },
    { view: { ...asking, question: { ...question, text: t('desk.preview.readers') }, target: { working: true } }, panel: 'input', draft: { text: draft.text, files: [] } },
    { view: { ...idle, tone: 'working', background }, panel: 'background' },
    { view: waiting },
  ]
}

/** Own the temporary window and its fixture selection. The live island keeps receiving normal updates. */
export function createDeskPreview(createWindow: () => Island, suspendLive: (suspended: boolean) => void) {
  let window: Island | null = null
  let selected = 0
  let restored = false

  function select(index: number, showRestored = false) {
    selected = index
    restored = showRestored
    if (!window) {
      suspendLive(true)
      window = createWindow()
    }
    window.showPreview(frames(restored)[selected])
  }

  function close(restoreLive = true) {
    if (!window) return
    window.destroy()
    window = null
    if (restoreLive) suspendLive(false)
  }

  function menu(): MenuItemConstructorOptions {
    const submenu: MenuItemConstructorOptions[] = GROUPS.map((label, index) => ({
      label: String(index + 1).padStart(2, '0') + '  ' + t(label),
      type: 'radio', checked: window !== null && selected === index, click: () => select(index),
    }))
    if (window) {
      submenu.push({ type: 'separator' },
        { label: t('desk.preview.previous'), enabled: selected > 0, click: () => select(selected - 1) },
        { label: t('desk.preview.next'), enabled: selected < GROUPS.length - 1, click: () => select(selected + 1) })
      if (selected === 4) submenu.push({ label: t(restored ? 'desk.preview.show.switching' : 'desk.preview.show.restored'), click: () => select(4, !restored) })
      submenu.push({ label: t('desk.preview.exit'), click: () => close() })
    }
    return { label: t('desk.preview.menu'), submenu }
  }

  return { menu, close, island: () => window }
}
