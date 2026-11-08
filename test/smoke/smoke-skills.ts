import fs from 'node:fs'
import path from 'node:path'
import { capture, run, settle, until, type Expect, type SmokeHooks, type SmokeWindow } from './smoke-kit.ts'
import { openCapabilityTab } from './smoke-mcp.ts'

/**
 * Smoke steps on 能力 · 技能 · 导入: skills in the user's own dsh (the fixture's DSH_HOME) are found, checked by dsh's
 * rules (one ready, one renamed into kebab case, one that cannot load), and those ticked go into Viva's.
 */
const SKILLS: ReadonlyArray<[folder: string, frontmatter: string]> = [
  ['weekly-report', 'name: weekly-report\ndescription: 按团队模板写周报'],
  ['notes', 'name: Meeting Notes\ndescription: 整理会议记录'],
  ['broken', 'name: broken'],
]

export async function skillImportSteps(win: SmokeWindow, outDir: string, expect: Expect, hooks: SmokeHooks) {
  const dir = path.join(hooks.importHome, 'skills')
  for (const [folder, frontmatter] of SKILLS) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true })
    fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), `---\n${frontmatter}\n---\n\n正文\n`)
  }
  try {
    await openCapabilityTab(win, 'skills')
    await run(win, `document.querySelector('#capabilities-root .cap-search-row button').click()`)
    await until(win, `[...document.querySelectorAll('#capabilities-root .cap-source')].some((el) => el.textContent.includes('你自己的 dsh'))`, 'the dsh import source to finish scanning')
    await run(win, `[...document.querySelectorAll('#capabilities-root .cap-source')].find((el) => el.textContent.includes('你自己的 dsh')).click()`)
    await until(win, `document.querySelector('#capabilities-root .cap-candidate') || null`, 'what was found')
    const found = await run(win, `[...document.querySelectorAll('#capabilities-root .cap-candidate')].map((row) => ({
      entry: row.querySelector('.cap-candidate-name').textContent,
      why: row.querySelector('.ext-status').textContent,
      ticked: row.querySelector('input').checked,
      locked: row.querySelector('input').disabled,
    }))`)
    const row = (entry: string) => found.find((one: { entry: string }) => one.entry === entry)
    expect(row('weekly-report')?.ticked && row('notes')?.why.includes('meeting-notes') && row('notes')?.ticked
      && row('broken')?.locked && !row('broken')?.ticked, 'each found should be checked: ready, renamed into kebab case, or locked out', found)
    await capture(win, outDir, 'skills-import-review')
    await run(win, `document.querySelector('#capabilities-root .tp-main .btn-accent').click()`)
    const listed = await until(win, `(() => {
      const names = [...document.querySelectorAll('#capabilities-root .cap-row .tp-name')].map((el) => el.textContent)
      return names.includes('meeting-notes') && names.includes('weekly-report') ? names : null
    })()`, 'the skills brought in')
    expect(!listed.includes('broken') && !listed.includes('Meeting Notes'), 'only those ticked should go in, under the name put right', listed)
    await settle(win)
    await capture(win, outDir, 'skills-imported')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
