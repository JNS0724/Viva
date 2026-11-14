import { test, expect } from './fixtures.ts'
import { finishTurn, newTopic, submit } from './smoke-kit.ts'

test('installed artifact completes memory and restart acceptance', async ({ scenario }) => {
  expect(process.env.VIVA_SMOKE_EXECUTABLE, 'Set VIVA_SMOKE_EXECUTABLE to the installed application').toBeTruthy()
  const run = await scenario({ phase: 'memory', bridge: 'real' })
  await run.run('memory')
  await run.run('resume')
  await test.step('installed model resolves a cross-language memory', async () => {
    const app = run.current!
    const offset = run.model!.requests.length
    await newTopic(app.window)
    await submit(app.window, '查一下 Weekly report is due to Zhang San every Friday by close of business.')
    await finishTurn(app.window)
    expect(run.model!.requests.slice(offset).some(request => {
      const { messages } = request as { messages?: unknown[] }
      const toolResult = JSON.stringify(messages?.at(-1) ?? null)
      return toolResult.includes('tool_result') && toolResult.includes('周报每周五下班前交给张三') && toolResult.includes('semantic')
    }), 'The installed ONNX runtime should send the grounded memory as a semantic tool result').toBe(true)
  })
})
