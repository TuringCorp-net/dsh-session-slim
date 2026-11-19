/**
 * Edge-case checks for the open-time hook:
 *   1. a session held by another live writer is left untouched;
 *   2. once released, the same open slims it;
 *   3. a grown log is slimmed again and old archives are pruned;
 *   4. a seeded (fork/subagent) session is refused.
 *
 * Run: node test/edge-cases.mjs
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply as mountSlim } from '../plugin/index.js'
import { slimSession } from '../src/slim.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'slim-edge-'))
const id = 'session-00000000-0000-4000-8000-000000000002'
const seededId = 'session-00000000-0000-4000-8000-000000000003'
const cwd = '/home/uncleli'
const project = path.join(root, '--' + cwd.replace(/^\//, '').replace(/\//g, '-') + '--')
const dir = path.join(project, id)
const logs = []

async function makeSession(sessionId, { seeded = false } = {}) {
  const ctx = new Context()
  const smod = await import('@deepseek-ai/dsh-session')
  await ctx.plugin({ name: 'sessions', apply: smod.SessionStore })
  const pmod = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  await ctx.plugin({ name: 'persistence', apply: c => pmod.apply(c, { root, compression: 'zstd' }) })
  const handle = await ctx.get('sessionPersistence').create({ version: 4, id: sessionId, createdAt: Date.now(), cwd, isSeeded: seeded, delegationDepth: 0 })
  const events = []
  let seq = 0
  const push = (type, data, surfaceOp) => { const ev = { type, seq: seq++, time: Date.now() + seq, data }; if (surfaceOp) ev.surfaceOp = surfaceOp; events.push(ev) }
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } }, 'append')
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello EDGE_MARKER' }], source: { kind: 'user', rpcId: 'r' } }, 'append')
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await handle.append(events, {})
  await handle.flush(); await handle.close()
  await ctx.scope?.dispose?.()
}

function makeContext() {
  const ctx = new Context()
  return (async () => {
    const smod = await import('@deepseek-ai/dsh-session')
    await ctx.plugin({ name: 'sessions', apply: smod.SessionStore })
    const pmod = await import('@deepseek-ai/dsh-session-persistence-jsonl')
    await ctx.plugin({ name: 'persistence', apply: c => pmod.apply(c, { root, compression: 'zstd' }) })
    const fake = {
      sessionPersistence: ctx.get('sessionPersistence'),
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push('WARN ' + m) },
      effect: (fn) => fn(),
    }
    mountSlim(fake, { minBytes: 1, keepArchives: 1, timeoutMs: 60_000 })
    return ctx
  })()
}

const size = (p) => statSync(p).size
const archives = (d) => existsSync(path.join(d, 'archive')) ? readdirSync(path.join(d, 'archive')) : []

try {
  await makeSession(id)
  const log = path.join(dir, 'session.v4.jsonl.zstd')
  const beforeLock = size(log)

  // 1. hold the official write lease from another process
  const lockPath = path.join(dir, 'session.lock')
  const holder = spawn('flock', ['-x', lockPath, '-c', 'sleep 2'], { stdio: 'ignore' })
  await new Promise(r => setTimeout(r, 500))
  const ctx1 = await makeContext()
  const h1 = await ctx1.get('sessionPersistence').open(id, 'read')
  const r1 = await h1.read(0, undefined, {})
  const afterLocked = size(log)
  await h1.close(); await ctx1.scope?.dispose?.()
  await new Promise(r => holder.on('exit', r))

  // 2. released: the next open slims
  const ctx2 = await makeContext()
  const h2 = await ctx2.get('sessionPersistence').open(id, 'read')
  await h2.close(); await ctx2.scope?.dispose?.()
  const afterSlim = size(log)
  const arch1 = archives(dir)

  // 3. grow it again with a fat message and re-open: second slim, archives pruned to 1
  const ctx3 = await makeContext()
  const h3 = await ctx3.get('sessionPersistence').open(id, 'write')
  const cur = await h3.read(0, undefined, {})
  const base = cur.events.length
  const big = 'x'.repeat(400 * 1024)
  await h3.append([
    { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 2 } },
    { type: 'step/start', seq: 0, time: Date.now(), data: { turn: 2, step: 1 } },
    { type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'grow ' + big }], source: { kind: 'user', rpcId: 'r2' } } },
    { type: 'step/end', seq: 0, time: Date.now(), data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: 0, time: Date.now(), data: { turn: 2, reason: { kind: 'completed' } } },
  ].map((e, i) => ({ ...e, seq: base + i })))
  await h3.close(); await ctx3.scope?.dispose?.()
  const grown = size(log)
  const ctx4 = await makeContext()
  const h4 = await ctx4.get('sessionPersistence').open(id, 'read')
  await h4.close(); await ctx4.scope?.dispose?.()
  const arch2 = archives(dir)

  // 4. a seeded (fork/subagent) log is refused before anything is written
  const seededDir = path.join(project, 'session-seeded')
  mkdirSync(seededDir, { recursive: true })
  const seededLog = path.join(seededDir, 'session.v4.jsonl.zstd')
  const seededLines = [
    JSON.stringify({ type: 'session', version: 4, id: 'session-seeded', createdAt: 1, cwd, isSeeded: true, delegationDepth: 0 }),
    JSON.stringify({ type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }),
    JSON.stringify({ type: 'session/end-seed', seq: 1, time: 3, data: { inherited: true } }),
    JSON.stringify({ type: 'step/start', seq: 2, time: 4, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'system/message', seq: 3, time: 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 's', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } } }),
    JSON.stringify({ type: 'user/message', seq: 4, time: 6, surfaceOp: 'append', data: { id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }),
    JSON.stringify({ type: 'step/end', seq: 5, time: 7, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 6, time: 8, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
  execFileSync('zstd', ['-q', '-o', seededLog], { input: seededLines.join('\n') + '\n' })
  const seededBefore = size(seededLog)
  const seededResult = await slimSession({ srcDir: seededDir, replace: true, dryRun: true })
  const seededAfter = size(seededLog)

  console.log(JSON.stringify({
    locked: { before: beforeLock, after: afterLocked, untouched: beforeLock === afterLocked, events: r1.events.length },
    slim: { after: afterSlim, shrank: afterSlim < beforeLock, archives: arch1.length },
    regrow: { grown, after: size(log), shrunkAgain: size(log) < grown, archives: arch2.length },
    seeded: { before: seededBefore, after: seededAfter, untouched: seededBefore === seededAfter, skipped: seededResult.skipped, reason: seededResult.reason },
    logs,
  }, null, 2))
} finally {
  rmSync(root, { recursive: true, force: true })
}
