import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { hasTruncatedAnswerEvidence, LME_QUESTION_TYPES, parseLmeDate, selectStratifiedLmeSlice, sortAndFilterLmeSessions } from '../scripts/memory-eval/lme-slice.ts'
import { lmeJudgePrompt } from '../scripts/memory-eval/judge.ts'
import { buildOfflineBundle, checkPatterns, safeWorkSubdir, scoreOfflineQueries } from '../scripts/memory-eval/viva-runner.ts'
import { renderSummaryMarkdown } from '../scripts/memory-eval/run.ts'
import type { LmeItem } from '../scripts/memory-eval/types.ts'

describe('memory-eval harness', () => {
  it('parses LongMemEval dates, sorts chronologically, and filters future sessions', () => {
    const parsed = parseLmeDate('2023/05/20 (Sat) 02:21')
    assert.equal(parsed.dateStr, '2023-05-20')
    assert.equal(parsed.isoStr, '2023-05-20T02:21:00')

    const item: LmeItem = {
      question_id: 'q1',
      question_type: 'knowledge-update',
      question: 'Where do I live?',
      question_date: '2023/05/20 (Sat) 12:00',
      answer: 'Hangzhou',
      answer_session_ids: ['s2'],
      haystack_dates: ['2023/05/21 (Sun) 09:00', '2023/05/19 (Fri) 10:00', '2023/05/10 (Wed) 08:00'],
      haystack_session_ids: ['s3-future', 's2', 's1'],
      haystack_sessions: [
        [{ role: 'user', content: 'future' }],
        [{ role: 'user', content: 'now hangzhou' }],
        [{ role: 'user', content: 'old shanghai' }],
      ],
    }
    const sorted = sortAndFilterLmeSessions(item)
    assert.deepEqual(sorted.map(s => s.sessionId), ['s1', 's2'])

    // Default maxSessions truncation is label-free ('recent'), ignoring answer_session_ids; 'answer-aware' is explicit opt-in.
    const multi: LmeItem = {
      ...item,
      answer_session_ids: ['s1'],
      haystack_dates: ['2023/05/10 (Wed) 08:00', '2023/05/12 (Fri) 08:00', '2023/05/19 (Fri) 10:00'],
      haystack_session_ids: ['s1', 's2', 's3'],
      haystack_sessions: [
        [{ role: 'user', content: 'old answer' }],
        [{ role: 'user', content: 'mid distractor' }],
        [{ role: 'user', content: 'latest distractor' }],
      ],
    }
    const recent = sortAndFilterLmeSessions(multi, 2)
    const aware = sortAndFilterLmeSessions(multi, 2, 'answer-aware')
    assert.deepEqual(recent.map(s => s.sessionId), ['s2', 's3'])
    assert.deepEqual(aware.map(s => s.sessionId), ['s1', 's2'])
    assert.equal(hasTruncatedAnswerEvidence(multi, recent), true)
    assert.equal(hasTruncatedAnswerEvidence(multi, aware), false)
    assert.equal(hasTruncatedAnswerEvidence({ ...multi, question_id: 'q1_abs' }, recent), false)

    // Untrusted question_id with path traversal must never escape workDir.
    const root = path.resolve('/tmp/viva-eval-work')
    const safe = safeWorkSubdir(root, '../../etc/passwd')
    assert.equal(safe.startsWith(`${root}${path.sep}`), true)
    assert.equal(safe.includes('..'), false)
  })

  it('produces deterministic stratified slices with abstention coverage across all 6 categories', () => {
    const items: LmeItem[] = []
    for (const type of LME_QUESTION_TYPES) {
      for (let i = 0; i < 4; i++) {
        items.push({
          question_id: `${type}-${i}`,
          question_type: type,
          question: `q ${i}`,
          question_date: '2023/06/01 (Thu) 10:00',
          answer: 'a',
          answer_session_ids: [],
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
        })
      }
      if (['single-session-user', 'knowledge-update', 'multi-session'].includes(type)) {
        items.push({
          question_id: `${type}-9_abs`,
          question_type: type,
          question: 'unanswerable',
          question_date: '2023/06/01 (Thu) 10:00',
          answer: 'unknown',
          answer_session_ids: [],
          haystack_dates: [],
          haystack_session_ids: [],
          haystack_sessions: [],
        })
      }
    }
    const a = selectStratifiedLmeSlice(items, 2)
    const b = selectStratifiedLmeSlice([...items].reverse(), 2)
    assert.equal(a.items.length, 12)
    assert.equal(a.sliceSha256, b.sliceSha256)
    assert.equal(a.items.filter(item => item.question_id.endsWith('_abs')).length, 3)

    const exclude = new Set(a.items.map(item => item.question_id))
    const heldOut = selectStratifiedLmeSlice(items, 2, exclude)
    assert.equal(heldOut.items.length, 12)
    assert.equal(heldOut.items.some(item => exclude.has(item.question_id)), false)
    assert.notEqual(heldOut.sliceSha256, a.sliceSha256)

    // Backfills with remaining abstention items when regular items run short, and throws when total pool < perType.
    const sparse: LmeItem[] = []
    for (const type of LME_QUESTION_TYPES) {
      sparse.push(
        {
          question_id: `${type}-reg-0`, question_type: type, question: 'q', question_date: '2023/06/01 (Thu) 10:00',
          answer: 'a', answer_session_ids: [], haystack_dates: [], haystack_session_ids: [], haystack_sessions: [],
        },
        {
          question_id: `${type}-abs-1_abs`, question_type: type, question: 'q1', question_date: '2023/06/01 (Thu) 10:00',
          answer: 'u', answer_session_ids: [], haystack_dates: [], haystack_session_ids: [], haystack_sessions: [],
        },
        {
          question_id: `${type}-abs-2_abs`, question_type: type, question: 'q2', question_date: '2023/06/01 (Thu) 10:00',
          answer: 'u', answer_session_ids: [], haystack_dates: [], haystack_session_ids: [], haystack_sessions: [],
        },
      )
    }
    const backfilled = selectStratifiedLmeSlice(sparse, 3)
    assert.equal(backfilled.items.length, LME_QUESTION_TYPES.length * 3)
    assert.throws(() => selectStratifiedLmeSlice(sparse, 4), /Insufficient LongMemEval items/)
  })

  it('selects matching judge prompts and scores offline retrieval metrics cleanly', () => {
    assert.equal(lmeJudgePrompt('single-session-preference', false).userTemplate, 'preference')
    assert.match(lmeJudgePrompt('single-session-user', true).system, /unanswerable/i)
    assert.match(lmeJudgePrompt('temporal-reasoning', false).system, /off-by-one/i)

    const bundle = buildOfflineBundle('evaluation')
    assert.equal(bundle.documents.length, 120)
    assert.equal(bundle.queries.length, 60)
    assert.ok(bundle.remeDocuments.length > 100 && bundle.remeDocuments.length < 120)
    const retiredIds = new Set(bundle.documents.flatMap(d => d.supersedes ? [d.supersedes.id] : []))
    assert.ok(retiredIds.size > 0)
    assert.equal(bundle.remeDocuments.some(d => retiredIds.has(d.id)), false, 'superseded docs must be excluded from ReMe corpus')

    const wrongSnippet = scoreOfflineQueries(
      bundle.queries,
      bundle.queries.map(q => ({
        id: q.id,
        elapsedMs: 1.5,
        hits: q.evidence.map(e => ({ id: e.id, text: 'unrelated snippet without the required quote', score: 1 })),
      })),
      { system: 'viva', mode: 'test', dataset: 'evaluation', indexMs: 10, vectorPrepMs: 20 },
    )
    assert.equal(wrongSnippet.hit1, 0, 'matching doc id with wrong chunk text must not count as quote evidence hit')
    assert.equal(wrongSnippet.hit5, 0)

    const perfect = scoreOfflineQueries(
      bundle.queries,
      bundle.queries.map(q => ({
        id: q.id,
        elapsedMs: 1.5,
        hits: q.evidence.map(e => ({ id: e.id, text: e.quote, score: 1 })),
      })),
      { system: 'viva', mode: 'test', dataset: 'evaluation', indexMs: 10, vectorPrepMs: 20 },
    )
    assert.equal(perfect.hit1, perfect.answerCount)
    assert.equal(perfect.hit5, perfect.answerCount)
    assert.equal(perfect.mrr5, 1)
    assert.equal(perfect.safetyLeaks, 0)
    assert.equal(checkPatterns('周四下午五点给小岑，事故快报除外', { allOf: ['周四', '小岑'], noneOf: ['禁止'] }), true)

    const md = renderSummaryMarkdown({
      manifest: {
        runId: 'test',
        startedAt: '2026-11-22T00:00:00Z',
        vivaCommit: 'fe13811',
        remeCommit: '54fa338',
        remeVersion: '0.4.2.4',
        llmModel: 'deepseek-flash',
        embeddingModel: 'granite-97m',
        suites: ['offline', 'chinese'],
        vivaAutoContext: false,
        remeEnableDream: true,
        lmeSessionSampling: 'recent',
      },
      offline: [perfect, { ...perfect, system: 'reme', mode: 'reme-hybrid-granite', vectorPrepMs: null }],
      chinese: [{
        system: 'viva',
        mode: 'viva-hybrid-granite',
        caseId: 'dated-location-correction',
        category: 'historical-correction',
        phases: [{
          phaseId: 'initial-location',
          recallQuery: 'q',
          recallSnippetCount: 1,
          answer: 'ok',
          judgeVerdict: 'yes',
          judgeReason: 'matched',
          patternHits: 1,
          patternTotal: 1,
          forbiddenHits: 0,
        }],
        workspace: { dailyFiles: 1, digestFiles: 1, sessionFiles: 0, totalBytes: 100, filePaths: [] },
        telemetry: { llmCalls: 1, inputTokens: 100, outputTokens: 20, ingestMs: 10, dreamMs: 10, answerMs: 10, toolCalls: 1, toolNames: {} },
        error: 'phase-2 timeout',
      }],
      lme: {
        sliceSha256: 'abc123def456',
        perType: 1,
        maxSessions: 2,
        sessionSampling: 'recent',
        results: [
          {
            system: 'viva', mode: 'viva-hybrid-react-only', questionId: 'q-ok', questionType: 'knowledge-update',
            isAbstention: false, question: 'q', groundTruth: 'a', answer: 'a', verdict: 'yes', judgeReason: 'yes',
            sessionsIngested: 2, dreamTriggers: 1,
            workspace: { dailyFiles: 1, digestFiles: 1, sessionFiles: 0, totalBytes: 100, filePaths: [] },
            telemetry: { llmCalls: 1, inputTokens: 10, outputTokens: 5, ingestMs: 1, dreamMs: 1, answerMs: 1, toolCalls: 1, toolNames: {} },
          },
          {
            system: 'viva', mode: 'viva-hybrid-react-only', questionId: 'q-drop', questionType: 'knowledge-update',
            isAbstention: false, evidenceTruncated: true, question: 'q2', groundTruth: 'a2', answer: 'Information not found.', verdict: 'no', judgeReason: 'no',
            sessionsIngested: 2, dreamTriggers: 1,
            workspace: { dailyFiles: 1, digestFiles: 1, sessionFiles: 0, totalBytes: 100, filePaths: [] },
            telemetry: { llmCalls: 1, inputTokens: 10, outputTokens: 5, ingestMs: 1, dreamMs: 1, answerMs: 1, toolCalls: 1, toolNames: {} },
          },
          {
            system: 'viva', mode: 'viva-hybrid-react-only', questionId: 'q-jerr', questionType: 'knowledge-update',
            isAbstention: false, question: 'q3', groundTruth: 'a3', answer: 'valid answer', verdict: 'error', judgeReason: 'judge timeout',
            sessionsIngested: 2, dreamTriggers: 1,
            workspace: { dailyFiles: 1, digestFiles: 1, sessionFiles: 0, totalBytes: 100, filePaths: [] },
            telemetry: { llmCalls: 1, inputTokens: 10, outputTokens: 5, ingestMs: 1, dreamMs: 1, answerMs: 1, toolCalls: 1, toolNames: {} },
          },
        ],
      },
    })
    assert.match(md, /Viva vs\. ReMe/)
    assert.match(md, /M4 离线检索对照/)
    // dated-location-correction has 2 expected phases; completing only phase 1 must report 1/2 (50.0%) and surface phase 2 error.
    assert.match(md, /1\/2 \(50\.0%\)/)
    assert.match(md, /dated-location-correction\/explicit-relocation.*ERR \(phase-2 timeout\)/)
    assert.match(md, /N\/A \(含于索引\)/)
    assert.match(md, /Viva Auto Context.*false/)
    assert.match(md, /ReMe LME Dream.*true/)
    assert.match(md, /OVERALL \(完整证据\).*\*\*1\/1 \(100\.0%\)\*\*/)
    assert.match(md, /证据被截断跳过.*1 题/)
    assert.match(md, /裁判错误排除.*1 题/)
    assert.match(md, /TRUNCATED: Information not found/)
    assert.match(md, /JUDGE_ERR: valid answer/)
  })
})
