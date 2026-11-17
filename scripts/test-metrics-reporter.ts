import path from 'node:path'
import { tap } from 'node:test/reporters'
import type { TestEvent } from 'node:test/reporters'
import { createTestMetrics, writeTestMetrics } from './test-metrics.ts'

export default async function* testMetricsReporter(source: AsyncGenerator<TestEvent, void>) {
  const metrics = createTestMetrics(process.cwd())
  async function* observed() {
    for await (const event of source) {
      if (event.type === 'test:complete' && event.data.file && path.resolve(event.data.name) === event.data.file && event.data.details.type !== 'suite') {
        metrics.completeFile(event.data.file, event.data.details.duration_ms)
      }
      if ((event.type === 'test:pass' || event.type === 'test:fail') && event.data.file && event.data.details.type !== 'suite') {
        const outcome = event.data.todo ? 'todo' : event.data.skip ? 'skipped' : event.type === 'test:pass' ? 'passed' : 'failed'
        metrics.record(event.data.file, event.data.name, outcome, event.data.details.duration_ms)
      }
      yield event
    }
  }
  yield* tap(observed())
  const report = metrics.finish()
  if (process.env.VIVA_TEST_REPORT) writeTestMetrics(report, process.env.VIVA_TEST_REPORT, process.env.GITHUB_STEP_SUMMARY)
}
