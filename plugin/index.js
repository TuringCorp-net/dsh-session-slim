/**
 * dsh-session-slim — Host plugin.
 *
 * Wraps `sessionPersistence.open()` and, before a session is read for resume,
 * materializes the *official* current surface on disk: the visible conversation
 * stays, tool traffic / reasoning / replay streams and the already-folded
 * history go away, and the previous log is archived next to it.
 *
 * Nothing here decides what history to keep: DSH's own compaction does that.
 * The plugin only turns "what is visible right now" into the stored log, so the
 * next open is cheap. It runs only when the stored log is above `minBytes` and
 * no live writer owns the session, and it is idempotent.
 *
 * @module @local/dsh-session-slim
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { findSessionDir, isSessionLocked } from '../src/slim.mjs'

const execFileAsync = promisify(execFile)

/**
 * The child process has none of the host's profile module routing, so hand it
 * absolute file URLs for every harness package it needs.
 */
function resolution() {
  const env = {}
  const entries = {
    DSH_SLIM_CORDIS: '@deepseek-ai/cordis',
    DSH_SLIM_SESSION: '@deepseek-ai/dsh-session',
    DSH_SLIM_PERSISTENCE: '@deepseek-ai/dsh-session-persistence-jsonl',
    DSH_SLIM_FLOCK: '@deepseek-ai/node-addon-system/flock',
  }
  // A profile install may not expose the packages to import.meta.resolve; the
  // running DSH binary always sits next to them, so try its tree as well.
  const bases = [process.argv[1], new URL(import.meta.url).pathname].filter(Boolean)
  for (const [key, specifier] of Object.entries(entries)) {
    try { env[key] = import.meta.resolve(specifier) } catch { /* try the binary tree below */ }
    if (env[key] === undefined) {
      for (const base of bases) {
        try {
          const url = createRequire(base).resolve(specifier)
          env[key] = url.startsWith('file:') ? url : `file://${url}`
          break
        } catch { /* next base */ }
      }
    }
  }
  env.DSH_SLIM_BASE = process.argv[1] ?? new URL(import.meta.url).pathname
  return env
}
const CLI = fileURLToPath(new URL('../bin/slim.mjs', import.meta.url))

export const name = 'session-slim'
export const inject = ['sessionPersistence']
export const Config = null

const DEFAULTS = {
  enabled: true,
  /** Skip logs smaller than this; the check itself costs one stat. */
  minBytes: 5 * 1024 * 1024,
  /** Keep this many pre-slim originals per session. */
  keepArchives: 5,
  /** Log every decision; set false to stay quiet. */
  verbose: true,
  /** Hard cap for one migration; the child process is killed past it. */
  timeoutMs: 10 * 60 * 1000,
}

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...config }
  if (!opts.enabled) {
    ctx.logger?.info?.('session-slim: disabled by config')
    return
  }
  const resolved = resolution()
  console.log(`[SESSION-SLIM] mounted (minBytes=${opts.minBytes}, keepArchives=${opts.keepArchives}, resolved=${Object.keys(resolved).length}/4)`)
  ctx.logger?.info?.(`session-slim: mounted (minBytes=${opts.minBytes}, keepArchives=${opts.keepArchives})`)
  const service = ctx.sessionPersistence
  if (service === undefined || typeof service.open !== 'function') {
    ctx.logger?.warn?.('session-slim: no sessionPersistence service; plugin inactive')
    return
  }
  if (service.__sessionSlimWrapped === true) return

  const root = opts.root ?? service.root ?? (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'sessions') : undefined)
  if (root === undefined) {
    ctx.logger?.warn?.('session-slim: cannot locate the sessions root; plugin inactive')
    return
  }

  const original = service.open
  const busy = new Set()

  async function maybeSlim(sessionId) {
    if (busy.has(sessionId)) return
    const dir = findSessionDir(root, sessionId)
    if (dir === null) return
    let size
    try { size = statSync(path.join(dir, 'session.v4.jsonl.zstd')).size } catch { return }
    if (size < opts.minBytes) return
    if (await isSessionLocked(dir)) {
      if (opts.verbose) ctx.logger?.info?.(`session-slim: "${sessionId}" is owned by a live writer, leaving it alone`)
      return
    }
    busy.add(sessionId)
    const started = Date.now()
    try {
      // Run the migration in a child process: a second Cordis store inside the
      // live server would be needless risk, and a runaway migration must not
      // take the service down with it.
      const { stdout } = await execFileAsync(process.execPath, [
        CLI, 'slim', dir, '--replace', '--force', '--json',
        '--keep-archives', String(opts.keepArchives),
      ], { timeout: opts.timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, ...resolution() } })
      const result = JSON.parse(stdout.trim().split('\n').pop())
      if (result.skipped) {
        if (opts.verbose) ctx.logger?.info?.(`session-slim: "${sessionId}" skipped (${result.reason})`)
        return
      }
      const line = `session-slim: "${sessionId}" ${(result.beforeBytes / 1048576).toFixed(1)} MB -> ${(result.afterBytes / 1024).toFixed(0)} KB, `
        + `${result.turns} turns, ${result.humanMessages} messages, ${Date.now() - started} ms`
      // console.log, not only ctx.logger: info-level records are filtered out of the service journal.
      console.log(`[SESSION-SLIM] ${line}`)
      ctx.logger?.info?.(line)
    } catch (error) {
      ctx.logger?.warn?.(`session-slim: "${sessionId}" not slimmed: ${String(error?.message ?? error)}`)
    } finally {
      busy.delete(sessionId)
    }
  }

  const wrapped = async function (id, access, options) {
    // Never let slimming break a resume: any failure falls through to the real open.
    try { await maybeSlim(id) } catch (error) {
      ctx.logger?.warn?.(`session-slim: pre-open check failed for "${id}": ${String(error?.message ?? error)}`)
    }
    return original.call(this, id, access, options)
  }
  service.open = wrapped
  Object.defineProperty(service, '__sessionSlimWrapped', { value: true, enumerable: false })

  ctx.effect(() => () => {
    if (service.open === wrapped) delete service.open
    try { delete service.__sessionSlimWrapped } catch { /* frozen */ }
  }, 'session-slim: restore sessionPersistence.open')
}
