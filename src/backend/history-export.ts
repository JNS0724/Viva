import { onLocaleChange } from '../shared/i18n/locale.ts'
import { t } from '../shared/i18n/translate.ts'
let FALLBACK_TITLE = t("main.history-export.conversation")
let SPEAKERS: Readonly<Record<string, string>> = { user: t("main.history-export.you"), assistant: t("main.history-export.assistant") }

/** What an export needs of a conversation and of its messages. */
interface ExportedConversation { title?: string | null, updatedAt: number, model?: string | null }
interface ExportedMessage { role: string, text: string }

const pad = (n: number) => String(n).padStart(2, '0')
const formatDate = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Notes ("已停止本轮任务。") become quotes; questions and answers get a speaker line. */
const messageBlock = (message: ExportedMessage) => (SPEAKERS[message.role]
  ? [SPEAKERS[message.role], '', message.text, '']
  : [`> ${message.text}`, ''])

/** One conversation as a Markdown document: heading, when / which model, then the exchange. */
export function toMarkdown(conversation: ExportedConversation, messages: readonly ExportedMessage[]): string {
  return [
    `# ${conversation.title || FALLBACK_TITLE}`,
    '',
    t("main.history-export.time", { value1: formatDate(conversation.updatedAt) }),
    ...(conversation.model ? [t("main.history-export.model", { model: conversation.model })] : []),
    '',
    '---',
    '',
    ...messages.flatMap(messageBlock),
  ].join('\n')
}

/** Suggested file name for the save dialog, without characters macOS / Windows reject. */
export function exportFileName(title: unknown): string {
  const safe = String(title ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim().replace(/^\.+/, '')
  return `${safe || FALLBACK_TITLE}.md`
}

onLocaleChange(() => {
  FALLBACK_TITLE = t("main.history-export.conversation")
  SPEAKERS = { user: t("main.history-export.you"), assistant: t("main.history-export.assistant") }
})
