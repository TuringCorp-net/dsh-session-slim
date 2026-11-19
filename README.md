# dsh-session-slim

[![npm](https://img.shields.io/npm/v/dsh-session-slim)](https://www.npmjs.com/package/dsh-session-slim)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](./package.json)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0b7285)](https://github.com/topics/dsh-plugin)

Open a long DSH session **without loading its whole event log**.

DeepSeek Harness stores every session as an append-only event log. Resuming one reads *all* of it into memory: a 69 MB / 100k-event session costs **~1.1 GB RSS and 3.5 s** on resume — enough to push a 2 GB VM into swap as soon as you open a second or third conversation. Most of that log is never shown again: tool traffic, reasoning traces, per-delta replay streams, and history that compaction already folded away.

This bundle rewrites a session **at the moment it is opened**: it keeps the conversation DSH currently shows (the official surface), archives the raw log next to it, and lets the normal resume path read the small file instead.

```
71,900,286 B  ->  82,697 B        (100,199 -> 282 events)
1,173 MB RSS  ->  82 MB RSS       (same official resume path)
80 human messages: byte-identical    (SHA unchanged)
```

## What it does *not* do

It has no retention policy of its own. **When history is folded and what is folded is entirely DSH's compaction** (manual, or automatic at the context threshold). The plugin only materializes "whatever is visible right now" onto disk, once per open, and only when the stored log is above `minBytes`.


## Prerequisites

Checked before you install — missing pieces fail at install or first open:

| need | why | check |
|---|---|---|
| Node.js ≥ 22 | the plugin and its child process | `node -v` |
| **pnpm** | `dsh plugin add` forwards to pnpm in the profile directory | `pnpm -v` (missing: `corepack enable pnpm`) |
| **`zstd` CLI** | the child decompresses the session log with it | `zstd --version` (missing: `apt install zstd`) |
| `git` | only for `github:` / git specs | `git --version` |
| DSH 0.2.2-rc.x | `sessionPersistence.open` + `sessions.prepare` | `dsh --version` |

Installing needs network access to the package source (GitHub or npm). If `github:` installs hang, your host blocks `github.com`; use the tarball URL instead:

```bash
dsh plugin --profile web add https://codeload.github.com/TuringCorp-net/dsh-session-slim/tar.gz/refs/tags/latest
```

The bundle resolves the harness packages it needs from the running DSH installation; no symlinks or extra dependencies in the profile are required (v0.1.1).

## Install

```bash
# npm package
dsh plugin --profile web add dsh-session-slim
# git
dsh plugin --profile web add github:TuringCorp-net/dsh-session-slim
# or a local tarball / directory
dsh plugin --profile web add ./dsh-session-slim-0.1.3.tgz
```

Then restart the service. The bundle ships its own `dsh.bundle.patch`; no profile editing is needed.

Config (override in your profile patch under `id: session-slim`):

```yaml
- id: session-slim
  config:
    enabled: true
    minBytes: 5242880   # below this the plugin only stats the file and stays out of the way
    keepArchives: 5     # pre-slim originals kept per session
    verbose: true
```

## How it stays safe

- **Live writers win.** Before touching anything it tries the session's own POSIX write lease. If a DSH process holds it (the conversation is open), the plugin does nothing and that open behaves exactly as before.
- **Verified before install.** The transcript is written through the official writer to a scratch directory and read back through the official resume path (`open -> read(0) -> sessions.prepare`); the human-visible message hash must match the original. Otherwise nothing is replaced.
- **Atomic, idempotent, reversible.** The original is copied into `<sessionDir>/archive/`, the new log is staged and `rename`d into place. An existing archive makes the next run a no-op; failures leave the original untouched.
- **Out of process.** The migration runs in a child process (peak ~157 MB), so a slow or failing migration can never take the service down with it.

## Cost

Measured on a 69 MB / 100k-event session:

| stage | time |
|---|---|
| analyze (two streaming passes over 305 MB of JSON) | 6,011 ms |
| write the 82 KB log through the official writer | 83 ms |
| official read-back verification | 16 ms |
| archive + atomic replace | 496 ms |
| **total, one time** | **≈ 6.6 s** |

Afterwards every open costs one `stat`. Sessions between `minBytes` and a few MB take well under a second; a session that grows past the threshold again is slimmed again on its next open.

## It keeps working after the swap

A slimmed session is an ordinary session: the next turn appends to the new log
through the same official path. On the AWS box a scheduled task opened the
janitor session at 06:00:09Z, the plugin migrated it (21.9 MB → 56 KB, 9.3 s),
and that same run finished its work at 06:00:51Z and wrote its dispatch log.

## What is lost

Tool calls, tool results, reasoning traces, replay streams, and events that compaction had already folded out of the visible conversation are not part of the new log. The full original stays in `archive/`; `bin/slim.mjs search` can query it by keyword or time range.

## CLI

```bash
node bin/slim.mjs status <sessionsRoot> [--min BYTES]   # what would be slimmed
node bin/slim.mjs info   <sessionDir>
node bin/slim.mjs slim   <sessionDir> --dry-run         # report only
node bin/slim.mjs slim   <sessionDir> --replace         # archive + install
node bin/slim.mjs verify <sessionsRoot> <sessionId>     # official resume path
node bin/slim.mjs search <archive> --query "..." [--from ISO] [--to ISO]
```

## Limits

- v4 logs only; pure v3 sessions must be migrated by DSH first.
- Seeded sessions (fork/subagent) are refused.
- Turn numbering is rebuilt from the messages, so it will not match the original log.

MIT.
