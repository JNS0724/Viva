// A message source for tests (source@1): reads one request line, answers with one JSON line.
// mode picks how it behaves; messages are numbered, the cursor is the last number handed in.
let input = ''
process.stdin.on('data', (chunk) => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  const { mode = 'ok', total = 3, token } = request.config
  const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
  if (request.action === 'check') return say(token === 'good' ? { ok: true } : { ok: false, problem: '令牌不对' })
  if (mode === 'fail') {
    process.stderr.write('CLI 没登录\n')
    process.exit(2)
  }
  if (mode === 'slow') return setTimeout(() => say({ cursor: null, messages: [] }), 60_000)
  if (mode === 'garbage') return process.stdout.write('not json at all\n')
  if (mode === 'flood') return process.stdout.write('x'.repeat(2 * 1024 * 1024))
  if (mode === 'env') return say({ cursor: 'env', messages: [{ id: 'env', at: 1, title: Object.keys(process.env).sort().join(',') }] })
  const from = Number(request.cursor ?? 0)
  const to = Math.min(from + 2, total)
  const messages = []
  for (let n = from + 1; n <= to; n += 1) messages.push({ id: `a${n}`, at: `2026-10-25T0${n % 10}:00:00Z`, title: `告警 ${n}`, level: 'P1' })
  if (mode === 'bad-message') messages.push({ id: 'bad', at: 'yesterday', title: 'x' })
  process.stdout.write('polling…\n')
  say({ cursor: String(to), messages })
})
