/**
 * End-to-end smoke test on a synthetic session: write → slim --replace → verify → append.
 * Run: node test/smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { slimSession, verifySession } from '../src/slim.mjs'
import { searchArchive } from '../src/search.mjs'

const root = mkdtempSync(path.join(os.tmpdir(), 'slim-smoke-'))
const id = 'session-00000000-0000-4000-8000-000000000001'
const cwd = root

async function writeOriginal() {
  const ctx = new Context()
  const smod = await import('@deepseek-ai/dsh-session')
  await ctx.plugin({ name: 'sessions', apply: smod.SessionStore })
  const pmod = await import('@deepseek-ai/dsh-session-persistence-jsonl')
  await ctx.plugin({ name: 'persistence', apply: c => pmod.apply(c, { root, compression: 'zstd' }) })
  const handle = await ctx.get('sessionPersistence').create({ version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth: 0 })
  const events = []
  let seq = 0
  const push = (type, data, surfaceOp) => { const ev = { type, seq: seq++, time: Date.now() + seq, data }; if (surfaceOp) ev.surfaceOp = surfaceOp; events.push(ev) }
  push('turn/start', { turn: 1 })
  push('step/start', { turn: 1, step: 1 })
  push('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'You are a test agent.' }], source: { kind: 'system-prompt' } } }, 'append')
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello SMOKE_MARKER' }], source: { kind: 'user', rpcId: 'r1' } }, 'append')
  push('step/end', { turn: 1, step: 1 })
  push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await handle.append(events, {})
  await handle.flush()
  await handle.close()
  await ctx.scope?.dispose?.()
}

try {
  await writeOriginal()
  const before = await verifySession(root, id)
  const dir = path.join(root, cwd.replace(/^\//, '').replace(/\//g, '-') && `--${cwd.replace(/^\//, '').replace(/\//g, '-')}--`, id)
  const r = await slimSession({ srcDir: dir, replace: true })
  if (!r.replaced) throw new Error('replace did not happen')
  const after = await verifySession(root, id)
  if (after.humanHash !== before.humanHash) throw new Error(`hash mismatch ${before.humanHash} != ${after.humanHash}`)
  const archive = r.archivePath
  const found = await searchArchive(archive, { query: 'SMOKE_MARKER' })
  if (found.hits.length === 0) throw new Error('archive search found nothing')
  console.log('SMOKE OK', JSON.stringify({ id, turns: r.turns, events: after.events, human: after.humanMessages, hash: after.humanHash, archiveHits: found.hits.length }))
} finally {
  rmSync(root, { recursive: true, force: true })
}
