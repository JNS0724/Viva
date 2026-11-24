import type { DiagnosticOperation } from '../contracts.ts'

/** Classification changes diagnostics only; dynamic names remain opaque identities. */
export function diagnosticOperationForChannel(channel: string): DiagnosticOperation {
  switch (channel) {
    case 'memory:get': return 'memory.get'
    case 'memory:forget-file': return 'memory.forget'
    case 'memory:undo-file': return 'memory.undo'
    case 'memory:rebuild-indexes': return 'memory.index'
    case 'memory:create-file': case 'memory:edit-file': case 'memory:set-file-enabled': return 'memory.write'
    case 'agent:prompt': return 'conversation.send'
    case 'agent:cancel': case 'agent:steer': return 'conversation.cancel'
    case 'history:resume-topic': return 'conversation.resume'
  }
  if (channel.startsWith('memory:')) return 'memory.recall'
  if (channel.startsWith('task:')) return 'task'
  if (channel.startsWith('schedules:')) return 'schedule'
  if (channel.startsWith('plugins:')) return 'plugin'
  if (channel.startsWith('island:')) return 'island'
  return 'ipc'
}
