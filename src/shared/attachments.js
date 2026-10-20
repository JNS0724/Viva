/**
 * Files handed over with a question (dropped on the desktop island): the question names them in a block at
 * its end, which the model reads as plain text and the thread shows as file chips, also when an old
 * conversation is opened again. Nothing is copied; the paths are where the files already are.
 */
const HEADER = '附带的文件（本机路径）：'
const ITEM = '- '

/** @param {string} text @param {string[]} paths @returns {string} the question as sent to the agent */
export function withFiles(text, paths) {
  if (!paths.length) return text
  return `${text}\n\n${HEADER}\n${paths.map((item) => `${ITEM}${item}`).join('\n')}`
}

/** @param {string} prompt @returns {{ text: string, files: string[] }} the question and the files it names */
export function splitFiles(prompt) {
  const text = String(prompt ?? '')
  const marker = `\n\n${HEADER}\n`
  const at = text.lastIndexOf(marker)
  if (at < 0) return { text, files: [] }
  const lines = text.slice(at + marker.length).split('\n')
  if (!lines.every((line) => line.startsWith(ITEM) && line.length > ITEM.length)) return { text, files: [] }
  return { text: text.slice(0, at), files: lines.map((line) => line.slice(ITEM.length)) }
}

/** The file's name from a path written on either platform. */
export const fileName = (filePath) => String(filePath).split(/[\\/]/).filter(Boolean).pop() ?? String(filePath)
