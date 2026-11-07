# Live-model validation before release

English | [简体中文](live-check.zh-CN.md)

Unit and smoke tests use fake models. They validate UI and control flow, but only actual-model checks can verify clarification, tool selection, reasoning, and resistance to injected instructions. This suite exercises 23 model-dependent scenarios from [Features](features.md). Run the core set for every beta; run all scenarios for stable releases or major changes. Assert outcomes, files, numbers, cards, and errors rather than exact wording. Each scenario defaults to three runs and must pass all three.

## Preparation

1. Install dependencies with `npm ci` using Node 22+. Some scenarios launch test MCP servers with Node.
2. Set `DEEPSEEK_API_KEY` or put one `DEEPSEEK_API_KEY=sk-...` line in `~/.config/viva/live-test.env`. On macOS, `chmod 600` is required or the runner refuses the file.
3. Quit Viva. The suite launches its own app with a unique temporary profile, separate from personal history/keys.
4. Do not interact with the test window while it runs.

The key is passed only to the tested app, not printed or included in reports/screenshots.

## Run

```bash
npm run live
npm run live -- --set core
npm run live -- --only steer,desk
npm run live -- --repeat 1
npm run live -- --app "/Applications/Viva.app/Contents/MacOS/Viva"
```

The command builds first. `--app` tests an installed executable; Windows usually uses `%LOCALAPPDATA%\Programs\Viva\Viva.exe`. In PowerShell, set the key and run `powershell -ExecutionPolicy Bypass -File scripts\verify-windows.ps1 -Live`; it runs core live checks after tests/smoke. Add `-LiveSet full` for all scenarios. The report is copied to `smoke\windows-report\live-report.md`.

`npm run live -- --dry --repeat 1` uses the fake model to check runner navigation and element discovery. Most semantic scenarios are expected to fail with fake answers; this is not a live-model pass.

Estimated time: 30–40 minutes for core ×3; 1.5–2 hours for all ×3. Record actual cost from the DeepSeek usage console after running; these are estimates.

## Results

`smoke/live/report.md` lists pass counts, average duration, comparison with the previous run, and failures first. Failure details contain reasons and screenshots under `smoke/live/<id>/`. JSON results are in `report.json`, with the previous run saved as `smoke/live-baseline.json`. Exit status is zero only if everything passes.

For a model mistake, rerun `--only <id> --repeat 3`; intermittent recurrence suggests prompt/persona work. A “never happened” or “stopped” failure may indicate stale UI selectors or network failure: inspect screenshots/report before assigning a cause.

## Scenarios

| ID | Feature / expected outcome | Core |
|---|---|---|
| chat | Markdown tables/code render; a follow-up refers to the prior answer | |
| files-csv | Read workspace CSV and calculate 8024 | |
| files-write | Create requested workspace file with correct content | ✓ |
| files-outside-allow | Outside-workspace read asks permission, then retrieves the identifier | ✓ |
| files-outside-deny | Denial prevents revealing the identifier | |
| steer | A mid-turn request to switch to English is delivered and honored | ✓ |
| steer-another | A review interrupted at once by "send me today's brief too": the brief is given and the review still done, without waiting for "continue" | ✓ |
| ask-question | Weather request asks for location then continues | ✓ |
| ask-remembered | Known home city prevents repeated location question | |
| memory-recall | Explicit save needs no approval and is recalled in a new topic | ✓ |
| memory-supersede | New supervisor supersedes the old fact | |
| memory-secret | Bank-card password is not stored | |
| mcp-add-use | Approval, separate encrypted secret entry, usable MCP tool, draft without sending | |
| skill-create | Approved skill appears in Capabilities | |
| mcp-import | Existing dsh MCP imports without approval | |
| schedule-propose | The schedule card says the right task and time; once kept, it is in Activity's Coming up | ✓ |
| schedule-by-talk | Asked in the conversation, a daily schedule's time changes, then it is deleted | |
| task-background | Asked to, the assistant moves work to the background without occupying chat; a result card comes back | ✓ |
| model-openai | Switch to OpenAI-compatible model, answer, switch back | |
| errors | Wrong key/unreachable server has readable localized errors; recovery works | ✓ |
| desk | Desktop-island file question produces a file-aware answer | ✓ |
| history | Restart resumes the prior secret phrase and search finds it | ✓ |

`model-openai` defaults to DeepSeek's compatible endpoint; override with `LIVE_OPENAI_URL`, `LIVE_OPENAI_MODEL`, and `LIVE_OPENAI_KEY`. History launches twice.

## Manual checks

Run on both macOS and Windows before release:

- [ ] A schedule's result sends a system notification that opens Activity.
- [ ] Closing retains tray/menu-bar presence; the count of what is new in Activity, open, and quit work.
- [ ] Installed app's launch-at-login starts in tray without opening its window.
- [ ] A schedule missed while the computer slept runs once after it wakes.
- [ ] Global shortcut works from another application and returns keyboard focus.
- [ ] Desktop island stays above ordinary apps, is absent from macOS fullscreen, and excluded from capture/sharing.
- [ ] A real Finder/Explorer file drop can be summarized.
- [ ] Dragging is smooth; lower-screen expansion goes upward; unplugging a display recovers placement.
- [ ] 4K/175% scaling stays readable, including Windows caption buttons.
- [ ] Installer prompts match README and uninstall leaves no Start menu entry.
- [ ] Both UI languages work at narrow width, including active tasks, approvals, errors, and restart persistence.

## Adding scenarios

Add model-dependent features in `test/smoke/live-scenarios-*.ts`. The existing stable `feature` labels map to Chinese source headings in `features.zh-CN.md`; `test/live.test.ts` verifies every mapping. The English feature guide retains compatible explicit anchors. The runner is `live.ts`, shared actions are `live-kit.ts`, launch orchestration is `scripts/live.ts`, and reporting is `scripts/live-report.mjs`.
