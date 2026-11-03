# Design: frontend/backend split, event core and open plugins (P0)

English | [简体中文](backend-split-design.zh-CN.md)

> Status: **draft for review.** This is the target architecture and the phase plan, not the current state; for that, see [Architecture](architecture.md). As each phase lands, the matching part of the architecture document is rewritten. Date: 2026-11-04.

## 1. Goals and scope

| In scope | Out of scope (separate projects) |
|---|---|
| Split the Electron main process into a "desktop shell" and a "backend": first draw the boundary inside one process, then split into two processes | A backend that keeps running after the app quits (launch at login, notifications without the shell, crash recovery) |
| Make the backend event-driven: every input becomes a signal, and state changes go through a single write path as numbered events | A cloud backend or remote workspace (see the [long-term research](remote-workspace-research-20261104.md)) |
| Open dsh plugin loading so users can reuse the dsh plugin ecosystem | Running the dsh Web client inside Viva, or supporting plugins' Web UI parts |
| Remove message sources | Connectors (the plan to generalize message sources is dropped) |

References: the process boundary and interface style follow dsh-personal-agent's core architecture (§6, process boundary and interface style); the event-driven design follows its semantics of signals, routing and `apply`, without its consent gate and letters.

## 2. Target architecture

```
Renderer (window, desk island)
   │  the API preload exposes is unchanged; the zod contract (ipc-contract.ts) still checks it
   ▼
Desktop shell (Electron main process)
   │  windows, tray, menus, desk island, notifications, dialogs, shell, login items, power events
   │  from P3: forwards backend channels and handles only shell channels itself
   ▼  before P3: function calls; from P5: loopback HTTP + SSE with a token generated at launch
Backend (no Electron dependency)
   │  sessions and the dsh lifecycle, history, tasks, memory, follow-ups, background preparation, models, extensions, plugin management
   │  event core: signal → route → apply → event table (numbered) → pushed to the shell
   ▼  ACP over stdio + plugin IPC channels (unchanged)
dsh (profile viva: dsh-base + acp-app + user plugins + Viva's plugins)
```

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The backend is a module tree that does not import `electron`, entered at `src/backend/compose.ts`; the shell is entered at `src/shell/main.ts` | Only 8 of the 94 main-process files import electron directly, and business modules already receive Electron capabilities by injection, so the boundary mostly exists |
| D2 | The shell and the backend interact only through `HostCapabilities` (§5) and the backend channels | Electron capabilities sit behind one interface, the backend can be tested on its own, and this is the seam for splitting processes and later machines |
| D3 | Backend channels stay request/response: `IpcRegistry.handle(channel, fn)` keeps its shape and only the transport changes | The 117 channels already have a zod contract and register through `registerXxxIpc(ipcMain, deps)`; switching to dsh-personal-agent's "commands only acknowledge, results come as events" would touch every caller for too little gain |
| D4 | Everything the backend pushes to the shell travels on one event stream, each event with a monotonically increasing number; after a disconnect, events are replayed from that number. Streaming fragments are pushed but not stored | Pushes already share one channel, `agent:event` (about 30 `type`s); adding the number maps it directly onto SSE |
| D5 | Transport in P5: loopback HTTP (`POST /rpc/:channel`) + SSE (`/events?since=seq`), with a token generated at launch; binary data is uploaded as a blob first and passed by id | Matches dsh-personal-agent §6, so a cloud backend later only switches to HTTPS + account tokens; `utilityProcess` + MessagePort is rejected because it only works on one machine |
| D6 | The frontend and backend exchange content or blob ids, never local paths. The only exception is the "local capabilities" group (§4, class 3), kept as a separate group in the interface | The constraint from the long-term research; it costs nothing while everything is local and avoids another split for a remote workspace |
| D7 | The backend is event-driven (§6): signals form a closed union, routing starts as code, and state changes go through `apply` | Today main.ts calls each module back one by one; as signals they can be enumerated, recorded and replayed |
| D8 | Open dsh plugins (§7): Viva's configuration moves to the home-level patch, Viva's plugins load by file URL, HMR is turned on, and pnpm 11 ships with Viva | The findings of three validations; users can reuse host-side plugins (search, context compaction and so on) |
| D9 | Remove message sources (§8) | The plugin ecosystem already offers fuller equivalents (such as IM integration); the source contract, kit and judging pipeline cost too much to maintain |

## 4. Channel inventory

The 117 invoke channels fall into four classes by destination. The shell also pushes to the renderer on 5 channels: `agent:event`, `language:changed`, `composer:focus`, `island:view` and `island:action`.

| Class | Destination | Channels |
|---|---|---|
| 1 Backend | Backend, forwarded as is | `language:get/set`; `agent:*` (9); `models:*` (3); `history:*` except `export` (21); `timeline:*` (4); `task:*` (12); `memory:*` except `add-docs` (10); `followups:*` except `suggestion` (9); `ext:get/remove-mcp/update-mcp/remove-skill`; `settings:get/save-key/clear-key/set-permission`; `images:usage/clear` |
| 2 Shell | Handled by the shell | `shell:open-link`; `settings:set-desk-island/set-open-at-login/reset-desk-place`; `island:view/act`; `files:reveal/apps/open`; `workdir:reveal`; `images:open-folder` |
| 3 Local capabilities | A separate group in the backend (the D6 exception) | `workdir:get/switch/forget`; `files:list/preview/image/watch`; `island:files`; `ext:import-dsh`; `images:keep`, `island:keep-image` (binary; blob upload from P5) |
| 4 Mixed | The shell shows a dialog, then calls the backend | `workdir:choose`, `memory:add-docs`, `history:export`, `images:move` |
| — | Removed with message sources | `sources:*` (9), `followups:suggestion` |

`island:ask` is class 1 (it starts a conversation through the backend). `settings:save-key` needs encryption, which the backend does through `HostCapabilities.secrets`.

## 5. Host capabilities

Drawn from the current injection points in `main.ts`, this is the only way the backend uses Electron:

```ts
interface HostCapabilities {
  paths: { userData: string, documents: string, appData: string }
  secrets: { available(): boolean, encrypt(text: string): Uint8Array, decrypt(data: Uint8Array): string }  // safeStorage
  dialogs: {
    chooseFolder(options: FolderOptions): Promise<string | null>
    chooseFiles(options: FileOptions): Promise<string[]>
    saveFile(options: SaveOptions): Promise<string | null>
  }
  shell: { openExternal(url: string): Promise<void>, openPath(path: string): Promise<string>, trash(path: string): Promise<void> }
  notify(notice: { title: string, body: string, action?: string }): void
  power: { idleSeconds(): number, onWake(listener: () => void): () => void }   // resume, unlock-screen
  window: { inFront(): boolean, focusComposer(): void, showTasks(): void }
}
```

- Dialogs return local paths, used only in classes 3 and 4.
- After the P5 process split these calls become requests from the backend to the shell; the two processes start and stop together, so the shell is always there.
- How the backend runs without the shell belongs to "a backend that keeps running" and is out of scope.

## 6. Event core

### 6.1 Signals

Every input becomes an immutable signal. Signal kinds form a closed union, and a routing map missing a kind fails the type check. The first set comes from today's triggers:

| Kind | Triggered today by | Routed to |
|---|---|---|
| `chat.said` (user message, quote, images) | `agent:prompt` | Straight into the dsh session, with no model classification |
| `user.*` (follow-up accept, decline, dismiss, continue, prepare now, wake, set schedule, pause; task, memory and settings actions) | the `*-ipc.ts` modules | `command`: handled in code |
| `agent.followup_proposed` | the `viva-followups` plugin over IPC | A suggestion card that waits for the user |
| `agent.turn_ended`, `agent.started` | ACP sessions, the task registry | Gap detection; background preparation yields |
| `clock.reminder_due` | the timer in `followup-notifier` | Notice planning (`notice-plan`) |
| `clock.prepare_window` | `prepare-scheduler` | Background preparation |
| `system.woke` | `powerMonitor` resume, unlock-screen | Catching up missed reminders (deliver late, never act late) |
| `system.user_returned` | back after 15 minutes away (`createGapWatch`) | Gap |
| `window.foreground` | the window coming to the front | Gap |

- The first routing is all code: commands → rules → rhythm (gaps, the daily interruption cap). The model classification step keeps its place, but with message sources gone no signal needs it yet.
- When plugins later get an interface for sending signals to Viva, they join as another input source without changing the routing structure.

### 6.2 `apply` and the event table

- `apply(event)` is the only write path for backend state: one transaction appends the event and updates the business tables. The event number is the push number from D4.
- It covers only the backend's own state. `memory.db` and `trace.db` are written by plugins inside the dsh process; they enter as observed signals (such as `memory.changed`), not through `apply`.
- The backend's own data is spread across `followups.db`, the history store, the task store and several JSON settings files today, and writes across stores cannot be atomic. **Decided: merge into one app database.** P4 creates that database and the event table first, and business tables move in with each migration batch.

## 7. Open plugins

### 7.1 Profile layering

| Layer (later wins) | Owner | Contents |
|---|---|---|
| Bundles | dsh and plugins the user installs | dsh-base, acp-app, third-party bundles |
| Profile `cordis.patch.yml` | The plugin manager and the user | Plugin switches; Viva no longer writes this file |
| Home-level `$DSH_HOME/cordis.patch.yml` | Viva, rewritten at every launch | Persona, models, the viva-* plugin rows, `hmr` turned on, and full restatements of the stock dsh rows Viva relies on for safety (`approval`, `permission`, `sandbox-policy` and so on) |

Validated points:

- **User switches survive**: relaunching Viva no longer wipes the user's switches, and the user layer cannot change `viva-policy` or the persona.
- **Plugins load by file URL**: each Viva plugin row's `name` is its entry file's file URL, and the profile's `package.json` no longer lists Viva's plugins. Otherwise every pnpm install turns the `viva-*` forwarders into symlinks, which break inside a packaged `app.asar`.
- **HMR**: `dsh-acp-app` turns `hmr` off, so Viva's home-level patch must state `disabled: false`. A patch by id replaces only `config` and keeps the lower layer's `disabled`. With HMR on, switching plugins at runtime takes effect immediately and ACP is unaffected.
- **pnpm 11 ships with Viva**: the plugin manager installs through pnpm, which users usually do not have. It runs on Electron's built-in Node and is set through the plugin manager's `pnpmCommand`.

### 7.2 The plugins page and installing from the conversation

- **Install sources**: npm package names, git, local folders. Show the version actually installed: in the validation, dsh and pnpm picked versions older than the latest.
- **Switching and removal**: Viva's own rows cannot be switched.
- **Status and diagnostics**: entries that did not activate and why (dsh prints only one stderr line, such as `pending (waiting for service: connection)`), version incompatibilities and exemptions, approval of dependency build scripts.
- **Footprint**: the number of tools each plugin adds, and which stock dsh rows a third-party bundle changes (for example, `billion-context` replaces the whole `config` of `llm-deepseek`).
- **Notices**: when a plugin has `dsh.client`, say "its interface is not available in Viva". When it overlaps with features such as `viva-memory` (for example, other memory plugins), warn about the conflict.
- **Installing from the conversation**: follow `viva_mcp_add` and `viva_skill_install`, through an approval card.

### 7.3 Trust model

Plugins run inside the dsh process with all of the user's permissions. They can read the model keys (passed to dsh as environment variables), read and write `memory.db`, call models with the user's key, and register a `tools/pre-execute` hook that bypasses `viva-policy`. Layering protects configuration, not runtime behavior. Installing a plugin therefore means trusting it completely, and the install confirmation must say so.

### 7.4 What the ecosystem actually offers

Of the 60 most downloaded plugins, 54 have a Web client part. They fall roughly into three classes:

| Class | Examples | In Viva |
|---|---|---|
| Web UI only (skins, pets, sidebars, markets, panels) | `dsh-pet`, `dshmarket`, `dsh-better-sidebar` | No use |
| Host-side features + a settings page | `billion-context`, `dsh-free-search`, vision, memory, model integrations | The host side works; the settings page needs a generic settings form in Viva (generated from the plugin's `Config` schema; reading the schema imports plugin code, so only after the user trusts it) |
| Configured or rendered through the Web UI | `@xmanrui/dsh-im` (QR pairing), `dsh-genui` | Not usable. Under ACP, `dsh-im` stays pending, waiting for the Web client's `connection` service |

Validation results: `billion-context` adds 6 tools, `dsh-free-search` adds 9, and switching a plugin off at runtime withdraws its tools. Not yet validated: what the tools actually do when called, and loading file URLs from a packaged `app.asar`.

## 8. Removing message sources

**Removed entirely**:

- in `src/main/`: `source-check`, `source-contract`, `source-folders`, `source-install`, `source-poller`, `source-run`, `source-settings`, `sources-db`, `sources-ipc`, `sources-main`, `message-judge`, `message-reader`, `messages-channel`;
- in `src/renderer/`: `source-actions`, `source-state`, `view/sources`;
- `plugins/messages`, `packages/viva-source-kit`, `scripts/build-source-kit.mjs`, `tsconfig.kit.json`;
- `docs/sources*.md`, `docs/images/sources.png`, `docs/images/suggestion.png`;
- their tests: `message-judge*`, `message-batch-completeness`, `message-reader`, `message-sources`, `source-install`, `source-kit`, `source-poller`, `source-run`, `test/fixtures/sources/`, `test/smoke/smoke-sources.ts`, `test/smoke/live-scenarios-sources.ts`; the case in `test/followup-plugin.test.js` that judges new messages.

**Message suggestions go too**: follow-up "suggestions" (the `suggestions` table) are written only by `message-judge`. Removed: `followup-store`'s `addSuggestion`, `getSuggestion`, `listSuggestions`, `settleSuggestion`, `mutedSenders`, `recentDecisions` and the `suggestions` table; the `followups:suggestion` channel; the count of open suggestions in notices; the part of `prepare-materials` that fetches the original message; the suggestion cards in the UI. **Kept**: the follow-up cards the model proposes in conversations, and `declinedSince`, which deduplicates them (it reads `suggest_declined` events).

**Changed**:
- main process: `main.ts`, `app-plugins.ts` (drop `viva-messages` and its contract), `acp-bridge.ts`, `automation-driver.ts`, `ipc-contract.ts`, `followups-main.ts`, `followups-ipc.ts`, `followup-store.ts`, `followup-notifier.ts`, `prepare-scheduler.ts` (the step that judges new messages first in a preparation batch), `prepare-materials.ts`;
- preload and renderer: `preload.cjs`, `globals.d.ts`, `state.ts`, `followup-state.ts`, `followup-actions.ts`, `view/followups.ts`, `view/settings.ts`;
- strings and docs: both i18n message files, both READMEs, features, architecture, internationalization, `docs/i18n-manifest.json`;
- scripts and tests: `scripts/check-i18n.ts` (its required list names the kit's README), `test/app-plugins.test.ts`, `test/fixtures/fake-llm.js`, `test/followup-plugin.test.js`, `test/smoke/hooks.ts`, `test/smoke/smoke-kit.ts`, `test/source-report-registration.test.ts` (only its test data names the kit's README path).

**Kept; the names are a coincidence**: `build/icons/viva-source.png` is the app icon's original artwork; `test/source-report-registration.test.ts` tests the registration of documentation `sourceReports`; the `sources` fields in memory and the intro are the user's reference sources. Past release notes in `docs/releases/` stay as they are.

**Product impact**: the "new message → judge → suggest a follow-up" pipeline goes; follow-ups from conversations, background preparation and reminders are unaffected.

**No compatibility**: after the upgrade, old data (installed sources, `sources.db`, `source-data/`, `source-settings.json`) is neither read, migrated nor cleaned up, and no compatibility code is written.

## 9. Phases

Each phase can be reviewed and merged on its own. P3 and P5 are major architectural changes in the sense of AGENTS.md, so run `npm run build` and `npm run smoke` locally before opening their PRs.

| Phase | Contents | Acceptance |
|---|---|---|
| **P0** | This document | Review passed |
| **P1 Remove message sources** | §8 | Tests and smoke tests pass; the i18n check passes; README and features no longer mention message sources |
| **P2 Open plugins** | §7: profile layering, file URLs, HMR, bundled pnpm, plugins page, installing from the conversation, trust notice | Installing real host-side plugins with dsh: switches survive a relaunch, Viva's rows cannot be changed, runtime switching works; asar loading verified on a packaged build; new state and actions logic has unit tests |
| **P3 In-process split** | D1, D2, §5: separate backend composition and shell; the backend does not import electron; the shell only forwards backend channels | Behavior unchanged; a new test ensures `src/backend` does not import electron; smoke tests pass on macOS and Windows |
| **P4 Event core** | §6: signals, routing, `apply`, the event table, migrated in batches: follow-up pipeline → timers and gaps → conversation and UI actions | Behavior is the same before and after each batch; event numbers are contiguous; pushes carry numbers |
| **P5 Two processes** | D4, D5: the backend becomes a child process with HTTP + SSE, a token, blob uploads and host capability requests to the shell | Smoke tests pass; new-topic prewarming and time to first streamed text are measured again (see the existing performance reports), with any regression stated in the PR |

## 10. Risks and open items

| Item | Detail | Recommendation |
|---|---|---|
| Backend database | Backend state is spread across several stores and JSON files, so `apply` cannot write atomically across them | **Decided**: merge into one app database (§6.2). Each batch includes a data migration and a test that upgrades from the old stores |
| Latency | The extra HTTP hop in P5 may affect streaming and new-topic prewarming | Compare against the existing performance reports in P5's acceptance |
| dsh version | Viva pins 0.2.0-rc.2 while npm's latest is 0.2.1-rc.5; few ecosystem plugins declare rc.2 compatibility | Evaluate a dsh upgrade separately after P2; on upgrade the plugins page reports skipped plugins |
| Plugins rewriting stock dsh rows | Third-party bundles can change rows such as `llm-deepseek`, presets and compaction | The home-level patch restates the rows Viva relies on; the plugins page shows which rows each plugin changes |
| Plugin security | In-process plugins are unconstrained (§7.3) | Say so on the install confirmation; promise no isolation |
| HMR and Viva's own rewrites | Changing settings at runtime (such as models) rewrites the home-level patch, and HMR recomposes immediately instead of restarting dsh | Verify in P2 that sessions survive a recomposition |

## 11. References

- [Architecture](architecture.md): the current state.
- [Long-term research: the workspace as a replaceable execution world](remote-workspace-research-20261104.md).
- The validation code is kept locally and is not in the repository: `spike/remote-workspace/`, `spike/plugin-layering/`.

## 12. Implementation notes

What each phase actually did, and where it differs from the design above.

| Phase | What was done | Differences from the design, and what is not covered |
|---|---|---|
| P1 | Removed per §8, including the "suggestions" entry on follow-up cards; the `task-background` live scenario moved to `test/smoke/live-scenarios-tasks.ts` | Message-source data in old databases is neither migrated nor cleaned up (decided: no compatibility) |
| P2 | Viva's rows are written to `$DSH_HOME/viva.patch.yml` and layered on top with `--patch`; the profile's own `cordis.patch.yml` is left to the plugin manager; pnpm 11.28.10 ships with the app and runs under Electron as node (`src/main/pnpm-launcher.ts`) | Installs from the conversation go through dsh's own `tool-plugin-manager`, without a separate confirmation card; the Windows package was not checked locally |
| P3 | Backend composition in `src/backend/compose.ts`, host capabilities in `src/backend/host.ts`; `test/backend-boundary.test.ts` checks that the backend module tree has no runtime `electron` import | The shell entry stays at `src/main/main.ts` instead of D1's `src/shell/main.ts`: moving it only changes paths, but packaging, smoke tests and docs would all have to follow, which costs more than it gains |
| P4 | `src/backend/app-db.ts` creates `app.db` (`app_events`, `meta`); the three follow-up tables move in from `followups.db`, and the old file is kept as `.migrated`; `src/backend/event-core.ts` implements signals, routes, `apply` and `since`; follow-up writes, the reminder and preparation timers, the gap watch, wake, window foreground, chat input and turn/task ends all go through signals | History, tasks and memory are not in `app.db` yet, so their writes have no events; Settings and other UI actions are still direct IPC; signals record only their kind and shape, never what the user said |
| P5 | The backend is a child process, Electron run as Node (`src/backend/server.ts`), started by the shell through `src/main/backend-client.ts`. The launch message goes over the child's IPC channel (the token, the data key, legacy secrets in plain text, the desktop state the backend reads synchronously); everything after that is loopback HTTP: the pages' channels at `POST /rpc/<channel>`, the shell's own calls at `POST /control/<op>`, bytes uploaded first at `POST /blob` and passed by id, pictures at `GET /image`. What the backend asks of the desktop comes over SSE (`GET /events?since=`), and calls that need an answer get it at `POST /host/<id>`. Every call carries a number, and the backend starts calls in the order the shell made them (without waiting for the previous one to finish), as ipcMain did. The keychain stays in the shell: the backend encrypts with AES-256-GCM under the data key the shell hands it (`src/backend/envelope.ts`); values an earlier version encrypted with safeStorage are decrypted by the shell at launch and handed over, and are rewritten in the new form on the next write. Whether the window is in front, how long the user has been idle and the shortcut's state are pushed to the backend by the shell (the mirror); idle time every 15 seconds | Arguments are checked once in the shell and again in the backend. If the backend exits unexpectedly, the shell reports it and quits; it does not restart the backend. The replay protocol for a dropped SSE stream (`since`) exists, but since both processes live and die together the shell does not reconnect. Window pushes and call answers use two connections and could in principle arrive out of order; the smoke tests found no case. Windows was not checked locally. Splitting the processes surfaced three problems in the smoke tests that only show across processes, all fixed: JSON turned left-out arguments into null (now kept as undefined); the server closed idle connections after 5 seconds, so a call reusing one was lost and every call after it waited for its number (now the server keeps idle connections, a failed reused socket is retried once, and a missing number is skipped after 5 seconds); the desk island page missed a view that arrived while it waited for its language (now it keeps it). Performance (macOS, local): call round trip p50 0.05 ms, p95 0.1 ms; a 266 KB answer p50 2.6 ms; about 0.02 ms per push. Three `--project=performance` runs against P3: reader open 16–27 ms (P3 26), 200 KB Markdown 29–31 ms (P3 22), a far message 9–15 ms (P3 6), scrolling p95 18.1–18.8 ms (P3 18.3). Markdown and the far message gained about one frame: large answers take 2–3 ms more round trip, and the measurement polls by frame. All within budget (150 ms) |
