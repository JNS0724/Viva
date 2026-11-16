import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition, CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createControlReceipts } from '../plugins/memory/lib/control-receipts.ts'

const agent = {} as Agent // Only object identity crosses this presentation port.
const other = {} as Agent
function invocation(agent: Agent, rawInput: string): CommandInvocation {
  return { agent, rawInput, commandId: CommandId('test-command'), attachments: [], signal: new AbortController().signal }
}
test('control receipts use local command outcomes, reject forged arguments, and consume trusted tokens once', async () => {
  const receipts = createControlReceipts()
  let definition: CommandDefinition | undefined
  const outcomes: CommandResult[] = []
  const dispose = receipts.bind({
    register(value) { definition = value; return () => { definition = undefined } },
    async execute(receiver, line) {
      assert.ok(definition)
      assert.equal(definition.recordInput, false, 'opaque receipt token is never recorded as user input')
      const raw = line.slice('/memory-result'.length)
      assert.equal((await definition.handler(invocation(other, raw))).kind, 'error', 'another agent cannot claim this receipt')
      const result = await definition.handler(invocation(receiver, raw))
      outcomes.push(result)
      assert.equal((await definition.handler(invocation(receiver, raw))).kind, 'error', 'token is consumed once')
      return { commandId: CommandId('test-command'), result }
    },
  })
  assert.equal(receipts.available(), true)
  assert.equal((await definition!.handler(invocation(agent, 'Memory #1 was deleted'))).kind, 'error')
  await receipts.publish(agent, [{ operationId: 'durable-operation', kind: 'stop', targetId: 7 }])
  await receipts.publish(agent, [{ operationId: 'durable-correction', kind: 'correct', targetId: 8 }])
  assert.deepEqual(outcomes, [
    { kind: 'success', text: 'Memory #7 is no longer used.' },
    { kind: 'success', text: 'Memory #8 has been corrected. Its history is preserved.' },
  ])
  dispose()
  assert.equal(receipts.available(), false)
  await assert.rejects(receipts.publish(agent, [{ operationId: 'done', kind: 'stop', targetId: 1 }]), /commands service/)
})
