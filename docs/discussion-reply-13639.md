**Update: this is fixed by a community plugin — `dsh-session-slim`.**

Repo: https://github.com/TuringCorp-net/dsh-session-slim · npm: `dsh-session-slim`

```bash
dsh plugin --profile web add dsh-session-slim   # or: github:TuringCorp-net/dsh-session-slim
```

**What it does.** On `sessionPersistence.open()` — before the resume path reads the log — it materializes the *current official surface* as the stored session and moves the raw log to `<sessionDir>/archive/`. The resume then reads the small file through the normal path; nothing upstream is patched.

It deliberately has no retention policy of its own: **when history is folded and what is folded is entirely DSH's compaction** (manual, or automatic at the context threshold). The plugin only writes "what is visible right now" to disk, once per open, and only when the stored log is above `minBytes` (default 5 MB).

**Measured on the 68.6 MB / 100k-event session from the report:**

| | before | after |
|---|---|---|
| stored log | 68.6 MB | 90 KB (282 events) |
| resume RSS (official `open → read(0) → prepare`) | 1,173 MB | 82 MB |
| human-visible messages | 87 | 87, transcript SHA unchanged |

One-time migration cost: 6.0 s analysis + 0.08 s write + 0.02 s read-back verify + 0.5 s archive/atomic replace ≈ 6.6 s in a **child process** (peak ~157 MB), so the service process itself does not grow. After that every open costs one `stat`.

On the 1.9 GiB box from the report: four sessions migrated in one sitting (134.4 MB → 419 KB), service RSS 1,200 MB → **513.6 MB**, swap 870 MB → **2.1 MB**; with nine sessions open the cgroup stays at 750–860 MB. The scheduled-task session was migrated at 06:00:09Z and its run completed normally at 06:00:51Z — a slimmed session keeps working, it is an ordinary session.

**Safety:** the original is copied to `archive/` before an atomic `rename` (one-command rollback); a live POSIX write lease makes it skip any session another process owns; the transcript is verified against the original through the official resume path before the swap; an existing archive makes the next run a no-op. Seeded (fork/subagent) sessions and non-v4 logs are refused.

**Prerequisites:** Node ≥ 22, `pnpm` (the plugin manager forwards to it), `zstd` CLI, DSH 0.2.2-rc.x. Requires `sessionPersistence.open` + `sessions.prepare`.

**Not claimed:** this is a workaround, not a structural fix — the log is rewritten once per session per growth cycle rather than read lazily, and the architecture-level answer (a config-level bound, or lazy windows in the persistence layer) is still what this report asks for. Happy to have the approach adopted upstream in any form.
