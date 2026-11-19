/**
 * Build, verify, archive and install transcript session logs.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, openSync, fsyncSync, closeSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { readSurface, readEvents, groupTurns, buildTranscript, messageText } from './transcript.mjs'

/**
 * Module specifiers for the harness packages. Inside an installed bundle these
 * are absolute file URLs resolved by the host (the profile's loader knows where
 * the runtime lives); from a checkout they are the plain package names.
 */
const SPEC = {
  cordis: () => process.env.DSH_SLIM_CORDIS ?? '@deepseek-ai/cordis',
  session: () => process.env.DSH_SLIM_SESSION ?? '@deepseek-ai/dsh-session',
  persistence: () => process.env.DSH_SLIM_PERSISTENCE ?? '@deepseek-ai/dsh-session-persistence-jsonl',
  flock: () => process.env.DSH_SLIM_FLOCK ?? '@deepseek-ai/node-addon-system/flock',
}

const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

async function runtime(root) {
  const { Context } = await import(SPEC.cordis())
  const ctx = new Context()
  const smod = await import(SPEC.session())
  await ctx.plugin({ name: 'sessions', apply: smod.SessionStore })
  const pmod = await import(SPEC.persistence())
  await ctx.plugin({ name: 'persistence', apply: c => pmod.apply(c, { root, compression: 'zstd' }) })
  return { ctx, mod: pmod }
}

/** Replay the real resume path (open -> read(0) -> sessions.prepare) against a stored session. */
export async function verifySession(sessionsRoot, id) {
  const { ctx } = await runtime(sessionsRoot)
  const handle = await ctx.get('sessionPersistence').open(id, 'read')
  const cold = await handle.read(0, undefined, {})
  const session = ctx.sessions.prepare(id, {
    seed: cold.events,
    meta: structuredClone(handle.header),
    inheritedEventCount: handle.inheritedEventCount,
    eventState: cold.eventState,
  })
  const messages = session.deriveMessages()
  const human = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role}: ${(m.content ?? []).filter(p => p?.type === 'text').map(p => p.text.trim()).filter(Boolean).join(' ')}`)
    .filter(line => line.slice(line.indexOf(': ') + 2).length > 0)
  const hash = createHash('sha256').update(human.join('\n')).digest('hex').slice(0, 16)
  await handle.close()
  await ctx.scope?.dispose?.()
  return { events: cold.events.length, messages: messages.length, humanMessages: human.length, humanChars: human.join('\n').length, humanHash: hash, header: handle.header }
}

/** Hash the human-visible lines of already-grouped turns. */
function transcriptHash(groups) {
  const lines = []
  for (const g of groups) for (const ev of g.events) {
    if (ev.type === 'system/message') continue
    const role = ev.type === 'user/message' ? 'user' : 'assistant'
    const text = messageText(ev)
    if (text) lines.push(`${role}: ${text}`)
  }
  return { lines, hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16) }
}

/** Compute the human-visible transcript of an existing log (for equality checks). */
export async function transcriptOf(srcPath) {
  const { nodes } = await readSurface(srcPath)
  const bySeq = await readEvents(srcPath, nodes.map(n => n.seq))
  const groups = groupTurns(nodes, bySeq)
  const lines = []
  for (const g of groups) for (const ev of g.events) {
    const role = ev.type === 'user/message' ? 'user' : ev.type === 'assistant/message' ? 'assistant' : 'system'
    if (role === 'system') continue
    const text = messageText(ev)
    if (text) lines.push(`${role}: ${text}`)
  }
  return { lines, hash: createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16), groups: groups.length }
}

/**
 * Write a transcript log into a scratch root through official persistence.
 * @returns absolute path of the produced log file
 */
export async function writeTranscript({ header, events, root }) {
  const { ctx } = await runtime(root)
  const clean = { ...header }
  delete clean.type
  const handle = await ctx.get('sessionPersistence').create(clean)
  await handle.append(events, {})
  await handle.flush()
  await handle.close()
  await ctx.scope?.dispose?.()
  const found = findLog(root, clean.id)
  if (!found) throw new Error('transcript write produced no log file')
  return found
}

function findLog(dir, id) {
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const name of readdirSync(cur)) {
      const p = path.join(cur, name)
      const st = statSync(p)
      if (st.isDirectory()) stack.push(p)
      else if (name === 'session.v4.jsonl.zstd' && path.basename(cur) === String(id)) return p
    }
  }
  return null
}

function fsyncCopy(src, dst) {
  copyFileSync(src, dst)
  const fd = openSync(dst, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

/**
 * Slim one session directory.
 * @param options.srcDir - session directory holding session.v4.jsonl.zstd
 * @param options.replace - install the transcript in place (archiving the original)
 * @param options.outDir - for non-replace runs, where to write the transcript
 * @param options.title - optional title override
 * @param options.force - slim even when an archive already exists
 */
export async function slimSession(options) {
  const { srcDir, replace = false, outDir, title, force = false, dryRun = false, keepArchives = 2 } = options
  const src = path.join(srcDir, 'session.v4.jsonl.zstd')
  if (!existsSync(src)) throw new Error(`no v4 log in ${srcDir}`)
  const before = statSync(src).size
  const archiveDir = path.join(srcDir, 'archive')
  const archived = existsSync(archiveDir) ? readdirSync(archiveDir).filter(n => n.includes('session.v4.jsonl.zstd')) : []
  if (archived.length > 0 && !force) {
    return { skipped: true, reason: 'archive already exists', archive: path.join(archiveDir, archived[0]), beforeBytes: before }
  }

  const beforeStat = statSync(src)
  if (replace && !dryRun && await isSessionLocked(srcDir)) {
    throw new Error(`session is currently open by a live writer (${path.join(srcDir, 'session.lock')}); close it before replacing`)
  }
  const t0 = Date.now()
  const { header, nodes, total, lastTitle } = await readSurface(src)
  if (header?.version !== 4) return { skipped: true, reason: `session format v${String(header?.version)} not supported`, beforeBytes: before }
  if (header.isSeeded === true) return { skipped: true, reason: 'seeded session (fork/subagent) not supported yet', beforeBytes: before }
  const bySeq = await readEvents(src, nodes.map(n => n.seq))
  const groups = groupTurns(nodes, bySeq)
  // Keep the existing user-set title on a re-slim; only an explicit override wins.
  const effectiveTitle = title ?? lastTitle?.data?.title
  const { events, turns } = buildTranscript(header, groups, { title: effectiveTitle })
  const analyzeMs = Date.now() - t0

  const orig = transcriptHash(groups)
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'dsh-slim-'))
  try {
    const tWrite = Date.now()
    const produced = await writeTranscript({ header: { ...header, id: header.id }, events, root: scratch })
    const writeMs = Date.now() - tWrite
    const afterBytes = statSync(produced).size
    const tVerify = Date.now()
    const verify = await verifySession(scratch, header.id)
    const verifyMs = Date.now() - tVerify
    if (verify.humanHash !== orig.hash) {
      throw new Error(`transcript mismatch: ${verify.humanHash} != ${orig.hash}`)
    }
    const result = {
      id: header.id, srcDir, turns, surfaceNodes: nodes.length, totalEvents: total,
      transcriptEvents: events.length, beforeBytes: before, afterBytes, analyzeMs,
      humanMessages: verify.humanMessages, humanChars: verify.humanChars, hash: verify.humanHash,
      analyzeMs, writeMs, verifyMs, totalMs: Date.now() - t0,
      dryRun,
    }
    if (dryRun) return result

    if (replace) {
      // Re-check under our own lease: the log must not have moved under the analysis.
      const tInstall = Date.now()
      const release = await acquireSessionLock(srcDir)
      if (release === null) throw new Error('session became owned by a live writer during slimming')
      try {
        const now = statSync(src)
        if (now.size !== beforeStat.size || now.mtimeMs !== beforeStat.mtimeMs) {
          return { ...result, skipped: true, reason: 'log changed during analysis' }
        }
        const installed = await install(result, produced)
        return { ...installed, installMs: Date.now() - tInstall, totalMs: Date.now() - t0 }
      } finally { await release() }
    }
    if (outDir) {
      mkdirSync(outDir, { recursive: true })
      const dst = path.join(outDir, 'session.v4.jsonl.zstd')
      fsyncCopy(produced, dst)
      return { ...result, outPath: dst }
    }
    return result
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  async function install(result, produced) {
      mkdirSync(archiveDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const archivePath = path.join(archiveDir, `${stamp}-session.v4.jsonl.zstd`)
      fsyncCopy(src, archivePath)
      if (statSync(archivePath).size !== before) throw new Error('archive copy size mismatch')
      const staged = path.join(srcDir, `.slim-new-${process.pid}.v4.jsonl.zstd`)
      fsyncCopy(produced, staged)
      renameSync(staged, src)
      pruneArchives(archiveDir, keepArchives)
      return { ...result, archivePath, replaced: true }
  }
}

/**
 * Acquire the session's POSIX write lease; returns a release function, or null
 * when a live writer already holds it.
 */
export async function acquireSessionLock(sessionDir) {
  const lockPath = path.join(sessionDir, 'session.lock')
  const { open } = await import('node:fs/promises')
  const { tryLockExclusive } = await import(SPEC.flock())
  let fh
  try {
    fh = await open(lockPath, 'a+')
    await tryLockExclusive(fh.fd)
  } catch (e) {
    await fh?.close().catch(() => {})
    if (e?.code === 'EAGAIN' || e?.code === 'EWOULDBLOCK') return null
    throw e
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await fh.close().catch(() => {})
  }
}

/**
 * Whether another live writer holds the session's POSIX write lease.
 * The kernel lock is what the harness itself uses, so this is the authoritative
 * "is this session open somewhere" check.
 */
export async function isSessionLocked(sessionDir) {
  const lockPath = path.join(sessionDir, 'session.lock')
  if (!existsSync(lockPath)) return false
  const { open } = await import('node:fs/promises')
  const { tryLockExclusive } = await import(SPEC.flock())
  let fh
  try {
    fh = await open(lockPath, 'r+')
    await tryLockExclusive(fh.fd)
    return false
  } catch (e) {
    if (e?.code === 'EAGAIN' || e?.code === 'EWOULDBLOCK') return true
    throw e
  } finally { await fh?.close() }
}

/** Keep only the newest `keep` archives; older ones are removed. */
function pruneArchives(archiveDir, keep) {
  try {
    const files = readdirSync(archiveDir).filter(n => n.includes('session.v4.jsonl.zstd')).sort()
    for (const name of files.slice(0, Math.max(0, files.length - keep))) rmSync(path.join(archiveDir, name), { force: true })
  } catch { /* best effort */ }
}

/** Locate a session directory by id under a sessions root (directory name is the id). */
export function findSessionDir(root, id) {
  let projects = []
  try { projects = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name)) } catch { return null }
  for (const project of projects) {
    const dir = path.join(project, String(id))
    try { if (statSync(dir).isDirectory()) return dir } catch { /* not here */ }
  }
  return null
}

/** Compressed size of a session log file. */
export function logSize(file) {
  return existsSync(file) ? statSync(file).size : 0
}

export { mb, readFileSync, spawnSync }
