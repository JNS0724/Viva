# Development, packaging, and testing

[English](development.md) · [简体中文](development.zh-CN.md)

For running, modifying, or packaging Viva. See [Features](features.md), [Architecture](architecture.md), and [Memory](memory.md).

## Run

Development needs Node.js/npm. Installed Viva runs bundled dsh with its own Electron runtime; users do not need Node for dsh, though MCP servers launched through npx still require it.

```bash
npm install
npm start
```

The app runs from out/. scripts/build.mjs emits src/ and plugins/ through TypeScript into matching out/src and out/plugins paths, then copies pages, styles, icons, and plugin manifests. Start, the combined smoke command, and packaging build first. Individual smoke phases require a prior build. Unit tests use source files directly. Type checking is separate: npm run typecheck.

| Environment | Purpose | Default |
|---|---|---|
| DEEPSEEK_API_KEY | Model credentials, alternatively entered in Settings | None |
| AGENT_CWD | Agent working directory | ./workspace |
| DSH_BIN | JavaScript entry or executable override | node_modules/@deepseek-ai/dsh/lib/bin.js |
| DSH_NODE | Development runtime override | App’s Electron |

## Embedded dsh

- Uses the app’s Electron, without resolving system Node or the dsh CLI.
- Its home is userData/dsh (on macOS, ~/Library/Application Support/Viva/dsh), containing profiles, sessions, credentials, and skills. Normal runtime is isolated from ~/.dsh and ~/.agents/skills; explicit import and initial migration are separate.
- Remove inherited DSH_*, DEEPSEEK_*, ELECTRON_*, and VIVA_* variables before adding app-owned paths/credentials. Terminal DSH_HOME and DEEPSEEK_BASE_URL do not control Viva; the app can still read DEEPSEEK_API_KEY and pass it deliberately.
- Only one Viva instance owns this home. A second launch opens the existing window.
- Unexpected dsh exit retries after 1, 3, then 10 seconds; three exits within two minutes stop retries with an explanation. Key/provider changes wait for the previous process to exit before replacement.
- App exit waits up to five seconds: close stdin, terminate the process tree after 1.5 seconds (taskkill /T on Windows, including MCP children), then force termination after another 1.5 seconds.
- Initial migration copies only sessions belonging to Viva’s working directory from ~/.dsh/sessions, without moving or overwriting other projects. Remove only old viva/my-agent profiles whose manifest identifies them as Viva-owned. Copy ~/.dsh/skills once, skipping duplicate names; later deletions inside Viva are not recopied. Original skills remain untouched.

## Package

```bash
npm run dist:mac
npm run dist:win  # Run on Windows; NSIS allows choosing an installation folder
```

scripts/dsh-closure.cjs uses dsh --dump-config to find the ACP plugin composition, then computes dependencies, peers, and optional dependencies from that composition, runtime entry imports, Viva dependencies, and plugin peers. It excludes packages intended for web/TUI/Office conversion/voice profiles. Historical macOS measurements retained 373 of 542 production dependencies and removed about 266 MB, including LibreOffice and speech recognition.

Remove runtime-unneeded source maps, declarations, TypeScript sources, README/CHANGELOG, tests, and examples (historically about 7,000 files); retain licenses and skills. Bundle the rest in app.asar, reducing many small writes and antivirus scans (historically about 300 installed files). Native/executable packages such as libvips, ripgrep, and node-pty go in app.asar.unpacked. Use platform prebuilds with npmRebuild false. Plugins remain in asar behind tiny file-URL forwarding packages, without symlinks or junctions.

scripts/after-pack.cjs corrects electron-builder’s missing peers and excess packages by unpacking, adjusting to the closure, removing unused files, adding notices, and repacking. Missing required packages fail the build. Installed workspaces live in userData/workspace because the application directory is read-only; development uses repository workspace/.

Historical macOS size: about 152 MB DMG (previously 259 MB), 388 MB unpacked, mostly Electron. These are dated measurements, not promises for every build.

**Verify outside the repository:** running from dist/ can accidentally resolve missing packages from the parent node_modules. Point SMOKE_FIXTURES to test/fixtures and SMOKE_OUT to an isolated output folder.

- macOS: mount the DMG read-only using hdiutil attach -nobrowse -readonly, then run its executable with SMOKE_PHASE=memory, a fake key, fixture path, and output path.
- Windows: scripts/verify-windows.ps1 -Package builds, silently installs to a temporary directory outside the repository, smokes the installed executable, and uninstalls.

scripts/third-party-notices.cjs generates notices from the actual platform dependency set. Attach both platforms’ THIRD_PARTY_NOTICES files to releases. Signing/notarization, auto-update, Intel Mac, and Windows ARM packages remain open work.

## Release

1. Update package.json and package-lock.json together, e.g. npm version 0.4.1-beta.1 --no-git-tag-version.
2. Write paired release notes under docs/releases/: downloads, first launch, changes, and verification.
3. Run real-model validation: core for betas, full plus manual checks for stable releases; see [Live checks](live-check.md).
4. Merge through a PR, then tag the approved main commit and push the version tag when release publication is authorized.

release.yml validates tag/version agreement and release notes, invokes package.yml on macOS/Windows, and publishes only after installed-app checks pass. Hyphenated versions are prereleases. A failed release needs repair and an explicitly authorized tag retry; do not assume a failed workflow published attachments.

## Platforms

The same UI runs on both. macOS reserves left title-bar space for traffic lights. Windows/Linux use titleBarOverlay on the right, with env(titlebar-area-width) keeping app controls clear; Windows hides the menu bar. The island stays centered and shrinks before overlapping controls. Window size follows available screen space (minimum 880×600). Below 1100 px, the drawer overlays rather than compressing the conversation. Shortcut labels vary by platform.

The original design notes recorded a 48 px title bar; later cat/island specifications changed dimensions, so inspect current styles rather than treating historical dimensions as an invariant. The same applies to earlier history-shortcut documentation.

Launch dsh’s entry directly under Electron with ELECTRON_RUN_AS_NODE=1, not the .bin/dsh.cmd wrapper. dsh’s native runtime supports specific Electron releases (recorded: 43.0.0, 44.0.0, 44.7.0, 45.0.0-alpha.6); this repository pins 44.7.0. Verify support before changing it. npm scripts use cross-env for cmd/PowerShell compatibility.

## Runtime architecture

The renderer’s reducer owns immutable state; selectors provide display data, views render it, and preload carries validated IPC to main. Main uses the official ACP ClientSideConnection: initialize → session/new → session/prompt, with cancel and close for lifecycle operations.

Message chunks go to conversation text; thoughts/tool events go to Activity and the island, and touched files to Files. Permission requests become cards whose choices pass through permission-broker. Model/reasoning changes use session/set_config_option for the next turn and are disabled during replies.

Typing reveal runs at about 90 characters per second, accelerating backlog to stay roughly within 1.2 seconds. Earlier documentation described ACP-only whole-block output; current viva-stream supplies real deltas. See architecture.md for selection, fallback, and reconciliation.

Scrolling follows new content until the latest question is near the top; longer answers grow below it and offer a New content button. Manual upward scrolling suspends following until returning to the bottom. Activity preserves scroll position and follows new steps only when already at the end.

Migration from my-agent copies history, memory, and trace data to the Viva directory and leaves the old folder as backup. Keychain entries tied to the old app name cannot migrate; re-enter the key or use the environment variable. contextIsolation, sandbox, CSP, limited window.agent/window.desk APIs, and main-process argument validation form the UI boundary. Translated text uses text nodes/attributes, never arbitrary translated HTML.

## Cat assets

See [Cat character](cat-character.md). Transparent 512 px busts and 256 px heads derive from 1024 px originals retained outside the repository. Heads are automatic at 48 px or smaller; the home page explicitly uses a 64 px head. Inspect home, 36 px avatars, title-bar island, and desktop island after changing assets.

## Tests

```bash
npm run typecheck
npm test
npm run coverage
npm run smoke
npm run smoke:language
```

The combined smoke runs five phases:

| Phase | Coverage |
|---|---|
| setup | Missing-key guide, disabled composer, Settings navigation; source install, bad/good credentials, enable, fetch, remove |
| walkthrough | Approval-state island/title bar at normal and 880 px widths, platform layout, overlay drawer, long-task scrolling, file previews |
| relaunch | Same-profile history/session recovery; search/highlights, topic opening, rename/delete/undo, safe Markdown, navigation prevention, island questions/images, topics/permissions |
| memory | Real dsh with fake model: introduction, remember, keywords, name recall, injected activity, questions and remembered answer, plugin status, MCP setup, follow-up/prepare/continue, message suggestions, added provider without losing conversation |
| resume | Kill dsh and verify automatic reconnection to the same conversation |

The separate language smoke uses no real model or credentials: English setup, language selector, Chinese/English Settings, retained unsaved input/focus/selection, unchanged session, and desktop-island broadcast.

Real-model validation defaults to 26 scenarios, three attempts each; core is available. Reports go to smoke/live/report.md. Counts in older documentation (for example 595 unit/integration tests) are historical; use the actual runner’s discovered count.

On Windows run powershell -ExecutionPolicy Bypass -File scripts/verify-windows.ps1. Logs/screenshots go to smoke/windows-report. -Live with DEEPSEEK_API_KEY adds real-model checks without writing the key to the report. PR CI runs typecheck/build/test/smoke on macOS and Windows; packaging changes additionally build and verify installed apps outside the repo.

Physical checks are needed for releases, Windows-specific UI/tray/island/installer/path changes, and bugs not reproduced on CI. On macOS, run checks locally before submitting changes. Windows release checks include -Package and manual 4K screenshots; CI alone cannot establish real-screen behavior.

Smoke profiles are isolated from user history/keys. Memory tests use real dsh with test/fixtures/fake-llm.js; other tests use fake-dsh.js speaking real ACP, including a scripted 16-tool long task. These exercise the production paths without a real model; they are not proof of real-model behavior.

## Captures and promotional video

npm run showcase (requires ffmpeg) uses real dsh with showcase-llm.js and smoke-showcase.ts to capture Today, chat, follow-ups, preparation, suggestions, approvals, sources, schedules, files, and island. The isolated profile is smoke/showcase/userData-showcase. Record at 10 fps to docs/images/demo.gif; screenshots are resized to 1600 px. Copy media to promo/public and write duration to promo/src/demo-meta.json. Review captures after UI changes.

promo/ is a separate Remotion project, excluded from installers. Generate assets first, then npm install, npm run studio, and npm run render in promo/. Output is promo/out/viva-promo.mp4 at 1920×1080/30 fps. Scenes, timing, and theme live in promo/src/scenes, timeline.ts, and theme.ts. Current legacy captures use Chinese; localized capture sets must be verified before being represented as English product media.

## Known limits

- dsh 0.2.0-rc can change incompatibly; ACP does not expose all dsh-specific plan/todo UI data.
- Conversation content is plaintext locally; keys are encrypted.
- Old traces depend on private v4 dsh logs. Failures omit activity without losing conversation text.
- Tests use Electron’s Node: the recorded system Node 24.14 zstd behavior read only the first frame of dsh’s multi-frame logs.
- Plugins pin exact dsh 0.2.0-rc.2; upgrades require compatible manifests and regression tests.
- Memory reinjection after compaction has unit coverage, but the original notes had not triggered compaction in real dsh.
- Earlier Windows 11 x64/4K tests verified the then-current four smoke phases and plugins. OS-drawn window buttons need manual inspection; those dated results do not establish current real-model or release readiness.
- Google Fonts require network; offline mode falls back to system fonts.
