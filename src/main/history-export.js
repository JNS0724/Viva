const FALLBACK_TITLE = '对话'
const SPEAKERS = { user: '**你**', assistant: '**助手**' }

const pad = (n) => String(n).padStart(2, '0')
const formatDate = (ts) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Notes ("已停止本轮任务。") become quotes; questions and answers get a speaker line. */
const messageBlock = (message) => (SPEAKERS[message.role]
  ? [SPEAKERS[message.role], '', message.text, '']
  : [`> ${message.text}`, ''])

/** One conversation as a Markdown document: heading, when / which model, then the exchange. */
export function toMarkdown(conversation, messages) {
  return [
    `# ${conversation.title || FALLBACK_TITLE}`,
    '',
    `- 时间：${formatDate(conversation.updatedAt)}`,
    ...(conversation.model ? [`- 模型：${conversation.model}`] : []),
    '',
    '---',
    '',
    ...messages.flatMap(messageBlock),
  ].join('\n')
}

/** Suggested file name for the save dialog, without characters macOS / Windows reject. */
export function exportFileName(title) {
  const safe = String(title ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim().replace(/^\.+/, '')
  return `${safe || FALLBACK_TITLE}.md`
}
