import { test } from 'node:test'
import assert from 'node:assert/strict'
import { vivaFit } from '../src/backend/plugin-fit.ts'

/** Whether a dsh plugin works in Viva, read from its package.json (plugin-fit.ts). */

test('a plugin needing dsh\'s Web host does not work in Viva, which runs dsh over ACP: said with what it needs', () => {
  assert.deepEqual(vivaFit({ peerDependencies: { '@deepseek-ai/dsh-host-webserver': '0.2.0-rc.2', '@deepseek-ai/dsh-session': '0.2.0-rc.2' } }),
    { kind: 'needs-web', needs: ['@deepseek-ai/dsh-host-webserver'] })
  assert.deepEqual(vivaFit({ dependencies: { '@deepseek-ai/dsh-api-gateway': '1' } }), { kind: 'needs-web', needs: ['@deepseek-ai/dsh-api-gateway'] })
})

test('one with a part for dsh\'s Web client works, that part not shown; one with neither just works', () => {
  assert.deepEqual(vivaFit({ dsh: { bundle: { patch: 'p.yml' }, client: { platform: 'web' } } }), { kind: 'web-part' })
  assert.deepEqual(vivaFit({ dsh: { bundle: { patch: 'p.yml' } }, peerDependencies: { '@deepseek-ai/cordis': '~4.0.4' } }), { kind: 'fits' })
  assert.deepEqual(vivaFit({ peerDependencies: { '@deepseek-ai/dsh-web-search-deepseek': '1' } }), { kind: 'fits' }, 'dsh-web-* tools are not the Web host')
})

test('its author saying it works in Viva is taken; a manifest that cannot be read says nothing either way', () => {
  assert.deepEqual(vivaFit({ viva: { supports: true }, peerDependencies: { '@deepseek-ai/dsh-host-webserver': '1' } }), { kind: 'declared' })
  assert.deepEqual(vivaFit(null), { kind: 'unknown' })
  assert.deepEqual(vivaFit('not a manifest'), { kind: 'unknown' })
})
