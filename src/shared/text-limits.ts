/** The existing main/task IPC limit, also checked before a renderer clears or forks a draft. */
export const MAX_MESSAGE_CHARS = 20_000
export const MESSAGE_TOO_LONG = '这段内容太长，一次最多 20,000 个字符。请缩短后再发，原文已保留。'
