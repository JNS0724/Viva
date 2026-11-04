import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEnvelope, isEnvelope } from '../src/backend/envelope.ts'
import { DATA_KEY_FILE, loadDataKey } from '../src/main/data-key.ts'

/** A stand-in for safeStorage: reversible, marked, and refusing what it did not make. */
function fakeKeychain(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text: string) => Buffer.from(`kc:${text}`),
    decryptString: (data: Buffer) => {
      const text = data.toString('utf8')
      if (!text.startsWith('kc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString')
      return text.slice(3)
    },
  }
}

function folder(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viva-envelope-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the backend encrypts under the data key, and only that key opens it', () => {
  const key = randomBytes(32)
  const envelope = createEnvelope({ key })
  const sealed = envelope.encryptString('sk-test-一二三')
  assert.ok(isEnvelope(sealed))
  assert.equal(sealed.includes(Buffer.from('sk-test')), false, 'the key is not in the clear')
  assert.equal(envelope.decryptString(sealed), 'sk-test-一二三')
  assert.notDeepEqual(envelope.encryptString('same'), envelope.encryptString('same'), 'a new IV each time')
  assert.throws(() => createEnvelope({ key: randomBytes(32) }).decryptString(sealed), 'another key fails the tag')
  assert.throws(() => envelope.decryptString(Buffer.from('kc:unknown')), /cannot decrypt/, 'nothing else is read')
  const tampered = Buffer.from(sealed)
  tampered[tampered.length - 1] ^= 1
  assert.throws(() => envelope.decryptString(tampered))
})

test('without a data key encryption is unavailable, as safeStorage would say', () => {
  const envelope = createEnvelope({ key: null })
  assert.equal(envelope.isEncryptionAvailable(), false)
  assert.throws(() => envelope.encryptString('x'), /not available/)
  assert.throws(() => createEnvelope({ key: Buffer.alloc(8) }), /32 bytes/)
})

test('the data key is made once, kept under the keychain, and set aside when the keychain can no longer open it', (t) => {
  const dir = folder(t)
  const keychain = fakeKeychain()
  const first = loadDataKey({ dir, keychain })
  assert.equal(first?.length, 32)
  assert.ok(fs.readFileSync(path.join(dir, DATA_KEY_FILE), 'utf8').startsWith('kc:'), 'stored only as the keychain encrypted it')
  assert.deepEqual(loadDataKey({ dir, keychain }), first, 'the same key at the next launch')

  fs.writeFileSync(path.join(dir, DATA_KEY_FILE), 'not the keychain\'s')
  const problems: string[] = []
  const fresh = loadDataKey({ dir, keychain, onProblem: (message) => problems.push(message) })
  assert.notDeepEqual(fresh, first)
  assert.equal(problems.length, 1)
  assert.ok(fs.existsSync(path.join(dir, `${DATA_KEY_FILE}.unreadable`)))
  assert.equal(loadDataKey({ dir, keychain: fakeKeychain(false) }), null)
})
