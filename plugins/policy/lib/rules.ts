/**
 * The app's tool policy, decided in code before any tool runs. One rule for now, from the product's
 * promise: the assistant drafts mail and messages, the user sends them. An MCP tool whose own name says it
 * sends something (send_email, reply_message, postMessage…) is refused, whatever the model was told.
 */
export const DRAFT_ONLY = '按用户的设置，你只能起草，不能直接发送邮件或消息。请把起草好的内容交给用户，由用户自己发送。'

/** Words that mean the call puts something in front of other people. */
const OUTBOUND_WORDS = new Set(['send', 'reply', 'forward', 'post', 'publish', 'deliver', 'broadcast'])

/** `mcp__<server>__<tool>` → `<tool>`; null for dsh's own tools, which do not reach other people. */
function mcpToolName(name) {
  const parts = String(name ?? '').split('__')
  return parts[0] === 'mcp' && parts.length >= 3 ? parts.slice(2).join('__') : null
}

/** "send_email", "sendEmail", "reply-to-thread" → their words, lower case. */
const wordsOf = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/**
 * @param {{ name: string }} call the tool about to run
 * @returns {{ kind: 'deny', reason: string } | null} null leaves the call to dsh's usual approval
 */
export function decide({ name }) {
  const tool = mcpToolName(name)
  if (tool && wordsOf(tool).some((word) => OUTBOUND_WORDS.has(word))) return { kind: 'deny', reason: DRAFT_ONLY }
  return null
}
