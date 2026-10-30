# Memory design

English | [简体中文](memory.zh-CN.md)

This describes long-term memory writes, updates, retrieval, profile synthesis, and the plugin/app contract. Code is authoritative. Historical validation statements below retain their original scope; they are not new internationalization test results.

## 1. Goals and constraints

Remember the user's role, collaborators, projects, preferences, agreements, and decisions. Avoid flooding every turn with fuzzy matches to the full question. Replace outdated facts while preserving history. Every entry must be inspectable, editable, and removable, including background writes. Memory must remain replaceable independently of the app. Data stays local except inputs to the user's chosen model; passwords, keys, verification codes, and identity numbers must not be stored.

## 2. Structure

`plugins/memory` runs in the private Viva dsh profile alongside activity and policy plugins. Electron provides UI; both processes access `memory.db` in WAL mode. See [Architecture](architecture.md).

| Module | Responsibility |
|---|---|
| `plugins/memory/index.ts` | Pre-step injection, tools, after-turn work, compaction count |
| `plugins/memory/lib/store.ts` | Shared database contract |
| `layers.ts` | Pure per-turn injection planning |
| `names.ts` | Name vocabulary and matching |
| `match.ts` | Recall scoring/threshold |
| `context.ts` | Injected text and memory rules |
| `inject.ts` | Read, plan, persist session state, log injection |
| `tools.ts` | Memory tools |
| `extract.ts` | Background extraction |
| `synthesize.ts` | Profile synthesis |
| `src/main/app-plugins.ts` | Plugin list, persona, contract/dsh compatibility |
| `src/main/dsh-profile.ts` | Private profile generation |
| `src/main/personal.ts` | Changes/injection reporting and habit writes |
| `src/main/memory-ipc.ts` | About-you IPC |

Before each dsh start, `dsh-profile.ts` writes changed files under `<app data>/dsh/profiles/viva`: an ACP composition (`dsh-base`, `dsh-acp-app`) plus `link:` plugin dependencies; forwarding packages in profile `node_modules/viva-*` exporting the plugin file URL; and `cordis.patch.yml` containing persona, plugin insertions, and the database path. `cordis.yml` and `pnpm-workspace.yaml` are created only when absent. Installed apps keep plugins inside app.asar.

Declared contract and exact dsh peer versions must match or the plugin is excluded with a Settings explanation. Other user profiles, including their ACP profile, are untouched. Profile-write failure falls back to ACP without memory; plugin-load failure logs its name but leaves conversation available.

## 3. Database contract

`store.ts` enables WAL, a three-second busy timeout, and short transactions. Opening an old database adds columns and runs one-time profile migrations.

| Table | Contents and writer |
|---|---|
| `profile` | `field,value,source,updated_at`; user-owned fields |
| `memories` | User/tool/extractor memories |
| `syntheses` | Synthesized profile text/date; latest 20 versions, plugin-owned |
| `sessions` | Per-dsh-session retrieval state JSON |
| `injections` | Actual injected context; latest 1,000 records, read by app activity |
| `meta` | `contract_version` (1; newer versions are rejected), `onboarding`, app-written `habits`, `plugin_started_at`, `profile_migrated`, and owner-specific metadata |

Memory fields are `text` and unique normalized `norm`; `kind` (`role`, `person`, `project`, `preference`, `fact`); `source` (`user` or `agent`); up to six `keywords`; `conversation_id` (claimed by app, or `profile-migration`); millisecond `created_at/updated_at`; nullable `invalid_at`; `superseded_by`; and `invalidated_by` (`user` or `agent`).

## 4. Two write channels

The model chooses what to propose; code validates what may be stored.

**Explicit tools:** Remember requests call `memory_remember(text, kind, keywords)` immediately. Duplicate normalized text refreshes its timestamp and merges keywords; invalid entries are restored. `memory_recall` accepts specific keywords; one is enough for a precise subject, and an unsuccessful multi-keyword query should be retried with fewer terms. It returns at most five sufficiently relevant memories. `memory_forget` invalidates an id only at the user's request. These native dsh tools do not show permission cards. Invalid keywords are dropped rather than failing the entire call. Tool descriptions and memory rules forbid claiming a save without successful execution.

**Background extraction:** `agent/turn-stopping` starts asynchronous work without delaying the answer. The user's own words must contain at least four characters and a self-description signal (role, recurring schedule, preferences, changed supervisor, etc.) or a known name; a bare first-person pronoun does not qualify. Up to ten candidates are chosen by names first, then wording. Only those candidates may be invalidated. The current provider/model receives JSON containing today's date, user text, the first 1,500 answer characters, profile, and candidates. Output is `{"add":[{text,kind,keywords,replaces}],"invalidate":[id]}`, at most three changes. Any invalid result discards the batch and logs a reason.

## 5. Append and invalidate

Automatic changes add facts and optionally point `replaces` at an old fact, or explicitly invalidate a candidate. Old entries get invalidation/replacement metadata and leave retrieval/synthesis, but remain reviewable/restorable. `applyExtraction` is atomic: more than three changes, missing/unseen candidates, user-owned invalidation, sensitive text, invalid kinds, or memory-cap overflow rolls back the whole batch.

User-owned entries can be invalidated only by the user, directly or through an explicitly requested `memory_forget` (`invalidated_by=user`). Re-saving identical content restores it. Actual deletion only happens in About you and offers Undo, restoring prior invalidation state too. Each injection/extraction includes today's date; relative dates must be saved as absolute dates.

## 6. User profile and synthesized profile

Profile fields and learned facts use different write paths. The user owns role/responsibilities, current projects, and preferences. The synthesized profile is a derived view of active memories, not directly editable; change its source memories instead. Up to eight profile-kind memories added after the last synthesis appear as Recently learned.

After extraction, synthesis is considered using the current model route. Changed/refreshed/invalidated memories trigger rebuilding when there is no prior synthesis, a profile memory was invalidated, 24 hours elapsed, or five changes accumulated. Inputs are user profile excluding email and at most 150 active role/person/project/preference memories with dates. The previous synthesis is deliberately excluded to avoid copying invalid facts back.

The existing synthesis format uses four ordered headings—identity/responsibilities, regular contacts, current work, preferences—with `- ` lines and a 1,200-character cap. These stored format markers are currently Chinese and validated as a contract, independent of interface language. Invalid format or sensitive output retains the previous synthesis.

Legacy agent-written profile fields become agent memories line by line once, then are cleared without new-memory notifications. Since 0.2.2, retired user department/domain/contact/site/document/IM fields become user memories; department/domain map to role, contacts to person, others to fact, with name keywords where appropriate. Email remains private in the table: never migrated, shown, or sent to the model. `profile_trimmed` records this migration.

## 7. Three retrieval layers

### Fixed context

Today, memory rules, user profile, synthesized profile, recent discoveries, and habits share a 3,200-character budget. Rules always fit first; remaining sections consume the budget in order. Reasons are `first` (session start), `compacted` (counted `compaction/end` events), and `changed` (profile/synthesis/habits changed). Newly learned conversation memories do not resend the fixed layer because the model already saw them. Crossing midnight injects just the new date.

### Name-triggered context

Vocabulary comes from current-project profile text (split punctuation/newlines, removing parenthetical/colon explanations) and active memory keywords. Generic or too-short terms are excluded. Exact names match; long Chinese names also match contiguous four-character aliases. English requires word boundaries, so PR does not match prompt.

Only the user's own words count. Inputs over 300 characters use their first/last lines, capped at 120 each; short (at most six characters) or recognized follow-up phrases incorporate the preceding question. Sort by matched-name count then update time; send at most three memories with their name reason. Already-pushed unchanged entries and fixed-context entries are excluded. Session start/compaction resets pushed state. No name match means no push, without fuzzy fallback.

### Explicit recall

When context is insufficient, the model calls `memory_recall`. A query qualifies by containment against a memory keyword, or at least 34% coverage using Chinese bigrams/English words. Return at most five entries; no match returns empty and asks the model to admit uncertainty.

## 8. Turn sequence

1. On the first pre-step of a user turn (not child-agent turns), read profile/synthesis/memory, plan layers, save session state, and log injection. Append sourced `<about-user>…</about-user>` context after the question.
2. The model answers and may call native memory tools.
3. On turn-stopping, run extraction then due synthesis asynchronously, within a combined 120-second deadline; unloading aborts them.
4. On turn end, app `personal.collect()` reports immediately, then polls every two seconds for 30 seconds. `memory_changed` drives notifications; `memory_context` drives activity rows.

Injection/background failures log a reason without failing the conversation.

## 9. Inspect and control

About you contains user fields, habits, dated read-only synthesis, searchable/addable/deletable memories with kind/source/keywords, and expandable invalid entries with reasons and Restore. Activity explains which context was included and why. Saves and invalidations show View notifications. Deleting a conversation does not delete memory. Settings considers the plugin loaded only when its heartbeat is newer than the current dsh start.

## 10. Privacy and safety

`looksSecret` rejects passwords/passcodes/verification codes, `sk-` keys, tokens, 18-digit identity numbers, and random strings of 32+ characters; long document-link ids are exempt. Memory text, keywords, and synthesized profiles all pass this filter. Email is excluded from model/extractor/synthesizer inputs. JSON isolates extraction/synthesis inputs from instructions. Background work never overwrites or invalidates user-owned entries. SQLite `secure_delete` clears deleted records. Data lives locally in `memory.db`; only selected injected context and background-call inputs go to the configured model.

## 11. Replacing the plugin

Provide a `viva-*` dsh plugin declaring `"viva":{"contract":{"memory":1}}`, then replace the memory entry in `APP_PLUGINS`. Preserve `memory@1` tables and store interfaces (`profile`, `memories` including invalidation fields, `syntheses`, `injections`) to retain UI/activity compatibility. Schema changes require contract version 2 and coordinated IPC/personal/UI changes. Exact dsh peers currently pin `0.2.0-rc.2`; upgrades require coordinated plugin manifests or compatibility checks exclude them while chat remains available.

## 12. Tests

| Suite | Coverage |
|---|---|
| `memory.test.js` | Store, context, tools, IPC |
| `memory-layers.test.js` | Vocabulary, query basis, layers, injection, keywords, migrations |
| `memory-extract.test.js` | Gate/candidates/validation, rollback, invalidation/restoration, UI state |
| `memory-synthesis.test.js` | Timing/format/input scope, fixed context, legacy migration |
| `memory-plugin.test.js` | Actual dsh/full profile/fake model: injection counts, names, tools, restart, failure, extraction including answer text, replacement, user protection, synthesis, persona |
| `app-plugins.test.js` | Plugin list and contract/dsh/database compatibility |
| `dsh-profile.test.js` | Profile writing/idempotency/link replacement/failure preservation |
| `npm run smoke` memory phase | Actual Electron and dsh, fake model, full UI flow |
| `npm run live:memory` | Actual DeepSeek model, manual and billable |

The fake LLM intercepts requests through `DEEPSEEK_BASE_URL`, provides deterministic chat/extraction/synthesis responses, and needs no real key. Live memory tests read `DEEPSEEK_API_KEY` or a mode-600 `LIVE_ENV` file without printing it, use disposable sessions, and write `smoke/live-memory.json`.

## 13. Parameters

| Parameter | Value | Owner |
|---|---|---|
| Fixed context / recent discoveries | 3,200 characters / 8 | `context.ts` |
| Pushed memories | 3 | `layers.ts` |
| Long input / short follow-up | >300 / ≤6 characters | `layers.ts` |
| Chinese alias | 4 contiguous characters | `names.ts` |
| Recall threshold / limit | 34% / 5 | `match.ts`, `tools.ts` |
| Extraction minimum / candidates / changes | 4 characters / 10 / 3 | `extract.ts`, `store.ts` |
| Synthesis interval / changes / inputs / length | 24 hours / 5 / 150 / 1,200 characters | `synthesize.ts`, `store.ts` |
| After-turn deadline | 120 seconds | `index.ts` |
| App result polling | Every 2 seconds for 30 seconds | `main.ts` |
| Memory length / total | 500 characters / 5,000 | `store.ts` |
| Keywords / length | 6 / 2–20 characters | `store.ts` |

## 14. Limitations

Changing a supervisor does not automatically invalidate an indirect weekly-report recipient agreement; confirming derived implications remains undecided. Kinds can be misclassified. Deduplication recognizes normalized exact text, not paraphrases. Fixed-layer resend after compaction has unit coverage but the original validation did not force actual-dsh compaction. The prior memory work reports Windows 11 installed-app verification; that is historical evidence. Exact dsh pinning remains required. Memory rules currently ride in a sourced user message; moving them to a cacheable system prefix needs a verified dsh section-registration API. Packaging uses electron-builder/asar with the ACP dependency closure. Language heuristics and synthesis markers remain part of the memory contract and need separate bilingual model evaluation.

## 15. Design rationale

The original design favored three layers over raw-question fuzzy retrieval to reduce follow-up/paste/topic-switch noise; a dsh plugin over MCP to support pre-step injection, durable session state, and native tools; explicit writes plus extraction because verbal save claims can fail; append/soft-invalidation to preserve history; and user fields plus rebuilt summaries rather than repeatedly rewriting one profile. It cited LangMem/Letta, mem0/Zep, and vendor summary behavior as inspiration, not as verified current product guarantees. Importance scores and forgetting curves were deferred for lack of stable product evidence. Background changes are visible and reversible to keep memory understandable.
