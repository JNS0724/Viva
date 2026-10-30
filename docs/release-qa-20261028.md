# Release acceptance record: October 28–29, 2026

English | [简体中文](release-qa-20261028.zh-CN.md)

Baseline: main `f95eb68`; product fixes and acceptance through `6ad99f8`. This historical record supports review of `0.4.0-beta.6`. It contains no local credentials, personal data or large raw performance captures. Its results do not validate subsequent branches.

## Scope and results

- Updated main and created an isolated acceptance branch, covering chat, files, permissions, memory, steering, questions, MCP/skills, follow-ups, sources, background tasks, model switching, desktop island, history and restart.
- The exact fix commit passed 770 unit/integration tests, strict typechecking and build. The installed Windows candidate passed six smoke phases and all 26 real-model scenarios, each repeated three times.
- Additional checks covered natural memory forgetting, multiple background tasks and restart anchors, stopping and reopening, a real ten-minute file watch, 20,000/20,001-character input boundaries and wide content.
- All 84 layout cases and 84 offline-font layout cases passed. Windows native screenshots, clicks, Unicode input, maximize/restore and system-menu keyboard resizing passed. Mouse border-drag resizing was not reliably reverified.
- Windows WPR recording was restored and an ETL archived; parsing exited 0 with zero lost events. This establishes capture capability, not a performance root cause or fix.
- macOS/Windows CI checks, packages and smokes the release commit after installation; release attachments are uploaded only after packaging validation passes.

## Fixed defects

| Problem | Fix and validation |
|---|---|
| Outside-workspace read approval and path boundaries | Validate real paths and junctions; denial returns no content. Permission unit/integration tests and real-model allow/deny journeys passed. |
| Truncated background judgments silently ignored messages | Increased output budget, rejected invalid results and retained pending messages. Regression and real-model retests passed. |
| Task cards missing or misplaced after restart | Restore original topic/anchor with seen/dismissed semantics. Persistence regressions and restart journeys passed. |
| IME confirmation accidentally submitted or closed input | Covered synthetic composition events in main, task, edit and desktop-island inputs. Physical candidate windows still need manual acceptance. |
| Oversized/rejected input lost drafts | Check length before submission, retain input and restore the corresponding rejected draft without overwriting newer input. Boundary and installed-app smoke checks passed. |
| Narrow overflow and bad image URIs broke previews | Constrained layout and isolated image parsing failures. High-scale/wide-content and malformed-URI regressions passed. |
| Stale ASAR integrity records after repacking | Refresh Windows/macOS metadata from final ASAR. Cross-platform logic regressions and actual Windows installation passed. |

Chinese error/reconnect explanations and memory/table/MCP tool guidance were also improved. Initial failures, false positives and retests remain separately recorded; retries did not erase failures.

## Open issues and weaknesses

- **Performance QA-013 remains open.** Measure the initial 16,000-character preview separately from full expansion. A roughly 200 KB/507-section answer expanded to 14,568 DOM elements, exceeding the original 4,000 budget, with 94–289 ms long tasks. Scrolling afterward over 980 frames had p95 about 8.6–8.7 ms. Layout containment, offscreen rendering and opacity experiments failed fidelity/geometry/performance conditions and were excluded.
- At high scaling and minimum window size, the reading area is short and the New content indicator can cover some text, which remains scrollable. Permission-card technical parameters need clearer explanations.
- Background preparation depends on foreground activity, pause, backoff and budget; waiting feedback sits far from its control. Submitting background work too early during connection gives an imprecise message, but the request remains retryable.
- Recall depends on query selection. Models may misjudge message importance, misunderstand drafting, create malformed tables or fail to copy long repetitive text exactly. Tool guidance cannot guarantee correctness.
- Draft-only MCP naming rules do not completely isolate side effects of arbitrary tools/commands. Deleting chat does not delete underlying model logs; documentation must retain these boundaries.
- Installers are unsigned. Late fonts, physical IME, Explorer drag/drop, tray/notifications/shortcut conflicts, sleep/restart, multiple displays and macOS device interaction have not completed comprehensive manual validation.

## Release decision

On October 29, 2026 the user authorized committing, merging and releasing when no confirmed unresolved functional usability blocker remained, while deferring performance work. The open product investigation was the performance issue above. Unverified scope and weaknesses remain disclosed; this does not claim every original acceptance item passed. Beta PR checks and dual-platform packaging gates apply.

Long-conversation rendering changes were separately archived at the user's request and excluded from this modification, test, merge and release scope. The historical authorization here does not authorize a new release.
