// viva-source-kit: the runtime side of a Viva message source (source@1, docs/sources.md in the Viva repository).
// The app starts the source once per action, writes one JSON line on stdin ({ contract, action, config, cursor })
// and reads the last JSON line of stdout. defineSource does that reading and writing; the source only says how to
// check its config and how to fetch what came after a cursor.

/** The data folder the app gives this source, to keep its own files in (tokens it refreshed, caches). */
export const dataDir = () => process.env.VIVA_SOURCE_DATA ?? null

async function readRequest() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input)
  if (!request || typeof request !== 'object') throw new Error('收到的请求不是 JSON 对象')
  return request
}

/** check may answer true, a string (what is wrong), or { ok, problem }. */
function checkAnswer(answer) {
  if (answer === undefined || answer === true) return { ok: true }
  if (typeof answer === 'string') return { ok: false, problem: answer }
  return answer
}

const say = (value) => new Promise((resolve) => process.stdout.write(`${JSON.stringify(value)}\n`, resolve))

/**
 * Runs the source for the request on stdin and exits.
 * @param {{ poll: (config: Record<string, unknown>, cursor: string | null) => Promise<{ cursor: string | null, messages: object[] }> | { cursor: string | null, messages: object[] },
 *   check?: (config: Record<string, unknown>) => unknown }} source
 */
export async function defineSource(source) {
  if (typeof source?.poll !== 'function') throw new TypeError('defineSource 需要一个 poll(config, cursor) 函数')
  try {
    const request = await readRequest()
    const config = request.config ?? {}
    if (request.action === 'check') await say(checkAnswer(source.check ? await source.check(config) : true))
    else if (request.action === 'poll') await say(await source.poll(config, request.cursor ?? null))
    else throw new Error(`不认识的动作：${request.action}`)
  } catch (err) {
    // The app shows stderr's last lines as the reason; keep it to what the user can act on.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exitCode = 1
  }
}
