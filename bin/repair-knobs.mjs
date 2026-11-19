/**
 * Restore session-level settings that a pre-0.1.4 slimming dropped.
 *
 * The transcript used to carry only messages, so the permission knobs and the
 * model selection were gone and a resumed session fell back to composition
 * defaults. This appends the archive's final value of each knob to the live log
 * through the official write handle (last write wins in every projection).
 *
 *   node bin/repair-knobs.mjs <sessionsRoot> [--dry-run] [--session <id>]
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { KNOB_TYPES, streamEvents } from '../src/transcript.mjs'

const argv = process.argv.slice(2)
const root = path.resolve(argv.find(a => !a.startsWith('--')) ?? '.')
const dryRun = argv.includes('--dry-run')
const only = argv.includes('--session') ? argv[argv.indexOf('--session') + 1] : undefined

async function lastKnobs(file) {
  const latest = new Map()
  for await (const ev of streamEvents(file)) {
    if (KNOB_TYPES.has(ev.type)) latest.set(ev.type, ev)
  }
  return [...latest.values()].sort((a, b) => a.seq - b.seq)
}

const same = (a, b) => JSON.stringify(a?.data ?? null) === JSON.stringify(b?.data ?? null)

const projects = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name))
const results = []

for (const project of projects) {
  for (const entry of readdirSync(project, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (only !== undefined && entry.name !== only) continue
    const dir = path.join(project, entry.name)
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    const archiveDir = path.join(dir, 'archive')
    if (!existsSync(log) || !existsSync(archiveDir)) continue
    const archives = readdirSync(archiveDir).filter(n => n.includes('session.v4.jsonl.zstd')).sort()
    if (archives.length === 0) continue
    const original = await lastKnobs(path.join(archiveDir, archives[0]))
    if (original.length === 0) continue
    const current = await lastKnobs(log)
    const byType = new Map(current.map(ev => [ev.type, ev]))
    const missing = original.filter(ev => !same(byType.get(ev.type), ev))
    if (missing.length === 0) { results.push({ id: entry.name, action: 'ok' }); continue }
    if (dryRun) {
      results.push({ id: entry.name, action: 'would-restore', kinds: missing.map(ev => `${ev.type}=${JSON.stringify(ev.data)}`) })
      continue
    }
    const ctx = new Context()
    const smod = await import('@deepseek-ai/dsh-session')
    await ctx.plugin({ name: 'sessions', apply: smod.SessionStore })
    const pmod = await import('@deepseek-ai/dsh-session-persistence-jsonl')
    await ctx.plugin({ name: 'persistence', apply: c => pmod.apply(c, { root, compression: 'zstd' }) })
    try {
      const handle = await ctx.get('sessionPersistence').open(entry.name, 'write')
      const cold = await handle.read(0, undefined, {})
      const base = cold.events.length
      const events = missing.map((ev, i) => ({
        type: ev.type,
        seq: base + i,
        time: Date.now() + i,
        data: structuredClone(ev.data),
      }))
      await handle.append(events, {})
      await handle.flush()
      await handle.close()
      results.push({ id: entry.name, action: 'restored', kinds: missing.map(ev => `${ev.type}=${JSON.stringify(ev.data)}`) })
    } catch (error) {
      results.push({ id: entry.name, action: 'failed', error: String(error?.message ?? error).slice(0, 160) })
    } finally {
      await ctx.scope?.dispose?.()
    }
  }
}

for (const r of results) {
  if (r.action === 'ok') continue
  console.log(`${r.action.padEnd(13)} ${r.id}  ${r.kinds ? r.kinds.join(' , ') : r.error}`)
}
console.log(`checked ${results.length} sessions, restored ${results.filter(r => r.action === 'restored').length}`)
