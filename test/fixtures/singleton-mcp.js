/** A stdio MCP whose exclusive local port stands in for a locked browser profile or database. */
import net from 'node:net'
import fs from 'node:fs'
const [port, log] = process.argv.slice(2)
const record = kind => fs.appendFileSync(log, JSON.stringify({ kind, pid: process.pid }) + '\n')
const lock = net.createServer()
lock.on('error', () => { record('rejected'); process.exit(1) })
lock.listen(Number(port), '127.0.0.1', () => {
  record('ready')
  let input = ''
  process.stdin.on('data', chunk => {
    input += chunk
    const lines = input.split('\n'); input = lines.pop()
    for (const line of lines) {
      const message = JSON.parse(line)
      if (message.id === undefined) continue
      const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'singleton', version: '1' } }
        : message.method === 'tools/list' ? { tools: [] } : {}
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
    }
  })
  process.stdin.on('end', () => lock.close(() => process.exit(0)))
})
