# Build a source

[English](sources.md) · [简体中文](sources.zh-CN.md)

Sources deliver new email, alerts, or messages to Viva. A source is a folder containing `viva-source.json` and a program in any language. Viva starts it periodically, asks what arrived since the previous cursor, and the program exits after answering. For installation from the UI, see [Features](features.md#消息源).

## Quick start

```bash
npx viva-source new my-alerts                  # JS; use --template python or command for alternatives
cd my-alerts && npm install                   # Not needed for Python
# Edit viva-source.json and the TODOs in the program
npx viva-source test . --set token=xxx
```

After validation, choose the folder in Settings → Sources → Install source, configure it, and enable it.

> Until `viva-source-kit` is published to npm, run `node scripts/build-source-kit.mjs` in this repository, then use `node packages/viva-source-kit/bin/viva-source.js` instead. CLI output defaults to English; pass `--language zh-CN` for Chinese.

## viva-source.json

```jsonc
{
  "contract": 1,                          // Current protocol version
  "id": "acme-alerts",                    // Lowercase letters, digits, hyphens; at most 40 characters
  "name": "Acme alerts",                  // Display name
  "kind": "alert",                        // mail | alert | chat | other
  "run": ["node", "index.mjs"],           // Paths relative to this folder
  "runOn": { "win32": ["py", "-3", "main.py"] }, // Optional platform override: win32/darwin/linux
  "reads": "Alert names, severity, and time", // Describe accurately; shown at install and in settings
  "everyMinutes": 5,                      // Default interval, 1–1440; users can change it
  "config": {
    "endpoint": { "type": "string", "title": "Address", "required": true },
    "token": { "type": "secret", "title": "Access token", "help": "Generate in Acme personal settings" },
    "minLevel": { "type": "enum", "title": "Minimum severity", "values": ["P0", "P1", "P2"], "default": "P1" },
    "limit": { "type": "number", "title": "Maximum per fetch", "default": 50 },
    "unread": { "type": "boolean", "title": "Unread only", "default": true }
  }
}
```

Configuration keys use English letters, digits, and underscores, with at most 20 fields. Secrets are encrypted using the system keychain, passed only to the source when called, and never displayed in the page. A source cannot be enabled while required fields are missing.

## Protocol

Each action starts a new program invocation:

- **Request:** read one JSON line from stdin: `{ "contract": 1, "action": "poll", "config": { … }, "cursor": "…" }`.
- **Response:** write JSON on stdout. Viva takes the last parseable JSON line; earlier lines may contain logs.
- **Failure:** exit nonzero. The last stderr lines become the reason shown in settings. Use helpful wording such as “Token expired; generate another.”

| Action | Input | Response |
|---|---|---|
| `check` | `config` | `{ "ok": true }` or `{ "ok": false, "problem": "Invalid token" }` |
| `poll` | `config`, `cursor` (`null` initially) | `{ "cursor": "…", "messages": [ … ] }` |

### Messages

| Field | Required | Meaning |
|---|---|---|
| `id` | Yes | Stable and unique within this source; used for deduplication |
| `at` | Yes | Millisecond timestamp or ISO time, e.g. `2026-10-25T09:00:00Z` |
| `title` / `text` | At least one | Title up to 300 characters; body up to 8,000 |
| `from` | No | Sender or alert origin |
| `link` | No | Only http, https, or mailto |
| `level` | No | For example P1 |
| `thread` | No | Conversation or alert identifier |

Return at most 200 messages per call. Malformed individual messages are discarded with a reason in settings; valid messages are still accepted.

### Cursor

`cursor` is your own string, up to 4,000 characters: a timestamp, page number, or last ID. Viva stores it unchanged and sends it back next time. Messages and the new cursor are saved together. Failed calls retain the previous cursor, so duplicate messages are safe; Viva deduplicates by `id`. Returning `null` is allowed but starts every fetch from the beginning.

## Runtime

- **Launch:** when `run[0]` is `node`, Viva uses its bundled runtime; users need not install Node. Other executables are resolved through PATH. Use `runOn` for platform differences such as `python3` versus `py -3`; the checker warns about them.
- **Windows `.cmd`:** npm CLI shims run through `cmd.exe`. Arguments must be simple words containing letters, digits, or `./\:=@+,-`. Configuration belongs on stdin, not in arguments.
- **Environment:** only basic system entries (PATH, home, language, temp directory, plus SystemRoot, ComSpec, PATHEXT on Windows) and `VIVA_SOURCE_DATA` / `VIVA_SOURCE_CONTRACT` are passed. Other user environment variables, including model keys, are withheld. The data directory can hold refreshed tokens or caches and is removed with the source.
- **Limits:** 60 seconds per run and at most 1 MB output. Timeout terminates the program and its child processes.
- **Retries:** preserve the cursor and back off by 1, 5, 15, and 60 minutes, never more frequently than the user’s interval.
- **Encoding:** UTF-8 on stdin/stdout. On Windows, follow the Python template’s `sys.stdout.reconfigure(encoding="utf-8")`.

## viva-source-kit

```js
import { defineSource, dataDir } from 'viva-source-kit'

defineSource({
  async check(config) {
    return config.token ? true : 'Enter an access token' // true, a message, or { ok, problem }
  },
  async poll(config, cursor) {
    const items = await fetchSince(config, cursor) // Your system
    return { cursor: items.at(-1)?.time ?? cursor, messages: items.map(toMessage) }
  },
})
```

Errors thrown by `poll` are written to stderr and exit with code 1; settings displays the reason.

## Existing command-line tools

For a CLI that already outputs JSON, use the `command` template. It runs the configured command, converts items through `toMessage`, uses the newest timestamp as cursor, and returns later items. Adapt `toMessage`; if the CLI supports time filters, pass the cursor to avoid unnecessary work.

## Validation

```bash
npx viva-source test <folder> [--language en|zh-CN] [--config config.json] [--set NAME=VALUE]...
```

The app’s own validation checks the manifest, configuration, platform launch, one `check`, an initial `poll`, and another `poll` using the returned cursor. Each failure (✖) or warning (⚠) explains the problem, including stationary cursors, second/millisecond confusion, or missing Windows overrides. All ✔, or warnings only, means the source can be installed.

## Safety

Sources run with the user’s OS permissions; Viva cannot prevent them reading files or using the network. Users are warned to install trusted sources. Viva validates returned content before saving it in `sources.db` and treats it only as data. Sources do not receive the assistant’s model, tools, or context, other secrets/environment variables, or another source’s configuration. Read only what `reads` declares, and store tokens only in `VIVA_SOURCE_DATA`.
