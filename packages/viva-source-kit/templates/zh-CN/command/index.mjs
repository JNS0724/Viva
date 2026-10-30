// A Viva message source that wraps a command printing JSON (a mail or alert CLI). Viva runs this file; it runs the
// command, keeps the items newer than the cursor, and maps each to a message. Change toMessage (and, if your
// command can, pass the cursor to it so it only prints what is new).
import { execFile } from 'node:child_process'
import { defineSource } from 'viva-source-kit'

const TIMEOUT_MS = 45_000
const MAX_OUTPUT = 4 * 1024 * 1024
/** Viva takes at most this many messages from one poll. */
const MAX_MESSAGES = 200

/** Runs the command; on Windows a CLI installed by npm is a .cmd, which only starts through the shell. */
function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT, shell: process.platform === 'win32', windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message))
      else resolve(stdout)
    })
  })
}

/** ms since 1970, whether the command wrote ms or a date. */
const timeOf = (at) => (typeof at === 'number' ? at : Date.parse(at))

const argsOf = (config) => String(config.args ?? '').split(/\s+/).filter(Boolean)

/** TODO: map one item of your command's output to a message. */
function toMessage(item) {
  return {
    id: String(item.id),
    at: item.date ?? item.time,
    from: item.from,
    title: item.subject ?? item.title,
    text: item.preview ?? item.body,
  }
}

defineSource({
  async check(config) {
    await run(config.command, argsOf(config))
    return true
  },
  async poll(config, cursor) {
    const items = JSON.parse(await run(config.command, argsOf(config)))
    const list = Array.isArray(items) ? items : items.items ?? items.messages ?? []
    const messages = list.map(toMessage).filter((m) => m.id && Number.isFinite(timeOf(m.at)))
    // The cursor here is the newest time seen; only later items are handed in again.
    const since = cursor ? Date.parse(cursor) : 0
    const fresh = messages.filter((m) => timeOf(m.at) > since)
    const newest = Math.max(since, ...messages.map((m) => timeOf(m.at)))
    return { cursor: newest ? new Date(newest).toISOString() : null, messages: fresh.slice(0, MAX_MESSAGES) }
  },
})
