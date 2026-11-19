#!/usr/bin/env node
/**
 * dsh-session-slim — turn a long DSH session log into a lightweight transcript.
 *
 *   slim <sessionDir> [--replace] [--out DIR] [--title T] [--dry-run] [--force]
 *   verify <sessionsRoot> <sessionId>
 *   search <archiveFile> [--query Q] [--from ISO] [--to ISO] [--limit N] [--types a,b]
 *   info <sessionDir>
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { slimSession, verifySession } from '../src/slim.mjs'
import { searchArchive } from '../src/search.mjs'
import { readSurface } from '../src/transcript.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = new Map()
const positional = []
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { flags.set(key, next); i++ } else flags.set(key, true)
  } else positional.push(a)
}
const fmtBytes = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB'
const fmtTime = (ms) => ms ? new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z/, 'Z') : '-'

async function main() {
  if (cmd === 'slim') {
    const dir = path.resolve(positional[0] ?? '.')
    const r = await slimSession({
      srcDir: dir,
      replace: flags.get('replace') === true,
      outDir: flags.get('out') ? path.resolve(String(flags.get('out'))) : undefined,
      title: flags.get('title') === true ? undefined : flags.get('title'),
      force: flags.get('force') === true,
      dryRun: flags.get('dry-run') === true,
      keepArchives: flags.get('keep-archives') ? Number(flags.get('keep-archives')) : 2,
    })
    if (flags.get('json') === true) { console.log(JSON.stringify(r)); return }
    if (r.skipped) { console.log(`SKIP  ${r.reason}\n      archive: ${r.archive}`); return }
    console.log(`SESSION  ${r.id}`)
    console.log(`  surface nodes   ${r.surfaceNodes} of ${r.totalEvents} events`)
    console.log(`  turns written   ${r.turns}   transcript events ${r.transcriptEvents}`)
    console.log(`  size            ${fmtBytes(r.beforeBytes)} -> ${fmtBytes(r.afterBytes)}`)
    console.log(`  human messages  ${r.humanMessages} (${r.humanChars} chars, hash ${r.hash})`)
    console.log(`  analyze time    ${r.analyzeMs} ms`)
    if (r.dryRun) console.log('  DRY RUN — nothing written')
    else if (r.replaced) console.log(`  REPLACED        original archived at ${r.archivePath}`)
    else if (r.outPath) console.log(`  WRITTEN         ${r.outPath}`)
    return
  }
  if (cmd === 'verify') {
    const root = path.resolve(positional[0])
    const id = positional[1]
    const v = await verifySession(root, id)
    console.log(JSON.stringify({ events: v.events, messages: v.messages, humanMessages: v.humanMessages, humanChars: v.humanChars, humanHash: v.humanHash, cwd: v.header?.cwd }, null, 2))
    return
  }
  if (cmd === 'search') {
    const file = path.resolve(positional[0])
    const from = flags.get('from') ? Date.parse(String(flags.get('from'))) : undefined
    const to = flags.get('to') ? Date.parse(String(flags.get('to'))) : undefined
    const r = await searchArchive(file, {
      query: flags.get('query') === true ? undefined : flags.get('query'),
      from, to,
      limit: flags.get('limit') ? Number(flags.get('limit')) : 20,
      types: flags.get('types') ? String(flags.get('types')).split(',') : undefined,
    })
    console.log(`scanned ${r.scanned} events  counts ${JSON.stringify(r.counts)}  ${r.limited ? '(limited)' : ''}`)
    for (const h of r.hits) {
      console.log(`\n[seq ${h.seq}] ${fmtTime(h.time)} ${h.type} (${h.where})\n  ${h.snippet}`)
    }
    return
  }
  if (cmd === 'status') {
    const root = path.resolve(positional[0] ?? '.')
    const minBytes = flags.get('min') ? Number(flags.get('min')) : 0
    const rows = []
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      for (const entry of readdirSync(path.join(root, project.name), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(root, project.name, entry.name)
        const log = path.join(dir, 'session.v4.jsonl.zstd')
        if (!existsSync(log)) continue
        const size = statSync(log).size
        if (size < minBytes) continue
        const archives = existsSync(path.join(dir, 'archive')) ? readdirSync(path.join(dir, 'archive')).length : 0
        rows.push({ id: entry.name, bytes: size, archives, dir })
      }
    }
    rows.sort((a, b) => b.bytes - a.bytes)
    console.log(`sessions=${rows.length} total=${(rows.reduce((n, r) => n + r.bytes, 0) / 1048576).toFixed(1)} MB`)
    for (const r of rows) console.log(`${(r.bytes / 1048576).toFixed(2).padStart(8)} MB  archives=${r.archives}  ${r.id}`)
    return
  }
  if (cmd === 'info') {
    const dir = path.resolve(positional[0] ?? '.')
    const log = path.join(dir, 'session.v4.jsonl.zstd')
    if (!existsSync(log)) { console.log('no session.v4.jsonl.zstd'); process.exitCode = 1; return }
    const size = statSync(log).size
    const { header, nodes, total } = await readSurface(log)
    const archiveDir = path.join(dir, 'archive')
    const archives = existsSync(archiveDir) ? readdirSync(archiveDir) : []
    console.log(JSON.stringify({
      id: header?.id, cwd: header?.cwd, createdAt: header?.createdAt,
      bytes: size, events: total, surfaceNodes: nodes.length, archives,
    }, null, 2))
    return
  }
  console.log('usage: slim|verify|search|info (see header comment)')
  process.exitCode = 1
}

main().catch((e) => { console.error('FAIL', e?.stack ?? e); process.exitCode = 1 })
