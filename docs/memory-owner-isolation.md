# Memory owner isolation

[中文](memory-owner-isolation.zh-CN.md)

Viva and standalone DSH run memory in a supervised worker. The worker owns SQLite, managed Markdown files, and their search indexes. Viva retains chat history, task state, reports, and schedules in its own database. Conversation and task execution can start while memory is still connecting or unavailable. [Owner worker](../src/memory/node/owner-worker.ts) · [Viva composition](../src/backend/compose.ts)

## Intake and retrieval

The adapter scans durable session events from the saved cursor. A new database starts at its creation time. The worker advances the cursor with each recorded turn outcome, and message IDs stabilize receipts for interrupted scans. Viva registers an alias for each original it can verify. The alias identifies the original text within the text sent to DSH. If the alias is unavailable, the conversation can still proceed and the message contributes no original evidence. Standalone DSH can ingest its own plain user messages. Tool output, automatic context, unattended inputs, and background reports stay outside original evidence. [Adapter](../plugins/memory/lib/adapter.ts) · [Session intake](../plugins/memory/lib/ingestion.ts)

Verified projects read personal and project memory and write to the project. Personal sessions read and write personal memory. When a workspace cannot be identified, it can query personal memory and intake skips its messages. Automatic context has a short deadline and excludes daily notes written by the current session. Explicit memory tools use a separate request budget and return an unavailable result when the owner cannot answer. [Project identity](../src/memory/node/project-scope.ts) · [Document read policy](../src/memory/core/memory-document-read-policy.ts)

## File operations

Daily and digest files have one enabled flag and a usage version. Disabling a file excludes it from model retrieval and Dream while keeping its content available in About You. Dream validates content and usage versions at commit, so disabling and re-enabling invalidates computations started before the change. Deleting a memory file removes that file and its index entries. Conversation deletion and rewind edit only local history. [Note store](../src/memory/node/memory-note-store.ts) · [Dream jobs](../src/memory/core/memory-dream-jobs.ts) · [Timeline rewind](../src/backend/rewind-ipc.ts)

## Storage and restart

The supervisor waits for the old worker to exit before starting a replacement. The replacement opens the memory root under its exclusive lock and restores durable memory state. Management reads are routed directly to the owner and have bounded concurrency. DSH continues to own its session persistence. [Supervisor](../src/memory/node/owner-supervisor.ts) · [Root lock](../src/memory/node/owner-lock.ts) · [Management channel](../src/backend/remote-memory-channel.ts)

The memory contract and database schema are v12. A clean root gets a new database. An incompatible database stays on disk and memory remains unavailable. Viva's user clears the old data directory when moving to a clean v12 setup. Standalone DSH's existing files stay in their own data directory. [Version check](../src/memory/node/memory-store.ts)
