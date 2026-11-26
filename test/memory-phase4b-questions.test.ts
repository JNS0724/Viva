import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { openMemoryOwner } from '../src/memory/node/owner.ts'
import { looksSecret } from '../src/memory/contracts/memory-sensitive.ts'
import { DREAM_PROFILE_SYSTEM } from '../src/memory/core/memory-dream-prompts.ts'
import { createQuestionDesk } from '../src/backend/question-channel.ts'
import { createQuestionChannel, type HumanQuestionReceipt } from '../plugins/questions/lib/channel.ts'
import { apply as applyQuestionsPlugin } from '../plugins/questions/index.ts'
import { createSessionIngestion, foldQuestionAnswersForTurn } from '../plugins/memory/lib/ingestion.ts'
import {
  areRawCardsMemoryEligible,
  canonicalEligibleAnswersDigest,
  eligibleQuestionAnswers,
  hasUnsupportedSqliteChars,
  questionAnswerSourceId,
  questionCallIdHash,
  questionOccurrenceRequestId,
  stripTrailingPromptPunctuation,
} from '../src/memory/node/question-answer-memory.ts'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function scratch(t: { after(fn: () => void | Promise<void>): void }, prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  const cleanups: Array<() => void | Promise<void>> = []
  t.after(async () => {
    for (let i = cleanups.length - 1; i >= 0; i--) {
      try { await cleanups[i]!() } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  })
  return { dir, defer: (fn: () => void | Promise<void>) => { cleanups.push(fn) } }
}

test('Phase 4B §5.5: shared Node helper screens raw option 9+, >200-char headers, split credentials, NUL/surrogates, and avoids ReDoS', () => {
  // 1. Raw option 9+ secret suppresses entire batch even when display truncates to 8 options.
  const nineOptions = Array.from({ length: 9 }, (_, i) => ({
    label: i === 8 ? 'OTP: 123456' : `选项 ${i + 1}`,
  }))
  assert.equal(areRawCardsMemoryEligible([{ id: 'c1', question: '请选择', options: nineOptions }]), false)
  assert.deepEqual(
    eligibleQuestionAnswers(
      [{ id: 'c1', question: '请选择', options: nineOptions }],
      [{ id: 'c1', selected: [], custom: '普通回答' }],
    ),
    [],
  )

  // 2. Contextual split credentials across bare, punctuated, formatted, & qualified OTP/password prompts, while safe siblings survive.
  assert.equal(looksSecret('OTP: 123 456'), true)
  assert.equal(looksSecret('TOTP: 123456'), true)
  assert.equal(looksSecret('OTP123456'), true)
  assert.equal(looksSecret('Your OTP is 123456'), true)
  assert.equal(looksSecret('Did OTP: 123 456 work?'), true)
  assert.equal(looksSecret('verification code: 123456'), true)
  assert.equal(looksSecret('one-time passcode is 123 456'), true)
  assert.equal(looksSecret('验证码：123-456'), true)
  assert.equal(looksSecret('OTP: 123'), false)
  assert.equal(areRawCardsMemoryEligible([{ id: 'c-qotp', question: 'Did OTP: 123 456 work?' }]), false)
  assert.equal(areRawCardsMemoryEligible([{ id: 'c-vcode', question: 'Did verification code: 123456 work?' }]), false)
  const cards = [
    { id: 'c-bare', question: 'OTP', header: 'Auth' },
    { id: 'c-en', question: 'What is your OTP?', header: 'Login' },
    { id: 'c-fmt', question: 'What is your OTP?', header: 'SMS' },
    { id: 'c-qual', question: 'What is the OTP sent to your phone?', header: 'Verify' },
    { id: 'c-any-otp', question: 'Any additional information?', header: 'Notes' },
    { id: 'c-any-otp-is', question: 'Any additional information?', header: 'Notes' },
    { id: 'c-zh', question: '请输入验证码：', header: '安全验证' },
    { id: 'c-pwd', question: 'Password?', header: 'Account' },
    { id: 'c-pwd-qual', question: 'What is the password for the account?', header: 'Login' },
    { id: 'c-pwd-mgr-pw', question: 'What is the password for the password manager?', header: 'Login' },
    { id: 'c-api-qual', question: 'What is the API key for staging?', header: 'Deploy' },
    { id: 'c-api-rot-val', question: 'What is the new API key after rotation?', header: 'Deploy' },
    { id: 'c-api-rot-short', question: 'New API key after rotation?', header: 'Deploy' },
    { id: 'c-api-clause-smuggle', question: 'Which API key should the integration use, and how long is it valid?', header: 'Deploy' },
    { id: 'c-api-compound-rot', question: 'How often should we rotate the API key and what is its current value?', header: 'Deploy' },
    { id: 'c-api-rot-bad-ans', question: 'How often should we rotate the API key?', header: 'Deploy' },
    { id: 'c-api-rot-paste', question: 'API key rotation is complete. Paste the new value for staging.', header: 'Deploy' },
    { id: 'c-api-rot-after', question: 'After API key rotation, what is the new value for staging?', header: 'Deploy' },
    { id: 'c-api-rot-hdr', question: 'Paste the new value for staging.', header: 'API key rotation' },
    { id: 'c-pwd-rot-which', question: 'Which password should I use after rotation?', header: 'Login' },
    { id: 'c-pwd-rot-after', question: 'What is the password after rotation?', header: 'Login' },
    { id: 'c-pwd-rot-sheet', question: 'What is the password for the rotation schedule spreadsheet?', header: 'Login' },
    { id: 'c-login-creds', question: 'Enter the login credentials from your password manager.', header: 'Staging' },
    { id: 'c-prod-secrets', question: 'Enter the production secrets from your password manager.', header: 'Prod' },
    { id: 'c-pin-unlock', question: 'Enter your PIN to unlock the device.', header: 'Device' },
    { id: 'c-totp-prompt', question: 'Enter the TOTP from your authenticator', header: '2FA' },
    { id: 'c-totp-custom', question: 'Any additional information?', header: 'Notes' },
    { id: 'c-otp-compact', question: 'Any additional information?', header: 'Notes' },
    { id: 'c-hdr', question: 'Enter value', header: `${' '.repeat(210)}OTP` },
    { id: 'c-footprint', question: 'What is the expected annual carbon footprint in tonnes?', header: 'Sustainability' },
    { id: 'c-bio-creds', question: 'What professional credentials should appear in your bio?', header: 'Profile' },
    { id: 'c-pref-mgr', question: 'Which password manager do you prefer?', header: 'Security' },
    { id: 'c-pref-mgr-type', question: 'What type of password manager do you use?', header: 'Security' },
    { id: 'c-pref-mgr-enter', question: 'Enter the name of your preferred password manager.', header: 'Security' },
    { id: 'c-pref-rot', question: 'How often should we rotate the API key?', header: 'Security' },
    { id: 'c-pref-rot-monthly', question: 'How often should we rotate the API key?', header: 'Security' },
    { id: 'c-pref-rot-pwd', question: 'How often should we rotate the password?', header: 'Security' },
    { id: 'c-pref-rot-pk', question: 'How often should we rotate the private key?', header: 'Security' },
    { id: 'c-pref-rot-rt', question: 'How often should we rotate the refresh token?', header: 'Security' },
    { id: 'c-pref-pol', question: 'What is the password rotation policy?', header: 'Security' },
    { id: 'c-tokens', question: 'Max output tokens?', header: 'Model' },
    { id: 'c-safe', question: 'Preferred drink?', header: 'Preference' },
  ]
  const answers = [
    { id: 'c-bare', selected: [], custom: '123456' },
    { id: 'c-en', selected: [], custom: '123456' },
    { id: 'c-fmt', selected: [], custom: '123 456' },
    { id: 'c-qual', selected: [], custom: '123456' },
    { id: 'c-any-otp', selected: [], custom: 'OTP: 123 456' },
    { id: 'c-any-otp-is', selected: [], custom: 'Your OTP is 123456' },
    { id: 'c-zh', selected: [], custom: '123456' },
    { id: 'c-pwd', selected: [], custom: 'hunter2' },
    { id: 'c-pwd-qual', selected: [], custom: 'shortpw' },
    { id: 'c-pwd-mgr-pw', selected: [], custom: 'masterpw' },
    { id: 'c-api-qual', selected: [], custom: 'my-staging-key' },
    { id: 'c-api-rot-val', selected: [], custom: 'new-key-123' },
    { id: 'c-api-rot-short', selected: [], custom: 'short-key' },
    { id: 'c-api-clause-smuggle', selected: [], custom: 'example-key, valid for 30 days' },
    { id: 'c-api-compound-rot', selected: [], custom: 'Every month. Current value is example-key' },
    { id: 'c-api-rot-bad-ans', selected: [], custom: 'Every 90 days; current key is abc123' },
    { id: 'c-api-rot-paste', selected: [], custom: 'sample-staging-key' },
    { id: 'c-api-rot-after', selected: [], custom: 'sample-staging-key' },
    { id: 'c-api-rot-hdr', selected: [], custom: 'sample-staging-key' },
    { id: 'c-pwd-rot-which', selected: [], custom: 'shortpw2' },
    { id: 'c-pwd-rot-after', selected: [], custom: 'Monthly!' },
    { id: 'c-pwd-rot-sheet', selected: [], custom: 'Quarterly.' },
    { id: 'c-login-creds', selected: [], custom: 'demo-user / demo-passphrase' },
    { id: 'c-prod-secrets', selected: [], custom: 'prod-secret-value' },
    { id: 'c-pin-unlock', selected: [], custom: '4826' },
    { id: 'c-totp-prompt', selected: [], custom: '123 456' },
    { id: 'c-totp-custom', selected: [], custom: 'TOTP: 123456' },
    { id: 'c-otp-compact', selected: [], custom: 'OTP123456' },
    { id: 'c-hdr', selected: [], custom: '123456' },
    { id: 'c-footprint', selected: [], custom: '1200' },
    { id: 'c-bio-creds', selected: [], custom: 'CPA' },
    { id: 'c-pref-mgr', selected: [], custom: 'Bitwarden' },
    { id: 'c-pref-mgr-type', selected: [], custom: 'Bitwarden' },
    { id: 'c-pref-mgr-enter', selected: [], custom: 'Bitwarden' },
    { id: 'c-pref-rot', selected: [], custom: 'Every 90 days' },
    { id: 'c-pref-rot-monthly', selected: [], custom: 'Monthly' },
    { id: 'c-pref-rot-pwd', selected: [], custom: 'Every 90 days' },
    { id: 'c-pref-rot-pk', selected: [], custom: 'Monthly' },
    { id: 'c-pref-rot-rt', selected: [], custom: 'Monthly' },
    { id: 'c-pref-pol', selected: [], custom: 'Every 90 days' },
    { id: 'c-tokens', selected: [], custom: '8192' },
    { id: 'c-safe', selected: [], custom: 'oolong tea' },
  ]
  const eligible = eligibleQuestionAnswers(cards, answers)
  assert.deepEqual(eligible, [
    { id: 'c-bio-creds', question: 'What professional credentials should appear in your bio?', custom: 'CPA' },
    { id: 'c-footprint', question: 'What is the expected annual carbon footprint in tonnes?', custom: '1200' },
    { id: 'c-pref-mgr', question: 'Which password manager do you prefer?', custom: 'Bitwarden' },
    { id: 'c-pref-mgr-enter', question: 'Enter the name of your preferred password manager.', custom: 'Bitwarden' },
    { id: 'c-pref-mgr-type', question: 'What type of password manager do you use?', custom: 'Bitwarden' },
    { id: 'c-pref-pol', question: 'What is the password rotation policy?', custom: 'Every 90 days' },
    { id: 'c-pref-rot', question: 'How often should we rotate the API key?', custom: 'Every 90 days' },
    { id: 'c-pref-rot-monthly', question: 'How often should we rotate the API key?', custom: 'Monthly' },
    { id: 'c-pref-rot-pk', question: 'How often should we rotate the private key?', custom: 'Monthly' },
    { id: 'c-pref-rot-pwd', question: 'How often should we rotate the password?', custom: 'Every 90 days' },
    { id: 'c-pref-rot-rt', question: 'How often should we rotate the refresh token?', custom: 'Monthly' },
    { id: 'c-safe', question: 'Preferred drink?', custom: 'oolong tea' },
    { id: 'c-tokens', question: 'Max output tokens?', custom: '8192' },
  ])

  // 3. SQLite-lossy NUL and unpaired UTF-16 surrogates are excluded from memory without throwing.
  assert.equal(hasUnsupportedSqliteChars('a\u0000b'), true)
  assert.equal(hasUnsupportedSqliteChars('bad\ud800surrogate'), true)
  assert.equal(hasUnsupportedSqliteChars('emoji 🙂 ok'), false)
  assert.deepEqual(
    eligibleQuestionAnswers(
      [{ id: 'c\u0000bad', question: 'Normal?' }],
      [{ id: 'c\u0000bad', selected: [], custom: 'valid text' }],
    ),
    [],
  )
  assert.deepEqual(
    eligibleQuestionAnswers(
      [{ id: 'c1', question: 'A?' }, { id: 'c2', question: 'B?' }],
      [
        { id: 'c1', selected: [], custom: 'has\u0000nul' },
        { id: 'c2', selected: [], custom: 'clean answer' },
      ],
    ),
    [{ id: 'c2', question: 'B?', custom: 'clean answer' }],
  )

  // 4. Linear O(n) timing across BOTH punctuation strip AND full eligibility/looksSecret on 32,000-char padded OTP headers.
  const paddedLeading = `${' '.repeat(32_000)}OTP`
  const paddedTrailing = `OTP${' '.repeat(32_000)}`
  const t0 = performance.now()
  assert.equal(stripTrailingPromptPunctuation(paddedLeading), paddedLeading)
  assert.equal(stripTrailingPromptPunctuation(paddedTrailing), 'OTP')
  assert.equal(areRawCardsMemoryEligible([{ id: 'pad1', question: 'Value?', header: paddedTrailing }]), true)
  assert.deepEqual(
    eligibleQuestionAnswers(
      [{ id: 'pad1', question: 'Value?', header: paddedTrailing }],
      [{ id: 'pad1', selected: [], custom: '123456' }],
    ),
    [],
  )
  assert.deepEqual(
    eligibleQuestionAnswers(
      [{ id: 'pad-rot', question: `How often should we rotate the API key${' .'.repeat(16_000)}!` }],
      [{ id: 'pad-rot', selected: [], custom: 'Every 90 days' }],
    ),
    [],
  )
  assert.ok(performance.now() - t0 < 100, 'full eligibility + OTP/cadence matchers must run in linear time without regex backtracking')
})

test('Phase 4B §5.5: host question-channel retains >200-char rawHeaders for unified eligibility and channel.ask never strands on receipt throw', async () => {
  const longOtpHeader = `${'x'.repeat(210)} OTP`
  const sentToPlugin: any[] = []
  const desk = createQuestionDesk({
    send: msg => { sentToPlugin.push(msg) },
    emit: () => {},
    sessionId: () => 'sess-hdr',
    profileDeletionGen: () => 2,
    onAnswer: (entry, answers, _op, meta) => {
      if (!entry.memoryEligible || !entry.callId || entry.callSeq === undefined) return
      const eligible = eligibleQuestionAnswers(meta?.rawCards ?? entry.question.questions, answers)
      if (!eligible.length) return
      const sourceIds: Record<string, string> = {}
      for (const item of eligible) {
        sourceIds[item.id] = questionAnswerSourceId(entry.sessionId, entry.callSeq, entry.callId, item.id)
      }
      return { conversationId: 'conv-hdr', sourceIds }
    },
  })
  await desk.receive({
    type: 'question',
    id: 'q-hdr-1',
    sessionId: 'sess-hdr',
    turn: 1,
    callId: 'call-hdr-1',
    callSeq: 4,
    memoryEligible: true,
    questions: [
      { id: 'otp-card', question: 'Enter code', header: longOtpHeader, options: [{ label: 'skip' }] },
      { id: 'safe-card', question: 'Favorite tea?', header: 'Drink', options: [{ label: 'tea' }] },
    ],
  })
  let capturedSourceIds: Readonly<Record<string, string>> | undefined
  assert.equal(
    await desk.answer(
      'q-hdr-1',
      [
        { id: 'otp-card', selected: [], custom: '123456' },
        { id: 'safe-card', selected: [], custom: 'jasmine tea' },
      ],
      undefined,
      { onSourceIds: ids => { capturedSourceIds = ids } },
    ),
    true,
  )
  // Displayed header was dropped (>200 chars), yet rawHeaders caught OTP + 123456 and preserved safe-card!
  assert.ok(capturedSourceIds)
  assert.equal(capturedSourceIds['otp-card'], undefined, 'long raw header OTP card must NOT receive a sourceId')
  assert.equal(
    capturedSourceIds['safe-card'],
    questionAnswerSourceId('sess-hdr', 4, 'call-hdr-1', 'safe-card'),
  )
  assert.equal(sentToPlugin.at(-1)?.provenance?.origin, 'human')
  assert.equal(sentToPlugin.at(-1)?.provenance?.answerProfileGen, 2)

  // Receipt hook throwing synchronously inside channel.ask MUST NOT strand the user's answer!
  const ipc = new EventEmitter()
  const logs: string[] = []
  const sentFromPlugin: any[] = []
  const channel = createQuestionChannel(
    { send: m => { sentFromPlugin.push(m) }, on: ipc.on.bind(ipc), off: ipc.off.bind(ipc) },
    msg => logs.push(msg),
    () => { throw new Error('simulated listener failure') },
  )
  const askPromise = channel.ask(
    {
      questions: [{ id: 'q1', question: 'City?', header: 'Location', options: [{ label: 'SH' }] }],
      agent: { session: { id: 'sess-throw' } },
    },
    1,
    { callSeq: 2, callId: 'call-throw', turn: 1, kind: 'native', openingProfileGen: 0 },
  )
  const qMsg = sentFromPlugin[0]
  assert.equal(qMsg.callId, 'call-throw')
  assert.equal(qMsg.callSeq, 2)
  assert.equal(qMsg.memoryEligible, true)
  ipc.emit('message', {
    type: 'answer',
    id: qMsg.id,
    answers: [{ id: 'q1', selected: [], custom: 'Hangzhou' }],
    provenance: { origin: 'human', conversationId: 'conv-throw', answeredAt: Date.now(), answerProfileGen: 0 },
  })
  const resolved = await askPromise
  assert.deepEqual(resolved, { answers: [{ id: 'q1', selected: [], custom: 'Hangzhou' }] })
  assert.ok(logs.some(line => line.includes('simulated listener failure')))
  channel.close()
})

test('Phase 4B §5.5-§5.7: native & PTC folding, policy rewrite digest guard, human/agent/SDK isolation, same-turn memory_remember, and interrupted PTC turn retirement', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4b-fold-')
  const tz = 'UTC'
  const sessionId = 'sess-fold-1'
  const nowMs = Date.parse('2026-11-26T00:00:00Z')

  // 1. Unit-level fold verification across native, PTC, compaction replace, error, spill preview, pending, selected-only, user-question-reply.
  const nativeCards = [
    { id: 'q1', question: 'Preferred editor?', header: 'Tools', options: [{ label: 'VSCode' }], multi_select: false },
    { id: 'q2', question: 'OTP?', header: 'Security', options: [{ label: 'None' }], multi_select: false },
  ]
  const ptcCards = [{ id: 'p1', question: 'Target region?', header: 'Deploy', options: [{ label: 'us-east' }] }]
  const turnEvents = [
    { seq: 0, time: nowMs, type: 'turn/start', data: { turn: 1 } },
    // Native valid call + result
    { seq: 1, time: nowMs + 1, type: 'tool/call', data: { turn: 1, step: 1, callId: 'nat-1', name: 'ask_user_question', arguments: JSON.stringify({ questions: nativeCards }) } },
    { seq: 2, time: nowMs + 5, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [1], data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'nat-1', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: 'Neovim' }, { id: 'q2', selected: [], custom: '123456' }] }) }] } } },
    // Compaction replacement must be ignored
    { seq: 3, time: nowMs + 6, type: 'tool/call', data: { turn: 1, step: 1, callId: 'nat-compact', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'c', question: 'Compacted?' }] }) } },
    { seq: 4, time: nowMs + 7, type: 'tool/result', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'nat-compact', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'c', selected: [], custom: 'must ignore' }] }) }] } } },
    // Error / TOOL_OUTCOME_UNKNOWN / spill preview / pending / selected-only must all be ignored
    { seq: 5, time: nowMs + 8, type: 'tool/call', data: { turn: 1, step: 1, callId: 'nat-err', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'e', question: 'Err?' }] }) } },
    { seq: 6, time: nowMs + 9, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [5], data: { turn: 1, step: 1, error: { name: 'Repair', code: 'TOOL_OUTCOME_UNKNOWN' }, message: { role: 'tool', toolCallId: 'nat-err', isError: true, content: [{ type: 'text', text: 'unknown' }] } } },
    { seq: 7, time: nowMs + 10, type: 'tool/call', data: { turn: 1, step: 1, callId: 'nat-spill', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 's', question: 'Spill?' }] }) } },
    { seq: 8, time: nowMs + 11, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [7], data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'nat-spill', content: [{ type: 'text', text: '{"answers":[{"id":"s","selected":[],"custom":"trunc...\n\n[...]\n\nSpilled to file' }] } } },
    { seq: 9, time: nowMs + 12, type: 'tool/call', data: { turn: 1, step: 1, callId: 'nat-pending', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'p', question: 'Pending?' }] }) } },
    { seq: 10, time: nowMs + 13, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [9], data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'nat-pending', content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'nat-pending', message: 'waiting' }) }] } } },
    { seq: 11, time: nowMs + 14, type: 'tool/call', data: { turn: 1, step: 1, callId: 'nat-sel', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'o', question: 'Selected only?', options: [{ label: 'Yes' }] }] }) } },
    { seq: 12, time: nowMs + 15, type: 'tool/result', surfaceOp: 'append', sourceEventSeqs: [11], data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'nat-sel', content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'o', selected: ['Yes'] }] }) }] } } },
    // PTC valid dispatch
    { seq: 13, time: nowMs + 16, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'root-1', parentCallId: 'parent-1', subCallId: 'root-1:ptc:1', name: 'ask_user_question', arguments: { questions: ptcCards } } },
    { seq: 14, time: nowMs + 17, type: 'tool/ptc-dispatch', data: { rootCallId: 'root-1', parentCallId: 'parent-1', subCallId: 'root-1:ptc:1', name: 'ask_user_question', arguments: { questions: ptcCards }, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'p1', selected: [], custom: 'ap-southeast-1' }] }) }] } },
    // Ignored user-question-reply user message
    { seq: 15, time: nowMs + 18, type: 'user/message', data: { id: 'uqr-1', role: 'user', source: { kind: 'user-question-reply', callId: 'nat-pending', outcome: 'answered' }, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'p', selected: [], custom: 'late reply' }] }) }] } },
  ] as unknown as SessionEvent[]

  const folded = foldQuestionAnswersForTurn(turnEvents, sessionId, tz)
  assert.equal(folded.length, 2, 'only valid native + PTC occurrences should fold')
  assert.equal(folded[0]!.callSeq, 1)
  assert.deepEqual(folded[0]!.items.map(i => [i.questionId, i.text]), [['q1', 'Neovim']], 'OTP sibling must be excluded while safe sibling survives')
  assert.equal(folded[1]!.callSeq, 13)
  assert.deepEqual(folded[1]!.items.map(i => [i.questionId, i.text]), [['p1', 'ap-southeast-1']])

  // 2. Policy rewrite scope: changing eligible custom text -> digest mismatch rejected; changing selected only -> admitted!
  const root = path.join(dir, 'mem-policy')
  const owner = openMemoryOwner({
    root,
    hostNamespace: 'viva',
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async () => ({ status: 'ok', assistant: '' }),
    compute: job => job.stage === 'note'
      ? Promise.resolve(JSON.stringify({ status: 'write', title: 'QA', markdown: 'QA note' }))
      : null,
  })
  defer(() => owner.close())
  await owner.recover()

  const sidPolicy = 'sess-policy-1', convPolicy = 'conv-policy-1'
  owner.beginTurn({ sessionId: sidPolicy, turn: 1, sessionKind: 'main', conversation: convPolicy, cwd: dir })

  // Receipt for callSeq=1 (human submitted 'Neovim'), but post-execute rewrote custom text to 'Emacs' -> MUST FAIL CLOSED!
  const call1Hash = questionCallIdHash('nat-1')
  const origDigest1 = canonicalEligibleAnswersDigest([{ id: 'q1', question: 'Preferred editor?', custom: 'Neovim' }])
  owner.recordQuestionReceipt({
    sessionId: sidPolicy, turn: 1, callSeq: 1, callIdHash: call1Hash, conversationId: convPolicy,
    answeredAt: nowMs + 4, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: origDigest1,
  })
  const rewrittenCustomDigest = canonicalEligibleAnswersDigest([{ id: 'q1', question: 'Preferred editor?', custom: 'Emacs' }])
  const rewrittenCand = {
    callSeq: 1, callIdHash: call1Hash, requestId: questionOccurrenceRequestId(1, call1Hash),
    questionAt: nowMs + 1, answerBatchDigest: rewrittenCustomDigest, timezone: tz,
    items: [{ sourceId: questionAnswerSourceId(sidPolicy, 1, 'nat-1', 'q1'), questionId: 'q1', question: 'Preferred editor?', text: 'Emacs' }],
  }

  // Receipt for callSeq=2 (human submitted selected=['A'], custom='Rust'); post-execute changed selected=['B'], custom='Rust' -> SAME eligible digest -> ADMITTED!
  const call2Hash = questionCallIdHash('nat-2')
  const digest2 = canonicalEligibleAnswersDigest([{ id: 'q2', question: 'Language?', custom: 'Rust' }])
  owner.recordQuestionReceipt({
    sessionId: sidPolicy, turn: 1, callSeq: 2, callIdHash: call2Hash, conversationId: convPolicy,
    answeredAt: nowMs + 6, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: digest2,
  })
  const selectedRewriteCand = {
    callSeq: 2, callIdHash: call2Hash, requestId: questionOccurrenceRequestId(2, call2Hash),
    questionAt: nowMs + 2, answerBatchDigest: digest2, timezone: tz,
    items: [{ sourceId: questionAnswerSourceId(sidPolicy, 2, 'nat-2', 'q2'), questionId: 'q2', question: 'Language?', text: 'Rust' }],
  }

  // Candidate for callSeq=3 with NO receipt (agent answer_background_task or standalone SDK JSON-RPC with identical text 'Rust') -> MUST FAIL CLOSED!
  const call3Hash = questionCallIdHash('nat-unreceipted')
  const unreceiptedCand = {
    callSeq: 3, callIdHash: call3Hash, requestId: questionOccurrenceRequestId(3, call3Hash),
    questionAt: nowMs + 3, answerBatchDigest: digest2, timezone: tz,
    items: [{ sourceId: questionAnswerSourceId(sidPolicy, 3, 'nat-unreceipted', 'q2'), questionId: 'q2', question: 'Language?', text: 'Rust' }],
  }

  // Same-turn memory_remember staging keeps receipt intact until settleTurn and admits custom:true proof!
  const staged = owner.stageOpenTurnSources({
    sessionId: sidPolicy, turn: 1, sessionKind: 'main', conversation: convPolicy, cwd: dir,
    sources: [],
    questionAnswers: [rewrittenCand, selectedRewriteCand, unreceiptedCand],
  })
  assert.deepEqual(staged.staged, [selectedRewriteCand.items[0]!.sourceId])
  const remembered = await owner.rememberSidecarFile(sidPolicy, 'Rust', new AbortController().signal)
  assert.ok(remembered, 'same-turn memory_remember must accept staged receipt-backed human custom answer')

  // Verify receipt still exists before settleTurn, then is retired cleanly at settleTurn!
  const db = new DatabaseSync(path.join(root, 'memory.db'), { readOnly: true })
  defer(() => db.close())
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get(sidPolicy)?.n, 2)

  await owner.settleTurn({
    sessionId: sidPolicy, cwd: dir, sessionKind: 'main', conversation: convPolicy, inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 10, turn: 1, reasonKind: 'completed',
    sources: [], questionAnswers: [rewrittenCand, selectedRewriteCand, unreceiptedCand],
    assistantText: '', at: nowMs + 10, timezone: tz,
  })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get(sidPolicy)?.n, 0,
    'terminal settleTurn must retire all receipts for settled turn')
  assert.equal(db.prepare('SELECT id FROM memory_sources WHERE id=?').get(rewrittenCand.items[0]!.sourceId), undefined,
    'policy-rewritten custom text must be rejected via digest mismatch')
  assert.equal(db.prepare('SELECT id FROM memory_sources WHERE id=?').get(unreceiptedCand.items[0]!.sourceId), undefined,
    'unreceipted agent/SDK answer with identical text must fail closed')
  const kept = db.prepare('SELECT author, profile_eligible, outcome FROM memory_sources WHERE id=?').get(selectedRewriteCand.items[0]!.sourceId) as
    { author: string, profile_eligible: number, outcome: string } | undefined
  assert.equal(kept?.author, 'answer')
  assert.equal(kept?.profile_eligible, 1)

  // 3. Interrupted PTC turn whose buffered call_seq=18 was lost before repair.ts closed at seq=6 STILL retires receipt by turn<=settledTurn!
  const sidPtcRepair = 'sess-ptc-repair'
  owner.beginTurn({ sessionId: sidPtcRepair, turn: 1, sessionKind: 'main', conversation: 'conv-ptc-r', cwd: dir })
  owner.recordQuestionReceipt({
    sessionId: sidPtcRepair, turn: 1, callSeq: 18, callIdHash: questionCallIdHash('ptc-lost'), conversationId: 'conv-ptc-r',
    answeredAt: nowMs + 20, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: digest2,
  })
  await owner.settleTurn({
    sessionId: sidPtcRepair, cwd: dir, sessionKind: 'main', conversation: 'conv-ptc-r', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 7, turn: 1, reasonKind: 'interrupted',
    sources: [], assistantText: '', at: nowMs + 30, timezone: tz,
  })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get(sidPtcRepair)?.n, 0,
    'interrupted turn repaired at seq=6 must still retire lost buffered PTC receipt at callSeq=18 via turn<=settledTurn')
})

test('Phase 4B §5.5: enqueue-time maxSeq on scanLive, entry-time liveEpoch on scanCold, and confirmed not-found receipt cleanup', async () => {
  // 1. Earlier queued synchronize() MUST NOT swallow a later turn/end appended after enqueueQuestionReceipt()!
  const events: SessionEvent[] = [
    { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent,
  ]
  const order: string[] = []
  let nextSeq: number | null = null
  const gate = deferred<void>()
  const firstEntered = deferred<void>()
  let holdFirst = true

  const session = {
    id: SessionId('sess-maxseq'),
    get seq() { return SessionSeq(events.length) },
    inheritedEventCount: 0,
    header: { id: SessionId('sess-maxseq'), cwd: '/tmp', version: 4, createdAt: 1000, isSeeded: false } as SessionHeader,
  } as unknown as Session

  const intake = createSessionIngestion(
    {
      epoch: 'e1',
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async () => {
        if (holdFirst) { holdFirst = false; firstEntered.resolve(); await gate.promise }
        return { createdAt: 0, nextSeq, inheritedSeq: 0, sessionKind: 'main', conversation: null }
      },
      advanceIntakeCursor: async input => { nextSeq = input.nextSeq; return { status: 'ok', nextSeq } },
      beginTurn: async () => {},
      recordQuestionReceipt: async () => { order.push('receipt') },
      stageOpenTurnSources: async () => ({ staged: [] }),
      settleTurn: async input => { order.push('settle'); nextSeq = input.toSeq; return { status: 'ok', nextSeq } },
    },
    { flush: async () => true, get: () => session },
    {
      open: async () => ({
        inheritedEventCount: 0,
        read: async (offset: number, limit: number) => ({ events: events.slice(offset, offset + limit) }),
        close: async () => {},
      }) as never,
      list: async () => [],
    },
    { host: true },
  )

  const sync1 = intake.synchronize(session) // captures targetEndSeq = 1
  await firstEntered.promise
  const receiptJob = intake.enqueueQuestionReceipt({
    sessionId: 'sess-maxseq', turn: 1, callSeq: 1, callIdHash: 'a'.repeat(64), conversationId: 'conv-1',
    answeredAt: 1005, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: 'b'.repeat(64),
  })
  events.push({ seq: 1, time: 1010, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent)
  const sync2 = intake.synchronize(session) // captures targetEndSeq = 2 AFTER receiptJob
  gate.resolve()
  await Promise.all([sync1, receiptJob, sync2])
  assert.deepEqual(order, ['receipt', 'settle'], 'enqueue-time maxSeq must prevent earlier scanLive from settling before later receipt')

  // 2. scanCold superseded across queued / cursor / read when session opens & closes mid-flight!
  for (const phase of ['queued', 'cursor', 'read'] as const) {
    const entered = deferred<void>()
    const resume = deferred<void>()
    let held = false
    const hold = async (where: typeof phase) => {
      if (!held && phase === where) { held = true; entered.resolve(); await resume.promise }
    }
    const coldEvents: SessionEvent[] = []
    const log: string[] = []
    let live: Session | undefined
    let cursorNext: number | null = null
    const liveSess = {
      id: SessionId('s-cold'),
      get seq() { return SessionSeq(coldEvents.length) },
      inheritedEventCount: 0,
      header: { id: SessionId('s-cold'), cwd: '/tmp', version: 4, createdAt: 1000, isSeeded: false } as SessionHeader,
    } as unknown as Session

    const coldIntake = createSessionIngestion(
      {
        epoch: 'e2',
        inEpoch: (_e, fn) => fn(),
        intakeCursor: async () => { await hold('cursor'); return { createdAt: 0, nextSeq: cursorNext, inheritedSeq: 0, sessionKind: 'main', conversation: null } },
        advanceIntakeCursor: async input => { cursorNext = input.nextSeq; return { status: 'ok', nextSeq: cursorNext } },
        beginTurn: async input => { if (input.turn === 99) await hold('queued') },
        recordQuestionReceipt: async () => { log.push('receipt') },
        stageOpenTurnSources: async () => ({ staged: [] }),
        settleTurn: async input => { log.push('settle'); cursorNext = input.toSeq; return { status: 'ok', nextSeq: cursorNext } },
      },
      { flush: async () => true, get: () => live },
      {
        open: async () => ({
          inheritedEventCount: 0,
          read: async (offset: number) => { await hold('read'); return { events: offset ? [] : coldEvents } },
          close: async () => {},
        }) as never,
        list: async () => [],
      },
      { host: true },
    )
    const blocker = phase === 'queued' ? coldIntake.beginTurn(liveSess, 99, []) : null
    const cold = coldIntake.scanCold('s-cold', liveSess.header)
    await entered.promise
    live = liveSess
    const rec = coldIntake.enqueueQuestionReceipt({
      sessionId: 's-cold', turn: 1, callSeq: 1, callIdHash: 'a'.repeat(64), conversationId: 'conv-c',
      answeredAt: 1005, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: 'b'.repeat(64),
    })
    coldEvents.push(
      { seq: 0, time: 1000, type: 'turn/start', data: { turn: 1 } } as unknown as SessionEvent,
      { seq: 1, time: 1010, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
    )
    const synced = coldIntake.synchronize(liveSess)
    live = undefined
    coldIntake.release(liveSess)
    resume.resolve()
    await Promise.all([blocker, cold, rec, synced])
    await coldIntake.drain()
    assert.deepEqual(log, ['receipt', 'settle'], `scanCold held at ${phase} must be superseded by liveEpoch`)
  }

  // 3. Confirmed SessionPersistenceNotFoundError retires orphan receipts; transient error retains them.
  const retired: string[] = []
  let openMode: 'not-found' | 'transient' = 'transient'
  const cleanupIntake = createSessionIngestion(
    {
      epoch: 'e3',
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async () => ({ createdAt: 0, nextSeq: null, inheritedSeq: 0, sessionKind: 'main', conversation: null }),
      advanceIntakeCursor: async input => ({ status: 'ok', nextSeq: input.nextSeq }),
      beginTurn: async () => {},
      retireSessionQuestionReceipts: async sid => { retired.push(sid) },
      stageOpenTurnSources: async () => ({ staged: [] }),
      settleTurn: async input => ({ status: 'ok', nextSeq: input.toSeq }),
    },
    { flush: async () => true, get: () => undefined },
    {
      open: async () => {
        if (openMode === 'not-found') throw new SessionPersistenceNotFoundError(SessionId('s-orphan'))
        throw new Error('EIO transient')
      },
      list: async () => [],
    },
    { host: true },
  )
  const hdr = { id: SessionId('s-orphan'), cwd: '/tmp', version: 4, createdAt: 1000, isSeeded: false } as SessionHeader
  await cleanupIntake.scanCold('s-orphan', hdr)
  assert.deepEqual(retired, [], 'transient I/O error must NOT retire receipts')
  openMode = 'not-found'
  await cleanupIntake.scanCold('s-orphan', hdr)
  assert.deepEqual(retired, ['s-orphan'], 'confirmed SessionPersistenceNotFoundError must retire orphan session receipts')
  await cleanupIntake.drain()
})

test('Phase 4B §5.5-§5.7: dual-generation profile deletion watermark (all 5 rows), clock-rollback answer guard, and persisted eventSeq revocation dependency', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4b-watermark-')
  let clock = Date.parse('2026-11-26T00:00:00Z')
  const dreamInputs: Array<Record<string, unknown>> = []
  const noteInputs: Array<{ turns: Array<{ user: Array<{ sourceId: string, text: string, question: string | null }> }> }> = []

  const root = path.join(dir, 'mem-wm')
  const owner = openMemoryOwner({
    root,
    hostNamespace: 'viva',
    now: () => clock,
    dailyNotes: { noteInterval: 1, timezone: 'UTC' },
    route: () => ({ provider: 'mock', model: 'mock' }),
    readSessionRange: async () => ({ status: 'ok', assistant: '' }),
    compute: job => {
      if (job.stage === 'note') {
        noteInputs.push(JSON.parse(job.input))
        return Promise.resolve(JSON.stringify({ status: 'write', title: '记录', markdown: '测试笔记' }))
      }
      if (job.stage === 'dream') {
        if (job.system === DREAM_PROFILE_SYSTEM) {
          dreamInputs.push(JSON.parse(job.input))
          return Promise.resolve(JSON.stringify({ action: 'NOOP' }))
        }
        return Promise.resolve(JSON.stringify({ operations: [] }))
      }
      return null
    },
  })
  defer(() => owner.close())
  await owner.recover()

  // Seed initial resident profile via forgettable flow: create a manual note -> trigger profile deletion generation 1.
  const db = new DatabaseSync(path.join(root, 'memory.db'))
  defer(() => db.close())
  // Set profile_deleted_at = clock (t0) and profile_deletion_generation = 1 directly on meta to test exact 5-row truth table + rollback!
  const deleteAt = clock + 100
  db.prepare("INSERT INTO memory_meta(key, value) VALUES ('profile_deleted_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(deleteAt))
  db.prepare("INSERT INTO memory_meta(key, value) VALUES ('profile_deletion_generation', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run()

  // Case A (Clock rollback late-insert attack):
  // User submitted at clock=deleteAt+50 (before clock rolled back to deleteAt!) with answerProfileGen=0!
  // Settlement runs after deletion -> answer_profile_gen (0) !== currentDelGen (1) -> MUST admit with profileEligible=0!
  const sidRollback = 'sess-rollback'
  const srcRollback = questionAnswerSourceId(sidRollback, 2, 'call-rb', 'q-rb')
  const digestRb = canonicalEligibleAnswersDigest([{ id: 'q-rb', question: 'Pre-del Q?', custom: 'pre-deletion rolled-back answer' }])
  owner.beginTurn({ sessionId: sidRollback, turn: 1, sessionKind: 'main', conversation: 'conv-rb', cwd: dir })
  owner.recordQuestionReceipt({
    sessionId: sidRollback, turn: 1, callSeq: 2, callIdHash: questionCallIdHash('call-rb'), conversationId: 'conv-rb',
    answeredAt: deleteAt + 50, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: digestRb,
  })
  await owner.settleTurn({
    sessionId: sidRollback, cwd: dir, sessionKind: 'main', conversation: 'conv-rb', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 4, turn: 1, reasonKind: 'completed',
    sources: [],
    questionAnswers: [{
      callSeq: 2, callIdHash: questionCallIdHash('call-rb'), requestId: questionOccurrenceRequestId(2, questionCallIdHash('call-rb')),
      questionAt: deleteAt - 20, answerBatchDigest: digestRb, timezone: 'UTC',
      items: [{ sourceId: srcRollback, questionId: 'q-rb', question: 'Pre-del Q?', text: 'pre-deletion rolled-back answer' }],
    }],
    assistantText: '', at: deleteAt + 60, timezone: 'UTC',
  })
  const rbRow = db.prepare('SELECT profile_eligible, at FROM memory_sources WHERE id=?').get(srcRollback) as { profile_eligible: number, at: number }
  assert.equal(rbRow.profile_eligible, 0, 'clock-rolled-back pre-deletion answer (answerProfileGen=0 !== delGen=1) MUST NOT be profileEligible')
  assert.equal(rbRow.at, deleteAt + 50, 'runtime.accept must persist receipt.answeredAt via 5th argument')

  // Case B (Blocking card open across deletion: openingProfileGen=0, submitted after deletion with answerProfileGen=1 & answeredAt > deleteAt)
  // Plus future-gen mismatch (questionProfileGen=2 > delGen=1), null questionProfileGen, and valid post-deletion (questionProfileGen=1 & questionAt > deleteAt)!
  const sidRows = 'sess-rows'
  const srcOpenAcross = questionAnswerSourceId(sidRows, 2, 'call-across', 'q-across')
  const srcFutureGen = questionAnswerSourceId(sidRows, 4, 'call-future', 'q-future')
  const srcNullGen = questionAnswerSourceId(sidRows, 6, 'call-null', 'q-null')
  const srcValidPost = questionAnswerSourceId(sidRows, 8, 'call-valid', 'q-valid')
  const makeRec = (callSeq: number, callId: string, qId: string, q: string, text: string, qGen: number | null, qAt: number) => {
    const h = questionCallIdHash(callId)
    const d = canonicalEligibleAnswersDigest([{ id: qId, question: q, custom: text }])
    owner.recordQuestionReceipt({
      sessionId: sidRows, turn: 1, callSeq, callIdHash: h, conversationId: 'conv-rows',
      answeredAt: deleteAt + 200, questionProfileGen: qGen, answerProfileGen: 1, answerBatchDigest: d,
    })
    return {
      callSeq, callIdHash: h, requestId: questionOccurrenceRequestId(callSeq, h),
      questionAt: qAt, answerBatchDigest: d, timezone: 'UTC',
      items: [{ sourceId: questionAnswerSourceId(sidRows, callSeq, callId, qId), questionId: qId, question: q, text }],
    }
  }
  owner.beginTurn({ sessionId: sidRows, turn: 1, sessionKind: 'main', conversation: 'conv-rows', cwd: dir })
  const cands = [
    makeRec(2, 'call-across', 'q-across', 'OLD QUESTION BEFORE DELETE', 'answer after delete', 0, deleteAt - 10),
    makeRec(4, 'call-future', 'q-future', 'FUTURE GEN QUESTION', 'answer future gen', 2, deleteAt + 10),
    makeRec(6, 'call-null', 'q-null', 'NULL GEN QUESTION', 'answer null gen', null, deleteAt + 10),
    makeRec(8, 'call-valid', 'q-valid', 'VALID POST DELETE QUESTION', 'answer valid post', 1, deleteAt + 20),
  ]
  await owner.settleTurn({
    sessionId: sidRows, cwd: dir, sessionKind: 'main', conversation: 'conv-rows', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 12, turn: 1, reasonKind: 'completed',
    sources: [], questionAnswers: cands, assistantText: '', at: deleteAt + 210, timezone: 'UTC',
  })
  await owner.runtime.wake()
  // Trigger manual Dream so DREAM_PROFILE_SYSTEM receives the exact gated question inputs!
  clock = deleteAt + 300
  owner.runtime.requestDream(randomUUID())
  await owner.runtime.wake()
  assert.ok(dreamInputs.length > 0, 'Dream profile planner must run')
  const latestDreamJson = JSON.stringify(dreamInputs.at(-1))
  assert.equal(latestDreamJson.includes('pre-deletion rolled-back answer'), false, 'clock-rolled-back answer must never enter Dream profile input')
  assert.equal(latestDreamJson.includes('answer after delete'), true, 'post-deletion custom answer to pre-deletion card must enter Dream')
  assert.equal(latestDreamJson.includes('OLD QUESTION BEFORE DELETE'), false, 'pre-deletion question (gen=0) must be withheld from Dream')
  assert.equal(latestDreamJson.includes('FUTURE GEN QUESTION'), false, 'mismatched future questionProfileGen (2 !== 1) must be withheld from Dream')
  assert.equal(latestDreamJson.includes('NULL GEN QUESTION'), false, 'missing/null questionProfileGen after deletion must be withheld from Dream')
  assert.equal(latestDreamJson.includes('VALID POST DELETE QUESTION'), true, 'valid post-deletion question (gen=1, questionAt > watermark) must reach Dream')
  assert.ok([srcOpenAcross, srcFutureGen, srcNullGen, srcValidPost].every(id => db.prepare('SELECT profile_eligible FROM memory_sources WHERE id=?').get(id)?.profile_eligible === 1))

  // Case C (Clock rollback same-turn revocation dependency via persisted eventSeq):
  // Prompt at eventSeq=1, at=deleteAt+500; question at callSeq=3, questionAt=deleteAt+495 (5ms clock rollback!).
  const sidSeq = 'sess-seq-dep'
  const promptId = randomUUID()
  const ansSeqId = questionAnswerSourceId(sidSeq, 3, 'call-seq', 'q-seq')
  const digestSeq = canonicalEligibleAnswersDigest([{ id: 'q-seq', question: 'Sensitive prompt followup?', custom: 'keeps custom text' }])
  owner.beginTurn({ sessionId: sidSeq, turn: 1, sessionKind: 'main', conversation: 'conv-seq', cwd: dir })
  owner.recordQuestionReceipt({
    sessionId: sidSeq, turn: 1, callSeq: 3, callIdHash: questionCallIdHash('call-seq'), conversationId: 'conv-seq',
    answeredAt: deleteAt + 510, questionProfileGen: 1, answerProfileGen: 1, answerBatchDigest: digestSeq,
  })
  await owner.settleTurn({
    sessionId: sidSeq, cwd: dir, sessionKind: 'main', conversation: 'conv-seq', inheritedSeq: 0,
    expectedNextSeq: null, fromSeq: 0, toSeq: 6, turn: 1, reasonKind: 'completed',
    sources: [{ sourceId: promptId, author: 'user', sourceKind: 'main-human', profileEligible: true, text: '同轮前置敏感原话', eventSeq: 1, at: deleteAt + 500, timezone: 'UTC' }],
    questionAnswers: [{
      callSeq: 3, callIdHash: questionCallIdHash('call-seq'), requestId: questionOccurrenceRequestId(3, questionCallIdHash('call-seq')),
      questionAt: deleteAt + 495, answerBatchDigest: digestSeq, timezone: 'UTC',
      items: [{ sourceId: ansSeqId, questionId: 'q-seq', question: 'Sensitive prompt followup?', text: 'keeps custom text' }],
    }],
    assistantText: '', at: deleteAt + 520, timezone: 'UTC',
  })
  const depRow = db.prepare('SELECT question_sources_json FROM memory_sources WHERE id=?').get(ansSeqId) as { question_sources_json: string }
  assert.ok(depRow.question_sources_json.includes(promptId),
    'persisted eventSeq (1 < 3) must record same-turn prompt as question dependency even when wall clock rolled back 5ms')
})

test('Phase 4B §5.5: viva-questions plugin observes starts, evicts denied calls on step/end, samples openingProfileGen, and emits receipts', async t => {
  const ctx = new Context()
  const ipc = new EventEmitter()
  const sent: any[] = []
  const port = Object.assign(ipc, { send: (msg: object) => { sent.push(msg); return true } }) as unknown as NodeJS.Process
  const receipts: HumanQuestionReceipt[] = []
  let cachedDelGen: number | null = 3

  // Provide minimal agents service for turnBoundaryOf.
  ctx.provide('agents', { turnBoundaryOf: () => ({ openTurnStartSeq: 0, lastTurn: 2 }) } as never)
  ctx.on('viva-memory/read-profile-deletion-gen', probe => { probe.value = cachedDelGen })
  ctx.on('viva-questions/human-answer-receipt', receipt => { receipts.push(receipt) })

  applyQuestionsPlugin(ctx, {}, port)
  t.after(() => ctx.fiber.dispose())

  const session = { id: SessionId('sess-plugin') } as unknown as Session

  // 1. Denied call in step 1 (never enters tools/execute) is evicted on step/end so step 2 reusing callId claims seq 10 (not seq 1)!
  ctx.emit('session/event', session, { seq: SessionSeq(1), time: 100, type: 'tool/call', data: { turn: 2, step: 1, callId: 'dup-id', name: 'ask_user_question', arguments: '{}' } } as never)
  ctx.emit('session/event', session, { seq: SessionSeq(2), time: 101, type: 'step/end', data: { turn: 2, step: 1 } } as never)
  cachedDelGen = 4
  ctx.emit('session/event', session, { seq: SessionSeq(10), time: 200, type: 'tool/call', data: { turn: 2, step: 2, callId: 'dup-id', name: 'ask_user_question', arguments: '{}' } } as never)

  const askResult = await ctx.waterfall(
    'tools/execute',
    { name: 'ask_user_question', callId: 'dup-id', agent: { session } } as never,
    async () => {
      const reqPromise = ctx.waterfall(
        'user-questions/request',
        {
          questions: [{ id: 'q1', question: 'Confirm color?', header: 'Color', options: [{ label: 'Blue' }] }],
          agent: { session },
        } as never,
        () => Promise.reject(new Error('no answerer')),
      )
      const qMsg = sent.at(-1)
      assert.equal(qMsg.callSeq, 10, 'must claim step 2 start (seq 10), not evicted step 1 start (seq 1)')
      assert.equal(qMsg.callId, 'dup-id')
      assert.equal(qMsg.memoryEligible, true)
      ipc.emit('message', {
        type: 'answer',
        id: qMsg.id,
        answers: [{ id: 'q1', selected: [], custom: 'Emerald' }],
        provenance: { origin: 'human', conversationId: 'conv-plugin', answeredAt: 250, answerProfileGen: 4 },
      })
      return await reqPromise
    },
  )
  assert.deepEqual(askResult, { answers: [{ id: 'q1', selected: [], custom: 'Emerald' }] })
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0]!.callSeq, 10)
  assert.equal(receipts[0]!.turn, 2)
  assert.equal(receipts[0]!.questionProfileGen, 4, 'openingProfileGen must be sampled at start-event observation time')
  assert.equal(receipts[0]!.answerProfileGen, 4)
  assert.equal(receipts[0]!.conversationId, 'conv-plugin')
})

test('Phase 4B Codex R1 P2-2..P2-4: sequential PTC callId reuse across live/cold replay, absent persistence retry, and TTL exclusion for active sessions', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4b-r1-fixes-')
  const tz = 'UTC'
  const nowMs = Date.parse('2026-11-26T00:00:00Z')

  // 1. Sequential PTC calls reusing identical (subCallId, parentCallId, rootCallId) fold BOTH human answers in live + cold replay!
  const ptcCard1 = [{ id: 'p1', question: 'First PTC choice?' }]
  const ptcCard2 = [{ id: 'p2', question: 'Second PTC choice?' }]
  const ptcEvents = [
    { seq: 0, time: nowMs, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: nowMs + 1, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: ptcCard1 } } },
    { seq: 2, time: nowMs + 2, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: ptcCard1 }, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'p1', selected: [], custom: 'Alpha answer' }] }) }] } },
    { seq: 3, time: nowMs + 3, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: ptcCard2 } } },
    { seq: 4, time: nowMs + 4, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: ptcCard2 }, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'p2', selected: [], custom: 'Beta answer' }] }) }] } },
    { seq: 5, time: nowMs + 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]

  const foldedPtc = foldQuestionAnswersForTurn(ptcEvents, 'sess-ptc-seq', tz)
  assert.equal(foldedPtc.length, 2, 'both sequential PTC calls reusing the same subCallId tuple must fold')
  assert.deepEqual(foldedPtc.map(c => [c.callSeq, c.items[0]!.text]), [[1, 'Alpha answer'], [3, 'Beta answer']])

  // Verify end-to-end cold replay settlement of both sequential PTC answers through openMemoryOwner + createSessionIngestion!
  const rootPtc = path.join(dir, 'mem-ptc-seq')
  const ownerPtc = openMemoryOwner({
    root: rootPtc, hostNamespace: 'viva', now: () => nowMs - 1000, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerPtc.close())
  await ownerPtc.recover()
  const ptcSid = 'sess-ptc-seq'
  for (const cand of foldedPtc) {
    ownerPtc.recordQuestionReceipt({
      sessionId: ptcSid, turn: 1, callSeq: cand.callSeq, callIdHash: cand.callIdHash, conversationId: 'conv-ptc-seq',
      answeredAt: nowMs + cand.callSeq + 10, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: cand.answerBatchDigest,
    })
  }
  const coldPtcIntake = createSessionIngestion(
    {
      epoch: ownerPtc.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerPtc.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerPtc.advanceIntakeCursor(input),
      beginTurn: async input => ownerPtc.beginTurn(input),
      recordQuestionReceipt: async input => ownerPtc.recordQuestionReceipt(input),
      retireSessionQuestionReceipts: async sid => ownerPtc.retireSessionQuestionReceipts(sid),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => ownerPtc.pruneExpiredQuestionReceipts(maxAgeMs, exclude),
      stageOpenTurnSources: async input => ownerPtc.stageOpenTurnSources(input),
      settleTurn: async input => ownerPtc.settleTurn(input),
    },
    { flush: async () => true, get: () => undefined },
    {
      open: async () => ({
        inheritedEventCount: 0,
        read: async (offset: number, limit: number) => ({ events: ptcEvents.slice(offset, offset + limit) }),
        close: async () => {},
      }) as never,
      list: async () => [],
    },
    { host: true },
  )
  await coldPtcIntake.scanCold(ptcSid, { id: SessionId(ptcSid), cwd: dir, version: 4, createdAt: nowMs - 10, isSeeded: false } as SessionHeader)
  await coldPtcIntake.drain()
  const dbPtc = new DatabaseSync(path.join(rootPtc, 'memory.db'), { readOnly: true })
  defer(() => dbPtc.close())
  const rows = dbPtc.prepare("SELECT text FROM memory_sources WHERE session=? AND author='answer' ORDER BY text").all(ptcSid) as Array<{ text: string }>
  assert.deepEqual(rows.map(r => r.text), ['Alpha answer', 'Beta answer'], 'cold replay must admit both sequential PTC answers')

  // 2. Temporary absence of sessionPersistence service MUST NOT retire receipts!
  const retiredOnAbsent: string[] = []
  let persistenceAvailable = false
  const absentIntake = createSessionIngestion(
    {
      epoch: 'e-abs',
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async () => ({ createdAt: 0, nextSeq: null, inheritedSeq: 0, sessionKind: 'main', conversation: null }),
      advanceIntakeCursor: async input => ({ status: 'ok', nextSeq: input.nextSeq }),
      beginTurn: async () => {},
      retireSessionQuestionReceipts: async sid => { retiredOnAbsent.push(sid) },
      stageOpenTurnSources: async () => ({ staged: [] }),
      settleTurn: async input => ({ status: 'ok', nextSeq: input.toSeq }),
    },
    { flush: async () => true, get: () => undefined },
    () => persistenceAvailable ? ({ open: async () => { throw new Error('unexpected') }, list: async () => [] }) : undefined,
    { host: true },
  )
  await absentIntake.scanCold('s-temp-absent', { id: SessionId('s-temp-absent'), cwd: dir, version: 4, createdAt: nowMs, isSeeded: false } as SessionHeader)
  assert.deepEqual(retiredOnAbsent, [], 'absent persistence service must route to transient retry, never retire receipts')
  await absentIntake.drain()

  // 3. Post-cold-catchup TTL pruning MUST exclude active/reopened sessions awaiting live catch-up!
  let ttlClock = nowMs
  const rootTtl = path.join(dir, 'mem-ttl')
  const ownerTtl = openMemoryOwner({
    root: rootTtl, hostNamespace: 'viva', now: () => ttlClock, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerTtl.close())
  await ownerTtl.recover()
  ownerTtl.recordQuestionReceipt({
    sessionId: 'sess-reopened-old', turn: 1, callSeq: 2, callIdHash: '1'.repeat(64), conversationId: 'conv-old',
    answeredAt: ttlClock, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: '2'.repeat(64),
  })
  ownerTtl.recordQuestionReceipt({
    sessionId: 'sess-abandoned-old', turn: 1, callSeq: 2, callIdHash: '3'.repeat(64), conversationId: 'conv-aband',
    answeredAt: ttlClock, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: '4'.repeat(64),
  })
  // Advance clock by 35 days; 'sess-reopened-old' is currently active/live while 'sess-abandoned-old' is not.
  ttlClock += 35 * 24 * 60 * 60 * 1000
  const pruneDone = deferred<void>()
  const reopenedSession = {
    id: SessionId('sess-reopened-old'),
    seq: SessionSeq(0),
    inheritedEventCount: 0,
    header: { id: SessionId('sess-reopened-old'), cwd: dir, version: 4, createdAt: nowMs, isSeeded: false } as SessionHeader,
  } as unknown as Session
  const ttlIntake = createSessionIngestion(
    {
      epoch: ownerTtl.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerTtl.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerTtl.advanceIntakeCursor(input),
      beginTurn: async input => ownerTtl.beginTurn(input),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => {
        ownerTtl.pruneExpiredQuestionReceipts(maxAgeMs, exclude)
        pruneDone.resolve()
      },
      stageOpenTurnSources: async input => ownerTtl.stageOpenTurnSources(input),
      settleTurn: async input => ownerTtl.settleTurn(input),
    },
    { flush: async () => true, get: id => String(id) === 'sess-reopened-old' ? reopenedSession : undefined, list: () => [reopenedSession] },
    { open: async () => ({ inheritedEventCount: 0, read: async () => ({ events: [] }), close: async () => {} }) as never, list: async () => [] },
    { host: true },
  )
  ttlIntake.startColdCatchup()
  await pruneDone.promise
  await ttlIntake.drain()
  const dbTtl = new DatabaseSync(path.join(rootTtl, 'memory.db'), { readOnly: true })
  defer(() => dbTtl.close())
  assert.equal(dbTtl.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get('sess-reopened-old')?.n, 1,
    'active reopened session must be excluded from TTL pruning while awaiting live catch-up')
  assert.equal(dbTtl.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get('sess-abandoned-old')?.n, 0,
    'abandoned >30-day unclosed session receipt should be pruned after clean cold catch-up')
})

test('Phase 4B Codex R2 P2-3..P2-4: malformed/colliding PTC step recovery and TTL prune after transient cold-read recovery', { timeout: 30_000 }, async t => {
  const { dir, defer } = scratch(t, 'p4b-r2-fixes-')
  const tz = 'UTC'
  const nowMs = Date.parse('2026-11-26T00:00:00Z')

  // 1. A malformed PTC start (questions: []) + error dispatch OR a step-1 collision must NOT poison a valid call reusing the tuple in step 2 (or same step after malformed dispatch).
  const validCard1 = [{ id: 'v1', question: 'Same-step after malformed?' }]
  const validCard2 = [{ id: 'v2', question: 'Next-step after collision?' }]
  const ptcEvents = [
    { seq: 0, time: nowMs, type: 'turn/start', data: { turn: 1 } },
    // Step 1a: malformed questions: [] start + terminal error dispatch
    { seq: 1, time: nowMs + 1, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: [] } } },
    { seq: 2, time: nowMs + 2, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: [] }, isError: true, content: [{ type: 'text', text: 'empty questions' }] } },
    // Step 1b: valid call reusing the exact same tuple right after malformed dispatch
    { seq: 3, time: nowMs + 3, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: validCard1 } } },
    { seq: 4, time: nowMs + 4, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: validCard1 }, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'v1', selected: [], custom: 'Recovered same-step' }] }) }] } },
    // Step 1c: concurrent collision (two starts before dispatch) stays ambiguous in step 1
    { seq: 5, time: nowMs + 5, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: validCard1 } } },
    { seq: 6, time: nowMs + 6, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: validCard1 } } },
    { seq: 7, time: nowMs + 7, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: validCard1 }, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'v1', selected: [], custom: 'Must drop collision' }] }) }] } },
    { seq: 8, time: nowMs + 8, type: 'step/end', data: { turn: 1, step: 1 } },
    // Step 2: valid call reusing the exact same tuple after step/end drains step 1
    { seq: 9, time: nowMs + 9, type: 'tool/ptc-dispatch-start', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: validCard2 } } },
    { seq: 10, time: nowMs + 10, type: 'tool/ptc-dispatch', data: { rootCallId: 'r1', parentCallId: 'p1', subCallId: 'r1:ptc:1', name: 'ask_user_question', arguments: { questions: validCard2 }, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'v2', selected: [], custom: 'Recovered next-step' }] }) }] } },
    { seq: 11, time: nowMs + 11, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
  const folded = foldQuestionAnswersForTurn(ptcEvents, 'sess-ptc-r2', tz)
  assert.deepEqual(
    folded.map(c => [c.callSeq, c.items[0]!.text]),
    [[3, 'Recovered same-step'], [9, 'Recovered next-step']],
    'malformed dispatch and prior-step collision must not suppress later valid PTC calls, while same-step collision still drops',
  )

  // 2. Transient cold open() failure followed by successful scheduled retry MUST run TTL pruning once retries settle, preserving active exclusions.
  let clock = nowMs
  const rootRetry = path.join(dir, 'mem-retry-prune')
  const ownerRetry = openMemoryOwner({
    root: rootRetry, hostNamespace: 'viva', now: () => clock, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerRetry.close())
  await ownerRetry.recover()
  ownerRetry.recordQuestionReceipt({
    sessionId: 'sess-active-keep', turn: 1, callSeq: 2, callIdHash: 'a'.repeat(64), conversationId: 'conv-keep',
    answeredAt: clock, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: 'b'.repeat(64),
  })
  ownerRetry.recordQuestionReceipt({
    sessionId: 'sess-abandoned-prune', turn: 1, callSeq: 2, callIdHash: 'c'.repeat(64), conversationId: 'conv-prune',
    answeredAt: clock, questionProfileGen: 0, answerProfileGen: 0, answerBatchDigest: 'd'.repeat(64),
  })
  clock += 35 * 24 * 60 * 60 * 1000
  let coldOpens = 0
  let pruneCalls = 0
  const pruneDone = deferred<void>()
  const activeSession = {
    id: SessionId('sess-active-keep'),
    seq: SessionSeq(0),
    inheritedEventCount: 0,
    header: { id: SessionId('sess-active-keep'), cwd: dir, version: 4, createdAt: nowMs, isSeeded: false } as SessionHeader,
  } as unknown as Session
  const retryIntake = createSessionIngestion(
    {
      epoch: ownerRetry.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerRetry.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerRetry.advanceIntakeCursor(input),
      beginTurn: async input => ownerRetry.beginTurn(input),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => {
        pruneCalls++
        ownerRetry.pruneExpiredQuestionReceipts(maxAgeMs, exclude)
        pruneDone.resolve()
      },
      stageOpenTurnSources: async input => ownerRetry.stageOpenTurnSources(input),
      settleTurn: async input => ownerRetry.settleTurn(input),
    },
    { flush: async () => true, get: id => String(id) === 'sess-active-keep' ? activeSession : undefined, list: () => [activeSession] },
    {
      list: async () => [{ header: { id: SessionId('sess-transient-cold'), cwd: dir, version: 4, createdAt: nowMs, isSeeded: false } as SessionHeader }] as never,
      open: async () => {
        if (++coldOpens === 1) throw new Error('EIO transient open failure')
        return { inheritedEventCount: 0, read: async () => ({ events: [] }), close: async () => {} } as never
      },
    },
    { host: true },
  )
  retryIntake.startColdCatchup()
  await pruneDone.promise
  await retryIntake.drain()
  assert.equal(coldOpens, 2, 'transient cold session should retry and recover')
  assert.equal(pruneCalls, 1, 'TTL prune must fire exactly once after transient cold retries settle')
  const dbRetry = new DatabaseSync(path.join(rootRetry, 'memory.db'), { readOnly: true })
  defer(() => dbRetry.close())
  assert.equal(dbRetry.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get('sess-active-keep')?.n, 1)
  assert.equal(dbRetry.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get('sess-abandoned-prune')?.n, 0)

  // 3. Rebinding sessionPersistence (a second startColdCatchup under the same owner.epoch):
  //    the superseded older pass resolving empty MUST NOT prune receipts before the newer pass replays them!
  const baseMs = Date.parse('2026-10-01T00:00:00Z')
  let rebindNow = baseMs
  const rootRebind = path.join(dir, 'mem-rebind-pass')
  const ownerRebind = openMemoryOwner({
    root: rootRebind, hostNamespace: 'viva', now: () => rebindNow, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerRebind.close())
  await ownerRebind.recover()
  const rebindSid = 'sess-rebind-40d'
  const rebindCallId = 'call-rebind-1'
  const rebindQuestion = 'Preferred city?'
  const rebindCustom = 'Shanghai'
  ownerRebind.recordQuestionReceipt({
    sessionId: rebindSid, turn: 1, callSeq: 1, callIdHash: questionCallIdHash(rebindCallId), conversationId: 'conv-rebind',
    answeredAt: baseMs + 2, questionProfileGen: 0, answerProfileGen: 0,
    answerBatchDigest: canonicalEligibleAnswersDigest([{ id: 'q1', question: rebindQuestion, custom: rebindCustom }]),
  })
  rebindNow = baseMs + 40 * 24 * 60 * 60 * 1000
  const rebindEvents = [
    { seq: 0, type: 'turn/start', time: baseMs + 1, data: { turn: 1 } },
    { seq: 1, type: 'tool/call', time: baseMs + 2, data: { turn: 1, step: 1, callId: rebindCallId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: rebindQuestion }] }) } },
    { seq: 2, type: 'tool/result', time: baseMs + 3, surfaceOp: 'append', sourceEventSeqs: [1], data: { message: { toolCallId: rebindCallId, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: rebindCustom }] }) }] } } },
    { seq: 3, type: 'turn/end', time: baseMs + 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
  const oldList = deferred<Array<{ header: SessionHeader }>>()
  const nextList = deferred<Array<{ header: SessionHeader }>>()
  const nextPruned = deferred<void>()
  let rebindPruneCalls = 0
  let currentPersistence: { list: () => Promise<Array<{ header: SessionHeader }>>, open?: () => Promise<never> } = {
    list: () => oldList.promise,
  }
  const rebindIntake = createSessionIngestion(
    {
      epoch: ownerRebind.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerRebind.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerRebind.advanceIntakeCursor(input),
      beginTurn: async input => ownerRebind.beginTurn(input),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => {
        rebindPruneCalls++
        ownerRebind.pruneExpiredQuestionReceipts(maxAgeMs, exclude)
        nextPruned.resolve()
      },
      stageOpenTurnSources: async input => ownerRebind.stageOpenTurnSources(input),
      settleTurn: async input => ownerRebind.settleTurn(input),
    },
    { flush: async () => true, get: () => undefined, list: () => [] },
    () => currentPersistence as never,
    { host: true },
  )
  rebindIntake.startColdCatchup()
  currentPersistence = {
    list: () => nextList.promise,
    open: async () => ({
      inheritedEventCount: 0,
      read: async (offset: number, limit: number) => ({ events: rebindEvents.slice(offset, offset + limit) }),
      close: async () => {},
    }) as never,
  }
  rebindIntake.startColdCatchup()
  // Older pass resolves empty first: MUST NOT prune the 40-day-old receipt before newer pass replays it!
  oldList.resolve([])
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(rebindPruneCalls, 0, 'superseded cold catch-up pass must not trigger TTL pruning')
  nextList.resolve([{ header: { id: SessionId(rebindSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }])
  await nextPruned.promise
  await rebindIntake.drain()
  assert.equal(rebindPruneCalls, 1)
  const dbRebind = new DatabaseSync(path.join(rootRebind, 'memory.db'), { readOnly: true })
  defer(() => dbRebind.close())
  const rebindRows = dbRebind.prepare("SELECT text FROM memory_sources WHERE session=? AND author='answer'").all(rebindSid) as Array<{ text: string }>
  assert.deepEqual(rebindRows.map(r => r.text), [rebindCustom], 'newer cold catch-up pass must still admit the 40-day-old answered question')

  // 4. Superseded in-flight cold read returning SessionPersistenceNotFoundError after rebind
  //    MUST NOT delete the fresh receipt before the replacement provider replays the turn!
  const rootOldNotFound = path.join(dir, 'mem-rebind-notfound')
  const ownerOldNf = openMemoryOwner({
    root: rootOldNotFound, hostNamespace: 'viva', now: () => baseMs, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerOldNf.close())
  await ownerOldNf.recover()
  const nfSid = 'sess-rebind-nf'
  ownerOldNf.recordQuestionReceipt({
    sessionId: nfSid, turn: 1, callSeq: 1, callIdHash: questionCallIdHash(rebindCallId), conversationId: 'conv-nf',
    answeredAt: baseMs + 2, questionProfileGen: 0, answerProfileGen: 0,
    answerBatchDigest: canonicalEligibleAnswersDigest([{ id: 'q1', question: rebindQuestion, custom: rebindCustom }]),
  })
  const enteredOldOpen = deferred<void>()
  const oldOpen = deferred<never>()
  const nfPruned = deferred<void>()
  let nfProvider: { list: () => Promise<Array<{ header: SessionHeader }>>, open: () => Promise<never> } = {
    list: async () => [{ header: { id: SessionId(nfSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }],
    open: () => {
      enteredOldOpen.resolve()
      return oldOpen.promise
    },
  }
  const nfIntake = createSessionIngestion(
    {
      epoch: ownerOldNf.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerOldNf.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerOldNf.advanceIntakeCursor(input),
      beginTurn: async input => ownerOldNf.beginTurn(input),
      retireSessionQuestionReceipts: async sid => ownerOldNf.retireSessionQuestionReceipts(sid),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => {
        ownerOldNf.pruneExpiredQuestionReceipts(maxAgeMs, exclude)
        nfPruned.resolve()
      },
      stageOpenTurnSources: async input => ownerOldNf.stageOpenTurnSources(input),
      settleTurn: async input => ownerOldNf.settleTurn(input),
    },
    { flush: async () => true, get: () => undefined, list: () => [] },
    () => nfProvider as never,
    { host: true },
  )
  nfIntake.startColdCatchup()
  await enteredOldOpen.promise
  nfProvider = {
    list: async () => [{ header: { id: SessionId(nfSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }],
    open: async () => ({
      inheritedEventCount: 0,
      read: async (offset: number, limit: number) => ({ events: rebindEvents.slice(offset, offset + limit) }),
      close: async () => {},
    }) as never,
  }
  nfIntake.startColdCatchup()
  oldOpen.reject(new SessionPersistenceNotFoundError(SessionId(nfSid)))
  await nfPruned.promise
  await nfIntake.drain()
  const dbOldNf = new DatabaseSync(path.join(rootOldNotFound, 'memory.db'), { readOnly: true })
  defer(() => dbOldNf.close())
  const nfRows = dbOldNf.prepare("SELECT text FROM memory_sources WHERE session=? AND author='answer'").all(nfSid) as Array<{ text: string }>
  assert.deepEqual(nfRows.map(r => r.text), [rebindCustom], 'superseded cold read not-found must not retire receipt before replacement pass replays')

  // 5. Disposal-initiated release() cold scan whose old persistence returns NotFoundError after rebind
  //    MUST ALSO be guarded against retiring the fresh receipt before replacement catch-up replays it!
  const rootReleaseNf = path.join(dir, 'mem-release-rebind-nf')
  const ownerRelNf = openMemoryOwner({
    root: rootReleaseNf, hostNamespace: 'viva', now: () => baseMs, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerRelNf.close())
  await ownerRelNf.recover()
  const relSid = 'sess-release-rebind'
  ownerRelNf.recordQuestionReceipt({
    sessionId: relSid, turn: 1, callSeq: 1, callIdHash: questionCallIdHash(rebindCallId), conversationId: 'conv-rel',
    answeredAt: baseMs + 2, questionProfileGen: 0, answerProfileGen: 0,
    answerBatchDigest: canonicalEligibleAnswersDigest([{ id: 'q1', question: rebindQuestion, custom: rebindCustom }]),
  })
  const enteredRelOpen = deferred<void>()
  const relOldOpen = deferred<never>()
  const relPruned = deferred<void>()
  let relProvider: { list: () => Promise<Array<{ header: SessionHeader }>>, open: () => Promise<never> } = {
    list: async () => [{ header: { id: SessionId(relSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }],
    open: () => {
      enteredRelOpen.resolve()
      return relOldOpen.promise
    },
  }
  const relIntake = createSessionIngestion(
    {
      epoch: ownerRelNf.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerRelNf.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerRelNf.advanceIntakeCursor(input),
      beginTurn: async input => ownerRelNf.beginTurn(input),
      retireSessionQuestionReceipts: async sid => ownerRelNf.retireSessionQuestionReceipts(sid),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => {
        ownerRelNf.pruneExpiredQuestionReceipts(maxAgeMs, exclude)
        relPruned.resolve()
      },
      stageOpenTurnSources: async input => ownerRelNf.stageOpenTurnSources(input),
      settleTurn: async input => ownerRelNf.settleTurn(input),
    },
    { flush: async () => true, get: () => undefined, list: () => [] },
    () => relProvider as never,
    { host: true },
  )
  relIntake.release({
    id: SessionId(relSid),
    seq: SessionSeq(4),
    inheritedEventCount: 0,
    header: { id: SessionId(relSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader,
  } as unknown as Session)
  await enteredRelOpen.promise
  relProvider = {
    list: async () => [{ header: { id: SessionId(relSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }],
    open: async () => ({
      inheritedEventCount: 0,
      read: async (offset: number, limit: number) => ({ events: rebindEvents.slice(offset, offset + limit) }),
      close: async () => {},
    }) as never,
  }
  relIntake.startColdCatchup()
  relOldOpen.reject(new SessionPersistenceNotFoundError(SessionId(relSid)))
  await relPruned.promise
  await relIntake.drain()
  const dbRelNf = new DatabaseSync(path.join(rootReleaseNf, 'memory.db'), { readOnly: true })
  defer(() => dbRelNf.close())
  const relRows = dbRelNf.prepare("SELECT text FROM memory_sources WHERE session=? AND author='answer'").all(relSid) as Array<{ text: string }>
  assert.deepEqual(relRows.map(r => r.text), [rebindCustom], 'disposal-initiated cold scan from old provider must not retire receipt after persistence rebinds')

  // 6. Detaching persistence during a cold read MUST NOT mark catch-up complete or trigger premature TTL pruning!
  let detachNow = baseMs
  const rootDetach = path.join(dir, 'mem-detach-ttl')
  const ownerDetach = openMemoryOwner({
    root: rootDetach, hostNamespace: 'viva', now: () => detachNow, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerDetach.close())
  await ownerDetach.recover()
  const detachSid = 'sess-detach-40d'
  ownerDetach.recordQuestionReceipt({
    sessionId: detachSid, turn: 1, callSeq: 1, callIdHash: questionCallIdHash(rebindCallId), conversationId: 'conv-detach',
    answeredAt: baseMs + 2, questionProfileGen: 0, answerProfileGen: 0,
    answerBatchDigest: canonicalEligibleAnswersDigest([{ id: 'q1', question: rebindQuestion, custom: rebindCustom }]),
  })
  detachNow = baseMs + 40 * 24 * 60 * 60 * 1000
  const detachEntered = deferred<void>()
  const detachOpen = deferred<never>()
  let detachPrunes = 0
  let detachProvider: { list: () => Promise<Array<{ header: SessionHeader }>>, open: () => Promise<never> } | undefined = {
    list: async () => [{ header: { id: SessionId(detachSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }],
    open: () => {
      detachEntered.resolve()
      return detachOpen.promise
    },
  }
  const detachIntake = createSessionIngestion(
    {
      epoch: ownerDetach.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerDetach.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerDetach.advanceIntakeCursor(input),
      beginTurn: async input => ownerDetach.beginTurn(input),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => {
        detachPrunes++
        ownerDetach.pruneExpiredQuestionReceipts(maxAgeMs, exclude)
      },
      stageOpenTurnSources: async input => ownerDetach.stageOpenTurnSources(input),
      settleTurn: async input => ownerDetach.settleTurn(input),
    },
    { flush: async () => true, get: () => undefined, list: () => [] },
    () => detachProvider as never,
    { host: true },
  )
  detachIntake.startColdCatchup()
  await detachEntered.promise
  detachProvider = undefined
  detachOpen.resolve({ inheritedEventCount: 0, read: async () => ({ events: [] }), close: async () => {} } as never)
  await new Promise(resolve => setTimeout(resolve, 30))
  await detachIntake.drain()
  assert.equal(detachPrunes, 0, 'detaching persistence during cold read must not authorize TTL cleanup')
  const dbDetach = new DatabaseSync(path.join(rootDetach, 'memory.db'), { readOnly: true })
  defer(() => dbDetach.close())
  assert.equal(dbDetach.prepare('SELECT COUNT(*) AS n FROM owner_question_receipts WHERE session=?').get(detachSid)?.n, 1)

  // 7. Rebinding persistence mid-replay (while turn 1 settleTurn is paused) MUST abort before settling turn 2 from the old provider!
  const rootMulti = path.join(dir, 'mem-multi-rebind')
  const ownerMulti = openMemoryOwner({
    root: rootMulti, hostNamespace: 'viva', now: () => baseMs, dailyNotes: { noteInterval: 5, timezone: 'UTC' },
    route: () => null, compute: () => null,
  })
  defer(() => ownerMulti.close())
  await ownerMulti.recover()
  const multiSid = 'sess-multi-rebind'
  ownerMulti.recordQuestionReceipt({
    sessionId: multiSid, turn: 2, callSeq: 3, callIdHash: questionCallIdHash(rebindCallId), conversationId: 'conv-multi',
    answeredAt: baseMs + 4, questionProfileGen: 0, answerProfileGen: 0,
    answerBatchDigest: canonicalEligibleAnswersDigest([{ id: 'q1', question: rebindQuestion, custom: rebindCustom }]),
  })
  const oldMultiEvents = [
    { seq: 0, type: 'turn/start', time: baseMs + 1, data: { turn: 1 } },
    { seq: 1, type: 'turn/end', time: baseMs + 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 2, type: 'turn/start', time: baseMs + 3, data: { turn: 2 } },
    { seq: 3, type: 'turn/end', time: baseMs + 4, data: { turn: 2, reason: { kind: 'interrupted' } } },
  ] as unknown as SessionEvent[]
  const newMultiEvents = [
    { seq: 0, type: 'turn/start', time: baseMs + 1, data: { turn: 1 } },
    { seq: 1, type: 'turn/end', time: baseMs + 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 2, type: 'turn/start', time: baseMs + 3, data: { turn: 2 } },
    { seq: 3, type: 'tool/call', time: baseMs + 4, data: { turn: 2, step: 1, callId: rebindCallId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: rebindQuestion }] }) } },
    { seq: 4, type: 'tool/result', time: baseMs + 5, surfaceOp: 'append', sourceEventSeqs: [3], data: { message: { toolCallId: rebindCallId, isError: false, content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'q1', selected: [], custom: rebindCustom }] }) }] } } },
    { seq: 5, type: 'turn/end', time: baseMs + 6, data: { turn: 2, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
  const turn1Entered = deferred<void>()
  const releaseTurn1 = deferred<void>()
  const multiPruned = deferred<void>()
  let multiProvider: { list: () => Promise<Array<{ header: SessionHeader }>>, open: () => Promise<never> } = {
    list: async () => [{ header: { id: SessionId(multiSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }],
    open: async () => ({
      inheritedEventCount: 0,
      read: async (offset: number, limit: number) => ({ events: oldMultiEvents.slice(offset, offset + limit) }),
      close: async () => {},
    }) as never,
  }
  const multiIntake = createSessionIngestion(
    {
      epoch: ownerMulti.epoch,
      inEpoch: (_e, fn) => fn(),
      intakeCursor: async sid => ownerMulti.intakeCursor(sid),
      advanceIntakeCursor: async input => ownerMulti.advanceIntakeCursor(input),
      beginTurn: async input => ownerMulti.beginTurn(input),
      pruneExpiredQuestionReceipts: async (maxAgeMs, exclude) => {
        ownerMulti.pruneExpiredQuestionReceipts(maxAgeMs, exclude)
        multiPruned.resolve()
      },
      stageOpenTurnSources: async input => ownerMulti.stageOpenTurnSources(input),
      settleTurn: async input => {
        if (input.turn === 1) {
          turn1Entered.resolve()
          await releaseTurn1.promise
        }
        return ownerMulti.settleTurn(input)
      },
    },
    { flush: async () => true, get: () => undefined, list: () => [] },
    () => multiProvider as never,
    { host: true },
  )
  multiIntake.startColdCatchup()
  await turn1Entered.promise
  multiProvider = {
    list: async () => [{ header: { id: SessionId(multiSid), cwd: dir, version: 4, createdAt: baseMs, isSeeded: false } as SessionHeader }],
    open: async () => ({
      inheritedEventCount: 0,
      read: async (offset: number, limit: number) => ({ events: newMultiEvents.slice(offset, offset + limit) }),
      close: async () => {},
    }) as never,
  }
  multiIntake.startColdCatchup()
  releaseTurn1.resolve()
  await multiPruned.promise
  await multiIntake.drain()
  const dbMulti = new DatabaseSync(path.join(rootMulti, 'memory.db'), { readOnly: true })
  defer(() => dbMulti.close())
  const multiRows = dbMulti.prepare("SELECT text FROM memory_sources WHERE session=? AND author='answer'").all(multiSid) as Array<{ text: string }>
  assert.deepEqual(multiRows.map(r => r.text), [rebindCustom], 'old provider must abort before settling turn 2 so replacement log admits completed turn 2')
})
