# dsh-session-slim

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

## Install

```bash
dsh plugin --profile web add github:TuringCorp-net/dsh-session-slim
# or a local tarball / directory
dsh plugin --profile web add ./dsh-session-slim-0.1.0.tgz
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
