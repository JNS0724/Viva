# Features

English | [简体中文](features.zh-CN.md)

See [README](../README.md) for installation and [Development](development.md) for building and testing. UI labels follow Settings → Language; user content and assistant replies retain their own language. Screenshots in this guide were captured in Chinese.

<a id="viva-岛"></a>
## Viva island

The dark capsule's border indicates state: subdued when idle, orange when attention is needed, red on error, blue on completion. In the title bar the island shows only a dot in the same color; on the desktop the maid sits at its upper left at 72 px, and the island grows around her.

- **In the window:** the title-bar island shows overall elapsed time and step count. Clicking expands recent steps, Stop, and the full activity view; merely passing over it does not expand it. While approval or an answer is pending, it says that attention is needed and scrolls to the conversation card. The question or approval details appear only in that card. The cat row at the end of the conversation describes the current action.
- **On the desktop:** closing the window keeps Viva in the tray/menu bar and shows the island at the top center. Minimizing or covering the window does not show it. The desktop island shows activity, asks for attention, and accepts work; open the main window for detailed activity. Running work has one action/elapsed-time line. Approvals expand automatically with Allow/Deny; a single-choice question can be answered directly, while other questions open the window. Errors show their reason. Completion remains for five seconds, stays while hovered, and remains another two seconds after leaving. Idle state is just the cat.
- **Hover and click:** hovering for about 0.2 seconds reveals a drag handle and, during work, Stop. Idle hover shows the question/file-drop hint and an open-window button. Clicking her while idle opens the input; clicking running/completed/error state opens the window. The tray and Dock also open the window and hide the desktop island.
- **Context menu:** Ask, Open Viva window, Stop (while working), Move to top center, Hide until the next window close, and Disable desktop island. Disabling persists until reenabled in Settings. The shortcut works with either hiding option. See `src/shell/desk-menu.ts`.
- **First use:** a coach card explains clicking/shortcut, dropping files, dragging, and the context menu. Dismissing it, opening input, or dragging records `deskCoached` in `preferences.json`. Quit through the tray menu, or ⌘Q on macOS.
- **Ask anywhere:** ⌘⇧Space, or Ctrl+Shift+Space on Windows, opens island input. Enter sends to the current conversation; Esc closes. If the main window is open, the shortcut foregrounds it and focuses its composer. During work, input steers the current turn. Pending approvals/questions take precedence. With the desktop island disabled, the shortcut can temporarily show it while the window is closed to tray; it hides after the requested work completes. Settings reports shortcut conflicts.
- **Drop files:** drop up to ten files (folders are unsupported), then choose Summarize or type a request. Files are not copied: their local paths are appended using `src/shared/attachments.ts`. Conversation attachments show file labels and desktop-island origin. Reading outside the workspace still asks for approval.
- **Move:** drag anywhere; it shrinks to her while moving. Near top center it snaps home. Lower-screen placement expands upward; edges expand inward. Position is remembered by display; removing that display returns it to the main window's display. Settings can reset placement (`src/shell/desk-place.ts`). During drag the transparent window shrinks from 600×352 to 104×104, moves on animation frames, and uses `setBounds` to avoid size drift at fractional Windows scaling. Animation and shadows are reduced during drag.
- **Disable:** Settings stores the switch and position in `preferences.json`. Closing still keeps the app in the tray.
- **Focus and input:** only open island input takes keyboard focus, which returns to the previous app when closed. The macOS window is a nonactivating panel. The island is excluded from screen capture/sharing and macOS fullscreen apps. Main checks the pointer every 50 ms and allows clicks/drops only over the island; other clicks pass through. It avoids Electron's `forward` mouse hook because a busy Windows main process could otherwise delay systemwide mouse movement.
- **Implementation:** both islands use `view/island-dom.ts` and `island-view.ts`; desktop input uses `view/island-input.ts`. `desk-island.ts` owns the transparent window and `desk.html`; `island-main.ts` relays state/actions. `island-ipc.ts` validates request identity, bounded text, and existing file paths. Smoke covers desktop approval, input, dropped files, and delivery to the main conversation.

<a id="工作中插话"></a>
## Steering during work

Send additions or corrections without waiting. The composer remains editable, with Send when it contains text and Stop when empty; desktop input behaves the same. The assistant reads the addition before its next step, after the current tool finishes, without starting a separate turn or interrupting that tool. The conversation marks it as steering. The model receives it after a note for the model only ("【插话】 said by the user while you were still on what they asked before, verbatim:"); the window shows the words as typed. The persona asks for a reply to every interjection: adjust and say so for an addition or correction, do another request and report it, then carry on with the earlier work without waiting for "continue"; drop or change the earlier work only when the user says to stop, pause or do something else, and keep asking for confirmations as usual. This relies on the model; the app does not check it separately. With a real model (a code review interrupted at once by "send me today's brief too"), the review was put off in 3 of 6 runs before and in none of 6 after (a loose check by keywords and length, not a review of quality); the live scenario `steer-another` keeps watching it. If the turn has just finished, delivery waits for cleanup and becomes the next question exactly once. Failed delivery stays visible with a retry-after-completion explanation.

The main composer, Run in background, task composer, and Edit and resend accept at most 20,000 characters. Oversized input explains the limit and retains the draft before sending or changing conversation paths.

ACP accepts only one active prompt per session, so `viva-steer` (`plugins/steer`, `steer@1`) relays through the dsh IPC channel to `agent.steer`. `src/backend/steer-channel.ts` uses a five-second acknowledgement timeout. Actual-dsh integration tests verify delivery within the same turn and exactly one turn end.

<a id="后台任务"></a>
## Background tasks

Just ask the assistant: it hands long work to the background itself (`start_background_task`, a fresh session started from a brief that carries the background it needs), and stops, adds to, asks again or takes up an interrupted task when you say so (`stop_background_task`, `message_background_task`). At most 5 run at once (asking one again or taking one up counts too); when full it tells you. When a task ends, its result goes back to the main conversation, whatever topic it is on now: background tasks are its to look after. While the assistant is answering, the result is added to that turn and it tells you in passing; when the conversation is free, the assistant comes back with the result in a turn of its own, saying what you may need to do, and tasks that end together share one turn. The note it is given says the task's background, purpose and the topic it came from; it counts as delivered only once the assistant has read it, and if Viva quits meanwhile it is delivered after the next launch. Where it came, the conversation keeps a collapsed record: "✓ #task · Result added to this turn / Result sent to the conversation · time · Show", which opens on what the conversation was given and Open task, and is still there when the conversation is opened again. A turn of its own has no words of yours, only the assistant's. A task cannot start tasks of its own.

Each task leaves a single clickable status line in its original conversation, with its name, state, preview, and a link to its Background page. Approvals, questions and Stop are handled in one place, the Background page. Status wording is consistent across the conversation, page, and island.

The island shows a spinner and active count, a check and unseen completion count, or an attention count. Opening a completed task marks that result seen, clears its island reminder, and retains its historical line and page entry. Seen state survives restart; a new result becomes unseen again.

The turn rail stays on the left. The Background page shares the persistent Review/Background/About you/Settings navigation and has a collapsible task list whose state is saved. It shows the selected task's whole conversation, with Stop while it works and Close once it ended; there is no input box there, so additions and follow-ups are said to the assistant.

Drag either conversation edge to resize from 560 px up to the available width; double-click restores 760 px. The width is saved. Close dismisses a task. What a task says is saved by the backend as it comes (about every 10 seconds, and at once when its turn ends), and once more when Viva quits or the assistant exits, with or without a window open. After a restart, unfinished tasks are marked interrupted on the Background page; tell the assistant to go on and it takes the original session up again, or close them. See `smoke-tasks.ts` and `smoke-column.ts`.

<a id="文件"></a>
## Files

The drawer is a read-only workspace browser. Folders load on expansion; `.git` and `node_modules` are subdued. Files read/written in the current conversation have blue markers; the tree refreshes after turns. Markdown renders local workspace images, code uses main-process highlight.js, CSV/TSV tables show up to 2,000 rows with a raw-text toggle, images display directly, and binary files show name/size. Text pages are 200 KB and load on scroll. Disk changes refresh the open preview.

Open uses the default application. Its menu lists compatible apps with icons/default indication and Reveal in Finder/Explorer, using dsh's native-command module. Executables/scripts (`.exe`, `.sh`, `.js`, `.ps1`, etc.) only offer Reveal. Main validates paths and rejects traversal, absolute paths, and links escaping the workspace (`workspace-files.ts`).

Assistant file access differs from read-only preview: in Workspace changes and Read only modes, reads/searches outside the real workspace path ask for approval, including links. Arbitrary shell commands also ask because command text cannot prove read-only scope. Denial returns no file content; one-time approval does not become permanent or override write restrictions. Auto uses dsh review; Full does not ask.

<a id="在对话里配置-mcp-和-skill"></a>
## Configure MCP and skills in conversation

Ask to connect a service or save a procedure as a skill. What is there is on the Capabilities page, beside Search, About you and Settings: Skills, MCP and Plugins as tabs, a list on the left and the one picked on the right, with a count by its name when something does not work. Servers can be edited in place or deleted; Viva's own skills can be removed, and the workspace's are marked read-only.

- **Skill checks:** each skill is checked by the rules dsh loads skills by: YAML frontmatter, a name and a description, a kebab-case name, and `disable-model-invocation` / `user-invocable` written as booleans (`src/backend/skill-spec.ts`). dsh skips a skill that breaks them with only a warning in its log, so the model never learns of it; the page says why. Of skills with one name dsh loads one, by its priority (the workspace's `.dsh/skills`, then its `.agents/skills`, then Viva's), and the others say which one hides them. The workspace is found as dsh finds it: the nearest folder holding `.git`, from the working folder up.
- **Importing skills:** Capabilities → Skills → Import first asks where from: Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`), `~/.agents/skills` and your own dsh where found on this computer, or Choose a folder… (a folder of skills or one skill's folder). Each skill there is checked: those that follow the rules are ticked; one whose name is not in kebab case, or that Viva already has by name, goes in renamed in the copy (a clash is not ticked to begin with); one dsh cannot load (no frontmatter, a missing field, a bad switch, a name that makes no kebab case) cannot be ticked, and says why. Importing only copies into Viva's skills folder; the originals are left as they are (`src/backend/skill-import.ts`).

`viva-config` exposes `viva_mcp_add/update/remove/list/import` and `viva_skill_create/install/remove/list`. Mutations require approval showing the command and arguments. Importing existing dsh configuration is the documented exception below. When secrets are needed, the model supplies only variable names; a dedicated window form sends values directly to main for safeStorage encryption in `mcp-servers.json`. Secrets do not enter dsh, chat, or activity; activity records only the request and completion of secret entry.

The plugin uses `config@1` IPC; `config-channel.ts` validates each request and reuses configuration storage. MCP reconnects after the turn; skills become available immediately. Skill names use lowercase letters, numbers, and hyphens; descriptions may use any language. Persona instructions require these tools and prohibit asking for secret values in conversation.

### Import and edit in place

Import from dsh accepts `DSH_HOME` (default `~/.dsh`), the last folder, or another folder, through Capabilities → MCP or chat.

Import from other clients (Capabilities → MCP) lists the servers set up in Claude Desktop, Claude Code (`~/.claude.json`) and Cursor (`~/.cursor/mcp.json`) on this computer, each checked by Viva's own save rules: a key written `${VAR}` takes its value from the login shell, or is kept by name as missing; an SSE server, a command that cannot be found, or a variable used in the command, its arguments or the address (where a value would not be encrypted) cannot be imported and says why; a command is saved with the full path the login shell finds; a name Viva cannot use is put right; one Viva has by name goes in as `name-2`, not ticked. Importing only writes Viva's settings (keys encrypted); the client's file is only read (`src/backend/mcp-import.ts`). Codex keeps its settings in TOML, not read yet. It reads existing user configuration without approval/secret prompts and does not modify the source. `dsh-mcp-import.ts` combines each profile's `cordis.yml`, `cordis.patch.yml`, and root patch in dsh order, handling insert, id overrides, and disabled entries.

Literal secrets are copied. Restricted `!!js process.env.X` and environment-based bearer templates resolve from the login-shell environment, app environment, then dsh `.env`. Other JavaScript is never executed. Missing variables do not abort import: the server is marked for secret completion. Case-insensitive duplicate names are skipped and reported. Editing prepopulates nonsecret fields; stored secrets show names only, blanks retain values, and entries can be added/removed. Saving reconnects the session. Chat-based updates require approval and use the same secure form.

<a id="插件"></a>
## Plugins

Capabilities → Plugins manages the dsh plugins users install themselves, which add tools and abilities to the assistant: search, context compaction, vision and more.

- **Install:** enter an npm package name, a git address or a local folder and choose Look up first. Viva shows the package and its version and warns that a plugin runs inside the assistant with your permissions and can read your model keys and memories; nothing is installed until you choose Install. dsh's own plugin manager installs it with the pnpm Viva ships (no Node or pnpm of your own needed) and checks compatibility with dsh's version. If dependencies want to run build scripts, they are listed first and run only after Allow and install.
- **Switch and remove:** switches and removal take effect at once, in new conversations, without a restart, and switches survive a relaunch. Viva's own plugins, persona and safety settings are unaffected by these switches and plugins.
- **Visibility:** each plugin shows its version, description and whether it is on; parts that did not start and stock dsh settings it changes are listed.
- **How it stands in Viva:** Viva runs dsh's ACP composition (`dsh-base` and `dsh-acp-app`), without the browser host of dsh's Web app. So each installed plugin's `package.json` is read (`src/backend/plugin-fit.ts`) for what is known for certain: one that depends on `@deepseek-ai/dsh-host-webserver` or `dsh-web-app` is marked "Doesn't work in Viva" and, while switched on, counts as a problem; one with `dsh.client` (an interface for dsh's Web client) has that part not shown; the rest say "Nothing known against it", not a promise, since a plugin's own patch may still ask for a service Viva lacks. Whether it actually runs is its standing (parts that did not start are listed). `dsh-web` (search and fetch) and `dsh-api-gateway` are in `dsh-base`, so Viva has them. A plugin's author can declare support with `"viva": { "supports": true }` in `package.json`, shown as "Its author says it supports Viva".
- **In conversation:** the model can propose installing a plugin, approved by you on an approval card.

<a id="定时任务"></a>
## Schedules

Say “remind me”, “help me with it then” or “every Friday…”, and Viva asks whether to schedule it: a schedule is a time and a prompt. Nothing is saved until you click Schedule; when it is due, it does the work itself with read-only tools, and the result lands in Activity with a notification. Make, change, pause, and delete them by asking in the conversation.

<img src="images/demo.gif" alt="Chinese UI: mention a weekly report, approve the schedule card, see what is coming up and what came back in Activity, continue in chat">

- **Schedule this?:** the model proposes with `schedule_create` (the `viva-tasks` plugin), writing a self-contained prompt from the conversation (the run cannot see it). A card under the conversation says when and what; Schedule saves it, No thanks lets it go. Times are once, daily, weekly, or cron; the records and due times are dsh's `dsh-schedule` (time zones and DST included), checked again in main, which refuses unclear or past times. A card left unanswered when Viva restarts no longer works; ask again.
- **Changed by asking:** “move it to nine”, “pause it for now”, “I don't need it any more”: the model finds it with `schedule_list` and changes, pauses, resumes, or deletes it with `schedule_update` and `schedule_delete`, without another card. These tools exist in the main conversation only, not in background tasks.
- **Runs read-only when due:** a due prompt runs one turn in a fresh session that the app marks unattended, in the working folder the schedule was made in (whatever folder the window is on by then; a folder gone counts as a failed run). The `viva-permission` plugin then lets it use only look-up tools (reading, searching, web lookup, memory, and past conversations) on workspace files only. Whatever level you picked, writing files, running commands, starting tasks, scheduling, and asking you are refused, and what would ask for approval is refused too, since nobody is there. It is not a background task: it is not on the Background page and nothing is reported into the conversation. A turn may take up to 10 minutes.
- **Once per due time, missed ones made up:** what is due is taken from the schedules and kept as a run in one transaction, so quitting loses nothing and the run goes on at the next launch; one due time makes one result at most. Runs missed while the computer slept or Viva was closed happen once at the next launch (the latest missed, not every one). A failed run is tried again later, three times in all, then becomes an item saying it did not finish. A run not started yet whose schedule was paused or deleted meanwhile does not run. A result is kept with its notification in one transaction, so one not yet shown when Viva quits is shown after the next launch.
- **Activity:** opened from the title bar's Activity button, which counts what is new. The page has New, Coming up, and Seen. Coming up is the schedules, soonest first with the paused last; open one to pause, resume, or delete it. A result opens on her answer (Markdown); Continue in chat puts it in the composer with where it came from, for you to review and send; Not needed moves it to Seen. Nothing here becomes a background task.
- **Today:** the home page's Today card counts what is new in Activity and the schedules still to run today; it is not shown when there are none. Its button opens Activity.
- **Visibility:** each new result sends a system notification that opens Activity; the tray counts what is new (beside the icon on macOS, in the tooltip on Windows), and its menu opens Activity.
- **Launch at login:** optional in Settings, off by default; Viva then starts in the tray without a window. Available only when installed.
- **Local data:** `app.db` keeps the schedules (dsh-schedule records), runs not finished yet, and Activity's items (up to 500), all on this computer. Windows notifications use the installer's AppUserModelID `app.viva.desktop`.

<a id="模型和-key"></a>
## Models and keys

Without a usable model, home shows Connect model and disables the composer. Add a DeepSeek key or another model in Settings to connect. Keys are encrypted with AES-256-GCM under a data key (`data-key.bin` in app data) that safeStorage protects (Keychain on macOS, DPAPI on Windows), and kept in app-data `settings.json` with mode 600 where supported. Unavailable secure storage refuses saving instead of plaintext fallback. Only the backend process holds the key; the UI shows the last four characters. Saving/clearing restarts dsh and starts a new conversation. Saved keys override environment values. A missing dsh installation prompts dependency repair.

### Other models

Add a provider name, protocol, baseURL and API key (optional for local models), then one row per model. Providers appear grouped in the composer menu.

- **Fetch available models** asks the endpoint for its model list with the protocol, address and key filled in (`{baseURL}/models` for OpenAI protocols, `/v1/models` for Anthropic, as dsh does), to search, tick and turn into rows with Add selected; a context window or max output the listing gives is filled in. An endpoint that lists nothing is filled in by hand; a redirect is not followed (the key never goes to another address), so enter the address it points to.
- **Each model** has an ID, a context window, a max output, and Images: ticked, the model can receive pictures (`input: ['text', 'image']` in the profile). A blank context window or max output counts as dsh's 262144 / 32768; max output cannot exceed the context window.

Supported dsh `llm-pi-ai` protocols are OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages. Kimi, Zhipu, Qwen, OpenRouter, Ollama, and LM Studio commonly use OpenAI compatibility.

Viva configures the existing plugin rather than implementing adapters. Provider routes use `custom-xxxxxxxx` ids. Keys are encrypted in `models.json` and supplied to dsh as `VIVA_MODEL_KEY_XXXXXXXX`; profile files contain variable names only. DeepSeek becomes optional; without its key, both DeepSeek plugins are disabled and its menu entries disappear. `lastModel` is restored through ACP provider/model settings on restart and new conversations; missing models fall back to DeepSeek or the first custom provider. Providers can be added, edited and removed; a key left blank while editing keeps the saved one, unless the address moves to another host: the saved key is never sent to a new host (nor by Fetch available models), so it must be entered again. A change restarts dsh and resumes the current session without clearing history; changes are blocked during work.

<a id="助手反问"></a>
## Clarifying questions

When an essential location/time/object/account is missing and memory cannot answer, persona rules require asking instead of guessing from timezone/IP. The built-in `ask_user_question` tool is relayed by `viva-questions` to cards. One single-choice question submits on click; multiple questions/selections require Submit. Free text and Skip are supported. Stopping or switching conversations closes pending questions. Answers enter ordinary memory extraction, so stable information can prevent repeated questions.

<a id="历史对话"></a>
## Conversation history

History lives in `app.db` in app data (on macOS, `~/Library/Application Support/Viva`) and uses Electron's `node:sqlite`. It stores visible questions, answers, receipts, and dsh session identity, not thoughts/tool calls. Writes are incremental at turn start/end/error. Startup opens the latest conversation and tries ACP `session/resume`; failure starts a new session with an explicit lost-context divider.

The title-bar profile icon opens the Review/Background/About you/Settings hub below the title bar, leaving the island accessible. It remembers the last page. Back, Esc, or the icon closes it; ⌘F/Ctrl+F opens search. With no query, Review lists topics by month and day, newest first, with turn counts, files and bookmarks. Filters select all topics, tasks, files or bookmarks. Expand a topic to read or continue it; Earlier loads another page. Main-thread scrolling loads only the recent seven days. Older topics fold to one line, and the turn rail jumps among turns/topics with click or arrow keys. Hover over a message to bookmark it; rewinding removes bookmarks on rewritten messages. The assistant can use search_conversations and read_conversation, linking back with viva://timeline/<segment>/<sequence>.

Search highlights matches with nearby messages; Details navigates and highlights the source. Three or more characters use FTS5 trigram; shorter queries use substring matching.

Conversation menus offer Rename, Pin, Export Markdown, and Delete. Deletion offers Undo for eight seconds, then secure-deletes database content; dsh session logs remain. Old activity is restored from `sessions/…/session.v4.jsonl.zstd`; unavailable logs produce an explanation. Active work prevents conversation switching; switching disables sends.

<a id="记忆"></a>
## Memory

`plugins/memory` owns memory; the app provides UI. Its tables and the `meta.contract_version` it records are the contract; see `plugins/memory/lib/store.ts` and [System design](system-design.md#6-dsh-and-plugins). `dsh-profile.ts` writes the private `profiles/viva` ACP composition with linked plugins and a shared `memory.db`; it does not touch the user's `~/.dsh`. Profile-write failure falls back to ACP without memory. App and plugin share the store contract: app edits profile/memories and habits; plugin stores learned memories, per-session retrieval state, and injection logs.

Retrieval has three layers: fixed rules/profile/preferences/habits at first turn, changes, and compaction; up to three name-matched memories from the user's own words, deduplicated within the session; explicit `memory_recall` keyword lookup when needed. Long pasted material uses the user's opening/closing lines; short follow-ups incorporate the preceding question. Native memory tools do not require approval; sensitive secrets/identity numbers are rejected.

Explicit Remember requests save immediately. After each turn, bounded background extraction adds facts or invalidates candidate memories it was shown, with all-or-nothing validation; it cannot alter user-owned entries. Casual chat is filtered. Profile fields are user-owned. Learned identity/people/projects/preferences become memories and periodically produce a synthesized profile after 24 hours or five changes; invalidations trigger earlier rebuilding. Only active memories are used, and recent additions appear separately. Invalid/sensitive synthesis falls back to the previous result.

Forgetting/replacement invalidates instead of deleting and remains restorable in About you; only explicit UI deletion removes rows. Injection includes today's date, refreshed across midnight, so relative dates can become absolute. Activity shows which memories were included and why; saves notify the user. Failed plugin loading leaves chat functional and is reported in Settings.

<a id="消息里的-markdown"></a>
## Markdown in messages

Assistant answers support headings, emphasis/strikethrough, inline/fenced code with language labels, ordered/unordered/task/nested lists, aligned tables, quotes, rules, and links. User messages remain original text. `marked` lexes; `h()` creates nodes without `innerHTML`. Raw HTML displays literally; remote images become links instead of loading. Internal viva://timeline links open the referenced record; only http(s)/mailto links open externally and main revalidates before opening the external browser/mail app; renderer navigation/new windows are blocked. Streaming parses incomplete code fences and reparses only when visible text changes.

<a id="形象"></a>
## Character

Viva appears as a blue-haired maid (`view/maid.ts`; see [UI guidelines](ui-guidelines.md#her-character)). She waves large on the home page, appears beside only the current turn's answer in the conversation, sits on cards while they wait for your approval or answer, and is the desktop island. The title-bar island shows only a state-colored dot. Her prop follows what the assistant is doing: a pencil while thinking, glasses and a keyboard while writing, a clipboard for approval, a headset for questions, a check card when done, a wrench on errors, an unplugged connector while offline. Reduced-motion settings keep her still. The app icon (`build/icons/`) still shows the cat for now.
