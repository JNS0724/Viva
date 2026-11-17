import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const cache = process.argv[process.argv.indexOf('--cache') + 1]!
mkdirSync(path.join(cache, '_logs'), { recursive: true })
writeFileSync(path.join(cache, '_logs', 'fixture-debug-0.log'), [
  '0 verbose config token=PRIVATE_NPM_CONFIG_MUST_NOT_APPEAR',
  '1 silly reify moves {"PRIVATE_NPM_CONFIG_MUST_NOT_APPEAR":"private/location"}',
  '2 timing reify:unpack Completed in 17ms',
  '3 silly idealTree buildDeps',
  '4 error code EOFFLINE',
].join('\n'))
if (process.argv.includes('hang')) setInterval(() => {}, 1000)
else process.exitCode = 7
