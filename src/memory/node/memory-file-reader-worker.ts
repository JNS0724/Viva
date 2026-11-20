import { RequestTimeout } from '../../shared/request-budget.ts'
import { createMemoryPhysicalFileReader } from './memory-file-store.ts'

// The parent sends one path at a time and owns this process's lifetime.
process.once('disconnect', () => process.exit(0))
const root = process.argv[2]
if (root && process.send) {
  const send = process.send.bind(process)
  const read = createMemoryPhysicalFileReader(() => root)
  process.on('message', async (request: { workspace: string, path: string }) => {
    try {
      const file = await read(request.workspace, request.path)
      send(file ?? { missing: true })
    } catch (error) { send(error instanceof RequestTimeout ? { timedOut: true } : { unavailable: true }) }
  })
}
