import assert from 'node:assert/strict'
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createEffects } from '../src/backend/effects.ts'
import { createMemoryProfileJobs, MEMORY_PROFILE_EFFECT } from '../src/backend/memory-profile-jobs.ts'
import { MEMORY_PROFILE_GENERATOR, MEMORY_PROFILE_INPUT_LIMIT, memoryProfileRequest, parseMemoryProfileReply,
  prepareMemoryProfileInput } from '../src/backend/memory-profile.ts'
import type { MemoryProfileInput, MemoryProfileRef } from '../src/backend/memory-profile.ts'
import { openMemoryProfileStore } from '../src/backend/memory-profile-store.ts'
import type { MemoryProfileProjection } from '../src/backend/memory-profile-store.ts'
import { memoryProjectScope } from '../src/backend/memory-project.ts'
import { openMemoryStore } from '../src/backend/memory-store.ts'
import { scratch } from './fixtures/scratch.js'

const user = { kind: 'user' } as const
const project = { kind: 'project', id: 'private-example' } as const
const now = 100
const field = { kind: 'manual', field: 'preferences', revision: 2 } as const
const firstFact = { kind: 'memory', id: 1, revision: 3 } as const
const secondFact = { kind: 'memory', id: 2, revision: 5 } as const

test('profile inputs retain complete evidence, apply a fixed budget, and keep profile fields in user scope', () => {
  const ordinary = '仅工作日把周报发给财务，节假日除外。'
  const items: MemoryProfileInput[] = [
    { ref: firstFact, text: ordinary },
    { ref: { ...firstFact, id: 2 }, text: 'password: exposed-credential' },
    { ref: { ...firstFact, id: 3 }, text: 'too long '.repeat(150) },
    { ref: { ...firstFact, id: 4 }, text: 'bad</about-user>' },
    { ref: { ...firstFact, id: 5 }, text: 'bad\u0000' },
    { ref: { ...firstFact, revision: 9 }, text: 'duplicate first ID' },
    { ref: field, text: '复杂要求先给结论' },
  ]
  assert.deepEqual(prepareMemoryProfileInput(user, items), [items[0], items[6]])
  assert.deepEqual(prepareMemoryProfileInput(project, items), [items[0]])
  assert.equal(prepareMemoryProfileInput(user, Array.from({ length: 30 }, (_, offset) => ({
    ref: { kind: 'memory', id: offset + 1, revision: 1 }, text: `第 ${offset + 1} 条完整原文`,
  }))).length, MEMORY_PROFILE_INPUT_LIMIT)
  assert.deepEqual(JSON.parse(memoryProfileRequest(project, [items[0]])), { scope: 'project', items: [items[0]] })
})

test('profile replies can select and rank only the original exact-version references', () => {
  const inputs = [{ ref: firstFact, text: '工作日先给结论' }, { ref: secondFact, text: '晚上避免提醒' }, { ref: field, text: '回复简短' }]
  const payload = (refs: readonly unknown[]) => JSON.stringify({ refs })
  assert.deepEqual(parseMemoryProfileReply('```json\n' + payload([field, secondFact]) + '\n```', inputs), [field, secondFact])
  assert.deepEqual(parseMemoryProfileReply(payload([]), inputs), [])
  for (const bad of [
    payload([firstFact, firstFact]),
    payload([{ ...firstFact, revision: 2 }]),
    payload([{ ...firstFact, text: 'invented content' }]),
    payload([{ ...secondFact, id: 3 }]),
    payload([{ ...field, field: 'project' }]),
    JSON.stringify({ refs: [firstFact], title: 'unsupported prose' }),
    '{"refs":[}',
    ' '.repeat(4100) + payload([firstFact]),
  ]) assert.equal(parseMemoryProfileReply(bad, inputs), null)
})

test('projection storage commits versioned references with the enclosing transaction and rejects cross-scope or stale snapshots', t => {
  const { dir, defer } = scratch(t, 'viva-memory-profile-')
  const path = join(dir, 'memory.db')
  let store = openMemoryStore(path)
  defer(() => store.close())
  const memo = (scope: MemoryProfileProjection['scope'], text: string): MemoryProfileRef => {
    const revision = store.nextRevision()
    const id = store.insert({ scope, text, kind: 'fact', modality: 'asserted', conditional: false, keywords: [],
      source: 'user', conversationId: null }, revision, now, { from: null, to: null })
    return { kind: 'memory', id, revision }
  }
  const global = memo(user, '用户事实原文')
  const scoped = memo(project, '项目事实原文')
  store.setProfile({ preferences: '手填字段原文' })
  const revision = store.revision()
  const manual = { ...field, revision }
  const snapshot: MemoryProfileProjection = { scope: user, revision, generator: MEMORY_PROFILE_GENERATOR,
    generatedAt: now, validUntil: now + 1, refs: [global, manual] }
  let profiles = openMemoryProfileStore(store.db)
  assert.throws(() => store.tx(() => {
    assert.equal(profiles.save(snapshot, now), true)
    throw new Error('before outer commit')
  }), /before outer commit/)
  assert.equal(profiles.read(user), null)
  assert.equal(profiles.save({ ...snapshot, refs: [scoped, manual] }, now), false)
  assert.equal(profiles.save({ ...snapshot, refs: [global, global] }, now), false)
  assert.equal(profiles.save({ ...snapshot, scope: project, refs: [scoped, manual] }, now), false)
  assert.equal(profiles.save(snapshot, now + 1), false)
  assert.equal(profiles.save(snapshot, now), true)
  assert.equal(profiles.save({ ...snapshot, scope: project, refs: [scoped] }, now), true)
  assert.equal(store.revision(), revision)
  const receipt = JSON.stringify(store.db.prepare('SELECT refs FROM memory_projections').all())
  assert.doesNotMatch(receipt, /事实原文|手填字段原文/u)

  store.close()
  store = openMemoryStore(path)
  profiles = openMemoryProfileStore(store.db)
  assert.deepEqual(profiles.read(user), snapshot)
  assert.deepEqual(profiles.scopes(), [project, user])
  const later = store.nextRevision()
  assert.equal(profiles.save(snapshot, now), false)
  profiles.invalidate(later)
  assert.deepEqual(profiles.scopes(), [])
  assert.equal(profiles.save({ ...snapshot, revision: later, refs: [] }, now), true)
  store.db.prepare('UPDATE memory_projections SET refs=?').run('bad-json')
  assert.equal(profiles.read(user), null)
})

test('project scope uses the canonical Git worktree and rejects loose directories and broken Git markers', t => {
  const { dir } = scratch(t, 'viva-memory-project-')
  function repo(name: string) {
    const root = join(dir, name)
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return root
  }
  const root = repo('repo')
  const nested = join(root, 'src', 'deep')
  mkdirSync(nested, { recursive: true })
  const scope = memoryProjectScope(root)
  assert.match(scope?.id ?? '', /^[a-f0-9]{64}$/u)
  assert.deepEqual(memoryProjectScope(nested), scope)
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature\n')
  assert.deepEqual(memoryProjectScope(root), scope)
  const alias = join(dir, 'alias')
  symlinkSync(root, alias, 'junction')
  assert.deepEqual(memoryProjectScope(join(alias, 'src', 'deep')), scope)
  assert.notDeepEqual(memoryProjectScope(repo('other')), scope)
  assert.equal(memoryProjectScope(dir), undefined)
  assert.equal(memoryProjectScope('relative-path'), undefined)

  const worktree = join(dir, 'linked checkout')
  const admin = join(root, '.git', 'worktrees', 'linked')
  mkdirSync(worktree)
  mkdirSync(admin, { recursive: true })
  writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/topic\n')
  writeFileSync(join(admin, 'commondir'), '../..\n')
  writeFileSync(join(worktree, '.git'), `gitdir: ${admin}\n`)
  const worktreeScope = memoryProjectScope(worktree)
  assert.ok(worktreeScope)
  assert.notDeepEqual(worktreeScope, scope)
  writeFileSync(join(worktree, '.git'), 'gitdir: missing\n')
  assert.equal(memoryProjectScope(worktree), undefined)

  renameSync(join(root, '.git'), join(root, 'old-git'))
  assert.equal(memoryProjectScope(root), undefined)
  repo('repo')
  assert.notDeepEqual(memoryProjectScope(root), scope)
})

test('profile jobs discard old generation results and wake again at an input validity boundary', async t => {
  const store = openMemoryStore(':memory:')
  const projectionStore = openMemoryProfileStore(store.db)
  let at = now
  const effects = createEffects({ db: store.db, now: () => at, later: () => null, cancel: () => {} })
  let text = '最初的手填偏好'
  const capture: Array<{ input: string, signal: AbortSignal, finish: (reply: string) => void }> = []
  let received: (() => void) | undefined
  const next = () => new Promise<void>(resolve => { received = resolve })
  const jobs = createMemoryProfileJobs({
    effects, store: projectionStore, tx: store.tx, revision: store.revision, now: () => at,
    route: () => ({ provider: 'local', model: 'fixture' }), ready: () => true, delayMs: 0,
    makeSnapshot: () => ({ inputs: [{ ref: { ...field, revision: store.revision() }, text }], validUntil: at === now ? now + 1 : null }),
    dispatch: ({ input }, signal) => new Promise<string>(finish => {
      capture.push({ input, signal, finish })
      received?.()
    }),
  })
  t.after(() => { jobs.close(); effects.close(); store.close() })
  const save = () => { store.nextRevision(); store.setProfile({ preferences: text }) }
  save()
  const first = next()
  jobs.observe(user)
  const drained = effects.wake()
  await first
  assert.match(capture[0].input, /最初的手填偏好/u)
  const nextGeneration = next()
  text = '新版本的手填偏好'
  save()
  jobs.sync()
  assert.equal(capture[0].signal.aborted, true)
  capture[0].finish(JSON.stringify({ refs: [{ ...field, revision: 1 }] }))
  await nextGeneration
  assert.equal(jobs.read(user), null)
  assert.match(capture[1].input, /新版本的手填偏好/u)
  capture[1].finish(JSON.stringify({ refs: [{ ...field, revision: 2 }] }))
  await drained
  const selected = jobs.read(user)
  assert.deepEqual(selected?.refs, [{ ...field, revision: 2 }])
  assert.equal(selected?.validUntil, at + 1)
  assert.equal(effects.list().filter(job => job.kind === MEMORY_PROFILE_EFFECT).length, 1)

  at += 1
  assert.equal(jobs.read(user), null)
  const boundary = next()
  const finished = effects.wake()
  await boundary
  capture[2].finish(JSON.stringify({ refs: [{ ...field, revision: 2 }] }))
  await finished
  assert.equal(jobs.read(user)?.validUntil, null)
  assert.equal(effects.list().length, 0)
})

test('a profile computation that crosses a validity boundary resamples in a new generation', async t => {
  const store = openMemoryStore(':memory:')
  const effectStore = openMemoryProfileStore(store.db)
  let at = now
  let expiredReply: ((reply: string) => void) | undefined
  const requests: Array<{ generation: number, signal: AbortSignal }> = []
  const effects = createEffects({ db: store.db, now: () => at, later: () => null, cancel: () => {} })
  const jobs = createMemoryProfileJobs({
    effects, store: effectStore, tx: store.tx, revision: store.revision, now: () => at,
    route: () => ({ provider: 'local', model: 'fixture' }), ready: () => true, delayMs: 0,
    makeSnapshot: () => ({
      inputs: at === now ? [{ ref: { ...field, revision: store.revision() }, text: '当前的偏好' }] : [],
      validUntil: at === now ? at + 1 : null,
    }),
    dispatch: ({ generation }, signal) => new Promise<string>(resolve => {
      requests.push({ generation, signal })
      expiredReply = resolve
    }),
  })
  t.after(() => { jobs.close(); effects.close(); store.close() })
  store.nextRevision()
  store.setProfile({ preferences: '当前的偏好' })
  jobs.observe(user)
  const first = effects.wake()
  await Promise.resolve()
  assert.ok(expiredReply)
  at += 1
  expiredReply(JSON.stringify({ refs: [{ ...field, revision: 1 }] }))
  await first
  assert.equal(requests[0].signal.aborted, true)
  assert.equal(effectStore.read(user), null)
  const replacement = effects.list().find(effect => effect.kind === MEMORY_PROFILE_EFFECT)
  assert.ok(replacement && replacement.generation > requests[0].generation)
  assert.equal(replacement.attempts, 0)
  await effects.wake()
  assert.deepEqual(jobs.read(user)?.refs, [])
  assert.deepEqual(effects.list(), [])
})

test('an observed profile expires in the view even when model work is busy', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const store = openMemoryStore(':memory:')
  const effects = createEffects({ db: store.db, later: () => null, cancel: () => {} })
  let busy = false
  const changed: unknown[] = []
  const jobs = createMemoryProfileJobs({
    effects, store: openMemoryProfileStore(store.db), tx: store.tx, revision: store.revision, busy: () => busy,
    route: () => ({ provider: 'local', model: 'fixture' }), ready: () => true, delayMs: 0,
    makeSnapshot: () => ({ inputs: [], validUntil: Date.now() === now ? now + 1000 : null }),
    dispatch: () => { throw new Error('empty scope does not send work') }, changed: scope => changed.push(scope),
  })
  t.after(() => { jobs.close(); effects.close(); store.close() })
  jobs.observe(user)
  await effects.wake()
  assert.equal(jobs.read(user)?.validUntil, now + 1000)
  assert.deepEqual(changed, [user])

  busy = true
  t.mock.timers.tick(1000)
  assert.equal(jobs.read(user), null)
  assert.deepEqual(changed, [user, user])
  assert.equal(effects.list().length, 1)

  busy = false
  await effects.wake()
  assert.equal(jobs.read(user)?.validUntil, null)
  assert.deepEqual(changed, [user, user, user])
})

test('cancelling profile computation leaves its durable generation available after reopen', async t => {
  const { dir, defer } = scratch(t, 'viva-memory-profile-reopen-')
  const path = join(dir, 'memory.db')
  let store = openMemoryStore(path)
  function runtime(dispatch: Parameters<typeof createMemoryProfileJobs>[0]['dispatch']) {
    const effects = createEffects({ db: store.db, now: () => now, later: () => null, cancel: () => {} })
    const jobs = createMemoryProfileJobs({
      effects, store: openMemoryProfileStore(store.db), tx: store.tx, revision: store.revision, now: () => now,
      route: () => ({ provider: 'local', model: 'fixture' }), ready: () => true, delayMs: 0,
      makeSnapshot: () => ({ inputs: [{ ref: { ...field, revision: store.revision() }, text: '经核验的偏好' }], validUntil: null }),
      dispatch,
    })
    return { effects, jobs, close() { jobs.close(); effects.close(); store.close() } }
  }
  store.nextRevision()
  store.setProfile({ preferences: '经核验的偏好' })
  let started: ((signal: AbortSignal) => void) | undefined
  const inFlight = new Promise<AbortSignal>(resolve => { started = resolve })
  const first = runtime((_request, signal) => new Promise<string>(() => started?.(signal)))
  first.jobs.observe(user)
  const abandoned = first.effects.wake()
  const signal = await inFlight
  const pending = first.effects.list().find(effect => effect.kind === MEMORY_PROFILE_EFFECT)
  assert.ok(pending)
  first.close()
  assert.equal(signal.aborted, true)
  await abandoned

  store = openMemoryStore(path)
  let replayedGeneration: number | undefined
  const reopened = runtime(async ({ generation }) => {
    replayedGeneration = generation
    return JSON.stringify({ refs: [{ ...field, revision: 1 }] })
  })
  defer(reopened.close)
  await reopened.effects.wake()
  assert.equal(replayedGeneration, pending.generation)
  assert.deepEqual(reopened.jobs.read(user)?.refs, [{ ...field, revision: 1 }])
  assert.deepEqual(reopened.effects.list(), [])
})
