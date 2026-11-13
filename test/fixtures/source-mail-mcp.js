/**
 * A stand-in mail MCP server for 消息源 (test/sources-runtime.test.ts): `search_unread` lists unread mail as JSON
 * text, the shape most mail servers answer in; `send_email` would send (it appends to MAIL_SENT_FILE, so a test can
 * prove a source never calls it). Synthetic mail only. Started by dsh over stdio.
 */
import fs from 'node:fs'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const sentFile = process.env.MAIL_SENT_FILE
const INBOX = [
  { id: '<a1@example.test>', from: 'Alice <alice@example.test>', subject: '周五评审改到 15:00', preview: '会议室换到 B2，记得带原型。', date: '2026-11-12T08:00:00Z' },
  { id: '<n7@example.test>', from: 'Weekly <newsletter@example.test>', subject: '本周技术周刊', preview: '十篇文章推荐……', date: '2026-11-12T09:30:00Z' },
]

function createServer() {
  const server = new McpServer({ name: 'source-mail', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.registerTool('search_unread', { description: 'List unread messages as JSON (does not mark them read).', inputSchema: z.object({ since: z.string().optional() }) },
    async ({ since }) => ({ content: [{ type: 'text', text: JSON.stringify({ results: INBOX.filter((mail) => !since || mail.date > since) }) }] }))
  server.registerTool('send_email', { description: 'Send an email now.', inputSchema: z.object({ to: z.string(), body: z.string() }) }, async ({ to, body }) => {
    fs.appendFileSync(sentFile, `${to}: ${body}\n`)
    return { content: [{ type: 'text', text: 'SENT' }] }
  })
  return server
}

const handle = serveStdio(createServer)
process.stdin.on('end', () => handle.close().finally(() => process.exit(0)))
