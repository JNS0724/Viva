/**
 * Going back to something the user said and on from there with other words (phase 2, 「从这里重来」 and
 * 「改了重发」). The agent forks to before that turn (the viva-fork plugin finds it by the words); the timeline
 * goes on in a new segment holding what came before it and the new words; the segment left behind folds there.
 */
const MAX_TEXT_CHARS = 20_000

export const REWIND_PROBLEMS = Object.freeze({
  busy: '先停止当前任务，再回到前面重来',
  unsaved: '这句话还没有保存好，稍后再试',
  invalid: '在助手的记录里找不到这句话，没法从这里重来',
  missing: '当前对话已经结束，请稍后再试',
  unavailable: '这个版本的助手不支持回到前面，请更新 Viva',
})

const isText = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_CHARS
const isCount = (value) => Number.isSafeInteger(value) && value >= 0

/** words: what the user said there; occurrence: which such turn from the end; keep: messages before it; text: the new words. */
function checked(request) {
  const { words, occurrence = 0, keep, text } = request ?? {}
  if (!isText(words) || !isCount(occurrence) || !isCount(keep) || !isText(text)) throw new Error('invalid rewind request')
  return { words, occurrence, keep, text }
}

/**
 * @param {{ handle: (channel: string, listener: Function) => void }} ipcMain
 * @param {{
 *   db: ReturnType<import('./history-db.js').openHistoryDb>,
 *   current: () => object, setCurrent: (conversation: object) => void, isBusy: () => boolean,
 *   agentInfo: () => { mode?: string, model?: string },
 *   forkAgent: (request: { words: string, occurrence: number }) => Promise<{ ok: boolean, reason?: string, info?: object }>,
 * }} deps
 */
export function registerRewindIpc(ipcMain, { db, current, setCurrent, isBusy, agentInfo, forkAgent }) {
  async function rewind(request) {
    const { words, occurrence, keep, text } = checked(request)
    if (isBusy()) return { ok: false, problem: REWIND_PROBLEMS.busy }
    const previous = current()
    const stored = db.get(previous.id)
    if (stored?.messages[keep]?.text !== words) return { ok: false, problem: REWIND_PROBLEMS.unsaved }
    const forked = await forkAgent({ words, occurrence })
    if (!forked.ok) return { ok: false, problem: REWIND_PROBLEMS[forked.reason] ?? `没能回到那里（${forked.reason}）` }
    const kept = stored.messages.slice(0, keep)
    const { mode, model } = { ...agentInfo(), ...forked.info }
    const next = db.save(
      db.create({ sessionId: forked.info.sessionId, mode, model, cwd: previous.cwd, parentId: previous.parentId }),
      [...kept, { role: 'user', text, receipt: null }],
    )
    db.fold(previous.id, { into: next.id, at: keep })
    setCurrent(next)
    return { ok: true, info: forked.info, conversation: { id: next.id, messages: kept }, folds: db.foldsOf(next.id) }
  }

  ipcMain.handle('timeline:rewind', (_event, request) => rewind(request))
}
