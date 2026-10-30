/**
 * Files handed over with a question (dropped on the desktop island): the question names them in a block at
 * its end, which the model reads as plain text and the thread shows as file chips, also when an old
 * conversation is opened again. Nothing is copied; the paths are where the files already are.
 */
/** Where the block starts; the history looks for it to tell which topics had files with them. */
export const FILES_HEADER = '附带的文件（本机路径）：'
const HEADER = FILES_HEADER
const ITEM = '- '

/** The question as sent to the agent. */
export function withFiles(text: string, paths: readonly string[]): string {
  if (!paths.length) return text
  return `${text}\n\n${HEADER}\n${paths.map((item) => `${ITEM}${item}`).join('\n')}`
}

/** The question and the files it names. */
export function splitFiles(prompt: unknown): { text: string, files: string[] } {
  const text = String(prompt ?? '')
  const marker = `\n\n${HEADER}\n`
  const at = text.lastIndexOf(marker)
  if (at < 0) return { text, files: [] }
  const lines = text.slice(at + marker.length).split('\n')
  if (!lines.every((line) => line.startsWith(ITEM) && line.length > ITEM.length)) return { text, files: [] }
  return { text: text.slice(0, at), files: lines.map((line) => line.slice(ITEM.length)) }
}

/** The file's name from a path written on either platform. */
export const fileName = (filePath: unknown): string => String(filePath).split(/[\\/]/).filter(Boolean).pop() ?? String(filePath)
