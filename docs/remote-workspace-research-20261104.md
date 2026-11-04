# Long-term research: the workspace as a replaceable execution world (2026-11-04)

English | [简体中文](remote-workspace-research-20261104.zh-CN.md)

> Status: **long-term planning, not scheduled.** This records the findings of one validation, for when the backend moves to the cloud after the frontend/backend split. The current architecture refactor does not depend on it.

## 1. Question

The backend may later move to the cloud, but Viva is a desktop agent: reading and writing files, running bash and starting the user's MCP servers all assume the user's computer. The idea is to make the workspace a replaceable backend: this machine, a cloud container, or the user's computer reached from a cloud backend through a local node.

## 2. What dsh already provides

dsh 0.2.0-rc.2 abstracts three layers per "execution world". Each has a local implementation and can be replaced row by row in the profile:

| Seam | Service | Row in dsh-base | Local implementation |
|---|---|---|---|
| `FileSystem` in `dsh-fs` | `ctx.fs` | `fs-sandbox` | `dsh-fs-local` / `dsh-fs-sandbox` |
| `SubprocessRuntime` in `dsh-subprocess` | `ctx.subprocess` | `subprocess` | `dsh-subprocess-local` |
| `ShellExecutor` in `dsh-shell` | `ctx.shell` | `bash-sandbox` | `dsh-bash-local` / `dsh-bash-sandbox` (starts processes through `ctx.subprocess`) |

Files and processes must live in the same execution world: bash has to see the file the model just wrote. So what gets replaced is the execution world, not just the filesystem.

## 3. Method

- A separate process plays the remote workspace: the real files sit in a temporary directory and are exposed only as the virtual path `/ws`. The host has no `/ws`, so any dsh code that reads or writes workspace files directly on the host fails.
- Two plugins replace the `fs-sandbox` and `subprocess` rows. File operations are forwarded one by one; processes follow the `ssh host cmd` pattern, where dsh manages a local relay process and the command runs remotely.
- Real dsh, all of Viva's plugins, and a fake model that calls tools from a script; the session's cwd is `/ws`.

## 4. Findings

**What works**

- Replacing two profile rows is enough; neither dsh nor Viva code changes. Viva's plugins load as usual (the 44 tools offered to the model include `memory_*` and `viva_*`).
- `session/new` accepts a cwd that does not exist on the host.
- read (absolute and relative paths), write, edit, bash, grep and glob all work; only the remote files change and the host working directory is left untouched.

**What must be solved first**

| # | Issue | Observed | Possible directions |
|---|---|---|---|
| 1 | stdio MCP bypasses `ctx.subprocess` | `dsh-mcp-client` uses `StdioClientTransport` directly with the session's cwd. With cwd `/ws` the whole `session/new` fails (`mcp-client(probe): initial connection or tool synchronization failed`); the control with a host directory succeeds | Allow only HTTP MCP servers in remote mode; or run MCP on the backend machine with its own cwd; or ask dsh upstream to route stdio transports through `ctx.subprocess` |
| 2 | ripgrep is a host binary | grep and glob hand the host path `node_modules/@vscode/ripgrep-<platform>/bin/rg` to the remote side; this only worked because both sides share one machine | Ship rg in the remote world with a path mapping or config override; required when platforms differ (for example a Linux container) |
| 3 | User-level instructions and skills go through `ctx.fs` | `AGENTS.md`, `skills/` and `agents/skills/` under dsh-home are looked up remotely | Sync them into the workspace, or use a composite filesystem that routes by path; also confirm where Viva's `viva_skill_*` installs skills |

**Implementing the remote subprocess**: `spec.stdio` must be passed through faithfully. During the validation stdin was always a pipe; with no path argument and stdin a pipe, ripgrep reads stdin, so grep silently reported no matches. Details like this belong in a conformance suite that runs the same tests against the local and remote implementations.

## 5. Not covered

- Sandboxing: the validation ran with `danger-full-access`. `dsh-bash-sandbox` wraps commands with the host sandbox; a remote workspace should provide its own isolation (for example a container).
- Terminals and persistent bash (`spawnTerminal`), file watching (`watch`), `read_image` (`readBytes`).
- Two real machines: this run simulated the remote world with path mapping, so bash's `pwd` still shows the real directory.
- Viva's own modules that use `node:fs` directly: `src/backend/workspace-files.ts`, `files-ipc.ts`, `file-watch.ts`, `island-files.ts`, `image-store.ts`, `work-dir.ts`. The files panel could move to dsh's `dsh-api-workspace-files`, which is built on `ctx.fs`.

## 6. Constraints for the current refactor

Follow these two rules during the frontend/backend split, so a remote workspace does not need another split later:

- The frontend and backend exchange content or blob ids, never local paths.
- Local capabilities (files, working directory, MCP) form their own group in the backend interface, separate from sessions, memory and follow-ups.

## 7. Reproducing

The validation code is kept locally and is not in the repository (`spike/remote-workspace/`). Run `DSH_NODE=node node spike/remote-workspace/run.mjs`; add `SPIKE_MCP=1` to reproduce issue 1, with `SPIKE_SESSION_CWD=host` as its control. Re-validate these findings after a dsh upgrade.
