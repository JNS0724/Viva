import { test, expect } from './fixtures.ts'
import { run } from './smoke-kit.ts'
import { timelinePlace } from '../../src/renderer/timeline-search.ts'
import { dailyMemory, fileDetail, REPORT_MEMORY, REPORT_TITLE } from './smoke-memory.ts'
import { installedRecallScores } from './installed-recall-diagnostics.ts'
import { installedDiagnostics } from './diagnostics-artifact.ts'

test('installed artifact completes memory and restart acceptance', async ({ scenario }) => {
  expect(process.env.VIVA_SMOKE_EXECUTABLE, 'Set VIVA_SMOKE_EXECUTABLE to the installed application').toBeTruthy()
  const check = await scenario({ phase: 'memory', bridge: 'real' })
  await check.run('memory')
  await check.run('resume')
  await test.step('installed model resolves a cross-language memory', async () => {
    const app = check.current!
    const note = await dailyMemory(app.window, REPORT_TITLE)
    const { sources } = await run(app.window, fileDetail(note.identity))
    const place = (sources as Array<{ link: string | null }>).flatMap(({ link }) => link ? timelinePlace(link) ?? [] : [])[0]
    expect(place, 'The installed app must retain an original source link').toBeTruthy()
    const reopened = await run(app.window, `window.agent.resumeTopic(${JSON.stringify(place!.segmentId)})`)
    expect(reopened.ok).toBe(true)
    const offset = check.model!.requests.length
    const query = 'Weekly report is due to Zhang San every Friday by close of business.'
    await run(app.window, `window.agent.prompt(${JSON.stringify('查一下 ' + query)}, [], crypto.randomUUID())`)
    const replies = check.model!.requests.slice(offset).map(request => {
      const { messages } = request as { messages?: unknown[] }
      return JSON.stringify(messages?.at(-1) ?? null)
    }).filter(reply => reply.includes('tool_result'))
    const grounded = replies.some(reply => reply.includes(REPORT_MEMORY) && reply.includes('notes'))
    if (!grounded) console.log('[smoke] installed recall', JSON.stringify({ toolReplies: replies.length,
      empty: replies.some(reply => reply.includes('empty')), unavailable: replies.some(reply => reply.includes('unavailable')),
      ...await installedRecallScores(app, note.identity.id, query) }))
    expect(grounded, 'The installed ONNX runtime should send the grounded memory as a semantic tool result').toBe(true)
  })
  await test.step('installed diagnostics exports metadata and clears without restarting memory', async () => {
    await installedDiagnostics(check.current!, check.info.outputPath('diagnostics'), [REPORT_MEMORY, REPORT_TITLE])
  })
})
