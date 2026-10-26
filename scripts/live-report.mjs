// The live check's report (scripts/live.mjs, docs/live-check.md): the two launches' reports put together, one
// line per scenario, what failed first, compared with the last run when there is one.

const seconds = (ms) => `${Math.round(ms / 1000)} s`

/** One entry per scenario: its attempts in both launches (a scenario that needs a restart has two steps). */
function mergeScenarios(phases) {
  const byId = new Map()
  for (const phase of phases) {
    for (const scenario of phase.scenarios) {
      const entry = byId.get(scenario.id) ?? { id: scenario.id, title: scenario.title, feature: scenario.feature, core: scenario.core, steps: [] }
      entry.steps.push({ step: scenario.step, attempts: scenario.attempts })
      byId.set(scenario.id, entry)
    }
  }
  return [...byId.values()].map((entry) => {
    const attempts = entry.steps.flatMap((s) => s.attempts)
    const passed = attempts.filter((a) => a.ok).length
    return {
      id: entry.id, title: entry.title, feature: entry.feature, core: entry.core,
      passed, attempts: attempts.length, ok: passed === attempts.length,
      ms: attempts.length ? Math.round(attempts.reduce((sum, a) => sum + a.ms, 0) / attempts.length) : 0,
      failures: entry.steps.flatMap((s) => s.attempts.map((a, i) => ({ step: s.step, n: i + 1, failures: a.failures, shots: a.shots })).filter((a) => a.failures.length)),
    }
  })
}

function compared(scenario, baseline) {
  const last = baseline?.scenarios?.find((s) => s.id === scenario.id)
  if (!last) return '—'
  const worse = last.passed / last.attempts > scenario.passed / Math.max(scenario.attempts, 1)
  const slower = scenario.ms > last.ms * 1.5
  return `上次 ${last.passed}/${last.attempts}，${seconds(last.ms)}${worse ? '（变差）' : ''}${slower ? '（变慢）' : ''}`
}

/**
 * @param phases the launches' reports (src/main/live.ts PhaseReport), in order
 * @param baseline the last run's report.json, or null
 * @returns the report as Markdown, and as JSON to compare the next run with
 */
export function summarize(phases, baseline = null) {
  const scenarios = mergeScenarios(phases)
  const ordered = [...scenarios.filter((s) => !s.ok), ...scenarios.filter((s) => s.ok)]
  const passed = scenarios.filter((s) => s.ok).length
  const first = phases[0]
  const json = {
    startedAt: first?.startedAt ?? null,
    endedAt: phases.at(-1)?.endedAt ?? null,
    set: first?.set ?? null,
    repeat: first?.repeat ?? null,
    totals: { scenarios: scenarios.length, passed, failed: scenarios.length - passed },
    scenarios: scenarios.map(({ failures, ...rest }) => ({ ...rest, failures: failures.flatMap((a) => a.failures) })),
  }
  const lines = [
    '# Viva 真模型验证报告',
    '',
    `- 时间：${json.startedAt ?? '?'} – ${json.endedAt ?? '?'}`,
    `- 范围：${json.set ?? '?'}，每个场景跑 ${json.repeat ?? '?'} 次，每次都过才算通过`,
    `- 结果：**通过 ${passed} / ${scenarios.length}**${scenarios.length > passed ? `，失败 ${scenarios.length - passed}` : ''}`,
    '',
    '| 场景 | 功能 | 核心 | 通过次数 | 平均用时 | 对比上次 |',
    '|---|---|---|---|---|---|',
    ...ordered.map((s) => `| ${s.ok ? '✅' : '❌'} ${s.id} — ${s.title} | ${s.feature} | ${s.core ? '是' : ''} | ${s.passed}/${s.attempts} | ${seconds(s.ms)} | ${compared(s, baseline)} |`),
  ]
  const failed = ordered.filter((s) => !s.ok)
  if (failed.length) {
    lines.push('', '## 失败详情')
    for (const s of failed) {
      lines.push('', `### ${s.id} — ${s.title}`, '')
      for (const a of s.failures) {
        lines.push(`- 第 ${a.n} 次（${a.step === 'prepare' ? '第一次启动' : '运行'}）：${a.failures.join('；')}`)
        if (a.shots.length) lines.push(`  - 截图：${a.shots.join('，')}`)
      }
    }
  }
  lines.push('', '自动化测不了的项目（系统通知、托盘、开机启动等）见 docs/live-check.md 的「人工检查」，请另外勾选。', '')
  return { markdown: lines.join('\n'), json }
}
