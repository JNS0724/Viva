# Architecture: decoupling through dsh plugins

[English](architecture.md) · [简体中文](architecture.zh-CN.md)

This document explains which capabilities belong in DeepSeek Harness plugins, the ACP layer, or the app; their versioned contracts; and alternatives investigated but not adopted. See [Memory](memory.md) for the memory plugin.

## 1. Layers

| Layer | Responsibility | Examples |
|---|---|---|
| dsh plugins in the app profile | Model context, tools, pre-execution policy, background model calls | Memory, trace, policy |
| ACP, independent of a specific agent | Session lifecycle, streaming, approval requests, MCP declarations | User MCP servers, approval cards |
| Electron app | Presentation, local data, OS integration | About you, history, system-keychain credentials |

Use a plugin only when a capability needs agent internals: injection before steps, session-bound state, native tools without approvals, reusing the model, or interception before execution. Keep the rest in ACP or the app. dsh is still a 0.2.0 release candidate; plugins use its own APIs and increase the cost of switching ACP agents. This rule covers the app's own plugins. The dsh plugins users install themselves (Settings → Plugins, section 4) are a different matter: the app is now tied to dsh's plugin ecosystem on purpose; see [Design: frontend/backend split, event core and open plugins](backend-split-design.md).

Plugins and the app cooperate through versioned contracts: SQLite for durable data, separate IPC channels for questions, configuration, and streaming events.

## 2. Components

The main process writes the app’s `viva` profile and starts dsh over ACP stdio. Persona patches configure `system-prompt`; memory and trace use `memory.db` and `trace.db`. Question/configuration/follow-up/message/stream/task channels connect plugins with main-process services. The renderer uses a validated preload API rather than directly opening these databases or talking to plugins.

The app runs as two processes (see [Design: frontend/backend split](backend-split-design.md)): the shell (`src/main/main.ts`, the Electron main process) owns windows, the tray, the desk island and the other Electron APIs; the backend (`src/backend/server.ts`, a child process running Electron as Node, composed in `src/backend/compose.ts`) holds everything else, has no runtime `electron` import, and reaches the desktop only through `HostCapabilities` (`src/backend/host.ts`), which it calls over loopback HTTP and SSE with a launch token. The pages still talk to the shell over IPC; the shell checks each call against `ipc-contract.ts` and forwards it to the backend. Inputs to the backend are signals of a closed set of kinds (`src/backend/event-core.ts`), each with a route. Changes go through `apply`, which writes the change and a numbered row in `app_events` of `app.db` in one transaction, and every push to the window carries that number. `app.db` also holds the follow-ups, the history and the background tasks, whose writes go through `apply` (`src/backend/journal.ts`); an event records ids, statuses and numbers, and only the length of any text. Memory and the trace stay in their plugins' own files, which dsh's process writes: the user's memory edits are recorded right after they are written, and what the agent saved when the app reads it after a turn.

| Plugin | Contract | Plugin responsibility | App responsibility |
|---|---|---|---|
| viva-memory | memory@1 | Memories, session state, injection records, synthesized profiles | Read/write profile and memories, write habits, display injection traces |
| viva-trace | trace@1 | Per-turn thoughts and tool calls | Read traces when reopening conversations |
| viva-policy | policy@1 | Behavior only: intercept execution | No shared data |
| viva-questions | questions@1 IPC | Forward model questions from dsh’s tool-ask-user | Show cards, return answers |
| viva-followups | followups@1 IPC | Propose follow-ups; return tool-free preparation results | Require user acceptance, store them in app.db, schedule preparation, receive drafts |
| viva-plugins | plugins@1 IPC | Answers from dsh's plugin manager | The Settings → Plugins list, lookup, install, switch, removal (src/main/plugins-ipc.ts), all through dsh's plugin manager |
| viva-config | config@1 IPC | Request MCP/skill configuration after approval | Validate and apply; collect secrets in the window, encrypt, never return them to dsh |
| viva-stream | stream@1 IPC | Live text/thought deltas and committed visible content | Select source per call; reconcile attempts, withdrawals, and final content; ACP still handles tools, usage, approvals |
| viva-tasks | tasks@1 IPC | Read-only application-task queries | Scope and session checks, live registry, bounded request/output previews |

Persona is not a plugin. `PERSONA` in `src/main/app-plugins.ts` supplies `personaPrefix` and `personaSuffix` through the profile patch.

## 3. Manifests and contracts

`APP_PLUGINS` lists each name, folder, provided contract, and configuration such as userData paths. Each plugin declares its contract in package.json, for example `"viva": { "contract": { "memory": 1 } }`.

Before startup, `resolvePlugins` verifies existence, readable package.json, matching name, exact contract version, and any exact dsh dependency version. Failed plugins are omitted from the profile with reasons displayed in Settings. Databases record `meta.contract_version`; data written by a newer contract is rejected rather than misread. Replacements can implement the same named/versioned contract and change only the manifest entry.

## 4. Writing the profile

`src/main/dsh-profile.ts` writes `<userData>/dsh/profiles/viva` before launch, changing only files whose contents differ. The profile has three layers; later ones win:

| Layer | Owner | Contents |
|---|---|---|
| Bundles | dsh and the plugins the user installs | The bundles of dsh's bundled ACP template, plus those the user installs under Plugins |
| The profile's `cordis.patch.yml` | The user and dsh's plugin manager | Plugin switches. The app only writes an empty `[]` when the file is missing |
| The app's layer: `<dsh home>/viva.patch.yml`, given to dsh with `--patch` at launch | The app, rewritten at every launch | See below |

The app's layer holds:

- system-prompt and plugin insertion/configuration. Patching by ID replaces the configuration, so both persona prefix and suffix must be supplied.
- Model providers use dsh's `llm-pi-ai`. Without a DeepSeek key, disable `llm-deepseek` and `llm-deepseek-account`. New-session defaults override the ACP provider/model. Keys enter the dsh process through environment variables, not the profile.
- Each plugin's `name` is its entry file's file URL. Plugins remain inside the app (including app.asar when installed); their imports resolve there. The profile's package.json does not list them, so pnpm leaves them alone when the user installs a plugin.
- `hmr` switched on (`dsh-acp-app` switches it off, and a patch by ID keeps the lower layer's `disabled`, so it states `disabled: false`), so the user's plugins switch while dsh runs; `tool-plugin-manager` switched on, so the model can propose installing a plugin in conversation, each call approved by the user on an approval card; `plugin-manager`'s `pnpmCommand` pointing at the pnpm the app ships (a launcher `src/main/pnpm-launcher.ts` writes, run on the app's own runtime).
- The dsh-base rows the app relies on for safety (`sandbox-policy`, `approval`, `permission`) restated whole, so neither a bundle nor the user's layer can change them; `test/dsh-profile.test.ts` keeps them word for word equal to dsh-base.

Normal operation does not read or write the user's own `~/.dsh`; only an explicit import reads it. If the profile cannot be written, fall back to bundled ACP without app plugins/persona and without the app's layer.

## 5. dsh interfaces and lifecycle

| Plugin | Interfaces |
|---|---|
| memory | agent/pre-step, sessionProjections, tools.register, agent/turn-stopping, llm.stream |
| trace | agent/turn-stopping and session.eventAt |
| policy | tools/pre-execute, before approval; deny with an explanation |
| followups | tools.register and llm.stream without tools |
| stream | agent/assistant-stream, session/event, agent/disposed |
| plugins | ctx.pluginManager (dsh-plugin-manager: listBundles, listPlugins, inspect, installBundle, removeBundle, setBundleEnabled, setPluginEnabled) |

viva-stream depends on dsh internals, not a general ACP extension. dsh is pinned to `0.2.0-rc.2`, whose ACP adapter forwards committed whole blocks rather than actual deltas. On upgrades, rerun `test/stream-runtime.test.js` with real dsh and delayed SSE: first text must precede response completion and cancellation must preserve the committed prefix. Inspect event/block structures. If the plugin is unavailable, use ACP. If a selected streaming channel fails mid-call, withdraw that call’s provisional content before restoring complete ACP output to avoid omissions or duplicate appends.

A new topic shows an empty input immediately; typing is allowed during preparation but sending waits. Failures preserve the draft and allow retry. Remove the old session from foreground routing immediately while closure and persistence finish. Warm sessions can take over directly. Cold MCP creation waits for old resources to close, as does resuming the same session. At most one former foreground session may finish cleanup concurrently.

At most one independent empty session may be prepared in advance, with its own MCP processes/connections. Unconsumed ready sessions expire after 120 seconds. A singleton server can reject a second connection: discard that speculative session without changing official MCP status or its 30-second failure cooldown. Stop repeating the same failed fingerprint until configuration changes, explicit reload, or restart. Real session creation retries. Sessions never share MCP clients. Clean up stale spares before replacement; cleanup failure may retry next time; late creation after disposal must not publish a spare.

Enable main timing with `VIVA_SESSION_TIMING=1`, renderer timing with `localStorage.setItem('viva:session-timing', '1')`. Record only stages, durations, source hits, and outcomes, never prompts or MCP configuration. ACP session/new combines creation and MCP initialization, so do not present them as separately measured phases.

Plugin failures log and degrade gracefully: failed injection omits memories; failed trace recording omits activity without breaking the conversation. Loading failures identify the plugin in dsh warnings while startup continues.

## 6. Decisions and evidence

- **Persona:** personal work assistant rather than the ACP template’s coding-agent identity. Tests inspect the model request.
- **Contracts:** manifest and database version checks as above.
- **dsh-time-context:** not adopted. Without browser timezone (as with ACP), it asks the model to clarify dates repeatedly. Memory still injects today’s date.
- **Trace export:** new sessions use trace.db; older pre-plugin sessions may parse private dsh logs. Both share plugins/trace/lib/steps.ts.
- **Sending policy:** deny MCP names containing send/reply/forward/post/publish/deliver/broadcast, including underscore and camelCase forms, before execution. The recorded dsh behavior did not request approval for MCP tools, so this plugin is the hard no-sending boundary.
- **ACP notifications:** rc.2 exposes no plugin custom-notification API. The app polls memory.db every two seconds for 30 seconds after a turn.
- **Other models:** reuse llm-pi-ai (OpenAI Chat Completions, OpenAI Responses, Anthropic Messages), not another plugin. Tests verified grouped ACP options, selected baseURL/key, and memory injection. ACP defaults come from the ACP plugin configuration; agent-default-model does not control ACP sessions.
- **Sources:** removed (2026-11). External messages now come from dsh plugins the user installs; see [Design: frontend/backend split, event core and open plugins](backend-split-design.md).
- **Related fixes:** extraction reads assistant/message from data.message; invalidating profile-type memories triggers resynthesis immediately rather than waiting 24 hours.

## 7. Verification

Real dsh plus the local fake model in test/fixtures/dsh-harness.js uses the actual manifests and persona. memory-plugin tests cover memory/persona; trace-plugin tests recover activity without private logs; policy-plugin tests prove fake mail sending is blocked while drafting works; model-routes tests cover provider defaults, routing, and credentials. app-plugins tests reject wrong contracts, dsh versions, and missing plugins. dsh-profile tests cover persona, multiple plugins, removal, and unreadable files.

## 8. Open work recorded by the original design

- Move memory rules from user-message injection into a registered system-prompt section after confirming the API, potentially enabling prefix caching.
- Add further tool policies only for concrete needs, such as sensitive directories.
- Replace polling when dsh exposes ACP extension notifications.

## 9. Internationalization

`src/shared/i18n/` is shared by main and renderer. The main process owns the persisted language preference; validated IPC broadcasts a resolved locale to both windows. Translation keys and interpolation parameters are typed. The UI refreshes locale-sensitive caches without restarting sessions. Protocol IDs, user content, historical messages, and third-party output retain their original form. Build output includes the shared resources.
