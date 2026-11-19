// Send one complete file observation while the rest of this simulated scan never replies.
import { memoryFileRevision } from '../../src/memory/node/memory-file-store.ts'

process.send?.({ files: [{ path: 'digest/wiki/edited.md', revision: memoryFileRevision('edited') }], quarantined: [] })
process.on('message', () => {})
