import { openMemoryOwner } from '../../src/memory/node/owner.ts'
const root = process.argv[2]
if (!root) throw new Error('Missing memory root')
const owner = openMemoryOwner({ root, compute: () => null, route: () => null })
await owner.recover()
process.send?.({ ready: true })
process.on('message', async message => { if (message === 'close') { await owner.close(); process.disconnect?.() } })
