# Measured results

Two machines, the same bundle. Numbers below are measured, not estimated; the
command or log line that produced each one is named next to it.

## Machines

| | "Zero" (test box) | AWS dev box |
|---|---|---|
| CPU/RAM | 2 GB VM | t3-class, 1.9 GB |
| DSH | 0.2.2-rc.5 | 0.2.2-rc.3 |
| Node | v24.22.2 | v24.22.3 |
| trigger | clicking the session in the Web UI | same |

## Per-session migration

| session | events | before | after | ratio | migration time |
|---|---:|---:|---:|---:|---:|
| CloudDSH (`ed3795be`) | 100,243 | 68.6 MB | 90 KB | 0.13% | 10.4 s |
| GrandElf (`7e2d88df`) | 32,645 | 23.2 MB | 95 KB | 0.41% | 3.5 s |
| 值班大管家 (`a9fd5845`) | 43,576 | 21.9 MB | 56 KB → 131 KB\* | 0.6% | 9.3 s |
| self-evolution (`95a8d6d1`) | 25,419 | 20.7 MB | 178 KB | 0.86% | 5.1 s |

\* the scheduled task ran one turn in that session a minute later, which is the
point: a slimmed session keeps working. The log line at migration time said 56 KB.

Four sessions: **134.4 MB → 419 KB (99.69%)**.

### Second batch (same box, one sitting)

| session | before | after | turns | messages | migration time |
|---|---:|---:|---:|---:|---:|
| `b4081bf5` | 10.3 MB | 326 KB | 310 | 600 | 2,051 ms |
| `a8e1bac3` | 14.1 MB | 169 KB | 80 | 225 | 2,674 ms |
| `8e986917` | 8.9 MB | 126 KB | 65 | 85 | 2,375 ms |
| `96cd56a0` | 6.5 MB | 90 KB | 22 | 26 | 1,337 ms |
| `7ac0987c` | 18.2 MB | 131 KB | 42 | 167 | 3,386 ms |

Nine sessions in total so far. The box now stores **34.1 MB of v4 logs** (down from
204.5 MB at install) plus **192.3 MB of archives**, one session ≥5 MB still
pending (`626b4c52`, 13.0 MB). Disk sits at 69% (39 GB used of 58 GB) — the
archives are the price of a one-command rollback.

With nine sessions opened, the service holds **862 MB** (`memory.current`), and
the cgroup peak has not moved past the 1,400 MB it reached during the first burst
of four opens.

## Time is spent on events, not megabytes

21.9 MB / 43.6k events took 9.3 s while 68.6 MB / 100k events took 10.4 s, and
23.2 MB / 32.6k events took 3.5 s. The three migrations were started within 15
seconds of each other (`journalctl`), so the outliers are CPU contention between
migration children, not input size. v0.1.2 serializes migrations
(`maxConcurrent`, default 1) for exactly this reason.

Single-migration breakdown on the 69 MB session (`--dry-run`, one child process):

| stage | time |
|---|---:|
| analyze (two streaming passes over 305 MB of JSON) | 6,011 ms |
| write the 82 KB log through the official writer | 83 ms |
| official read-back (`open → read → prepare`) | 16 ms |
| archive + atomic replace | 496 ms |
| **total** | **≈ 6.6 s** |

Child peak RSS: **157 MB**. The service process itself does not grow.

## Memory

Two different instruments, both correct:

| metric | before | after |
|---|---:|---:|
| process RSS (harness.service, node process) | ~1,200 MB | **513.6 MB** |
| process swap | ~870 MB | **2.1 MB** |
| RSS + swap | ~2,070 MB | **515.7 MB** (−75%) |
| cgroup `memory.current` (process + page cache) | 391 MB idle after restart | 712 MB with 4 sessions open |
| cgroup peak during the burst of opens | — | 1,400 MB |

`memory.current` includes page cache, so it reads higher than RSS; process peak
(HWM) never refreshed its old 1,490 MB mark, and the box's `available` went from
55–118 MB to 976 MB.

Loaded sessions cost about **80 MB each** after slimming (`712 − 391 MB` over four
sessions). Ten of them fit in a 2 GB box; the same ten before this change did not.

## Functional checks after slimming

- **Scheduled task ran normally** in a freshly slimmed session: 06:00:09Z the
  scheduler opened the 值班 session, the plugin migrated it (21.9 MB → 56 KB,
  9.3 s), and at 06:00:51Z that turn completed and wrote its dispatch log — with
  the correct note that the 05:54 restart was not caused by the janitor run.
- **Official resume path** (`open → read(0) → sessions.prepare`) passes for every
  migrated session; the human-visible message SHA is compared with the original
  before the swap, and re-checked afterwards.
- **Archive search** finds pre-slim content: a 43,575-event archive answered a
  keyword query for a message from 10-01.
- **Zero WARN/ERROR** from the plugin after the dependency fix (v0.1.1).

## What is *not* covered

- Six sessions ≥5 MB were still pending at the time of writing; they are migrated
  the first time they are opened, not in the background.
- One workspace's session was reported as "CAU" but its v4 file had not been
  opened since 11-15, so nothing was migrated — the plugin acts on open only.
- Legacy `session.v3.jsonl.zstd` files stay on disk (~120 MB on the AWS box).
  They are never read once a v4 log exists; the plugin does not delete them.
- v4 only; seeded (fork/subagent) sessions are refused.
