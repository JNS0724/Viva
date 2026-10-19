/**
 * A stand-in mail MCP server for the policy tests: `send_email` would send (it appends to MAIL_SENT_FILE,
 * so a test can prove nothing went out), `create_draft` only drafts. Started by dsh over stdio.
 */
import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const sentFile = process.env.MAIL_SENT_FILE
const text = (value) => ({ content: [{ type: 'text', text: value }] })

function createServer() {
  const server = new McpServer({ name: 'fake-mail', version: '0.0.0' }, { capabilities: { tools: {} } })
  const message = z.object({ to: z.string(), body: z.string() })
  server.registerTool('send_email', { description: 'Send an email now.', inputSchema: message }, async ({ to, body }) => {
    fs.appendFileSync(sentFile, `${to}: ${body}\n`)
    return text('SENT')
  })
  server.registerTool('create_draft', { description: 'Save an email as a draft.', inputSchema: message }, async () => text('DRAFT SAVED'))
  return server
}

const handle = serveStdio(createServer)
process.stdin.on('end', () => handle.close().finally(() => process.exit(0)))
