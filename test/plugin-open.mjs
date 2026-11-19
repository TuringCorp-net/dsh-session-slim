/**
 * Plugin behaviour test: mount the plugin on a real persistence service and
 * prove that a resume of a large session is slimmed before it is read.
 *
 * Usage: node test/plugin-open.mjs <sessionDir>
 */
import { existsSync, mkdtempSync, readdirSync, statSync, copyFileSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { apply as mountSlim, name as pluginName, inject as pluginInject } from '../plugin/index.js'

const srcDir = path.resolve(process.argv[2])
const id = path.basename(srcDir)
const headerLine = execFileSync('sh', ['-c', 'zstd -dc "$1" | head -1', 'sh', path.join(srcDir, 'session.v4.jsonl.zstd')], { maxBuffer: 1 << 20 }).toString('utf8')
const header = JSON.parse(headerLine)
const projectKey = '--' + String(header.cwd ?? '').replace(/^\//, '').replace(/\//g, '-') + '--'
const root = mkdtempSync(path.join(os.tmpdir(), 'slim-plugin-'))
const project = path.join(root, projectKey)
mkdirSync(path.join(project, id), { recursive: true })
copyFileSync(path.join(srcDir, 'session.v4.jsonl.zstd'), path.join(project, id, 'session.v4.jsonl.zstd'))

const mb = (n) => (n / 1048576).toFixed(0) + ' MB'
const ctx = new Context()
const logs = []
const smod = await import('@deepseek-ai/dsh-session')
await ctx.plugin({ name: 'sessions', apply: smod.SessionStore })
const pmod = await import('@deepseek-ai/dsh-session-persistence-jsonl')
await ctx.plugin({ name: 'persistence', apply: c => pmod.apply(c, { root, compression: 'zstd' }) })

const fakeCtx = {
  sessionPersistence: ctx.get('sessionPersistence'),
  logger: { info: (m) => { logs.push(m); }, warn: (m) => { logs.push('WARN ' + m) } },
  effect: (fn) => fn(),
}
console.log('plugin', pluginName, 'inject', pluginInject)
mountSlim(fakeCtx, { minBytes: 1024 * 1024 })

const beforeSize = statSync(path.join(project, id, 'session.v4.jsonl.zstd')).size
const t0 = Date.now()
const handle = await ctx.get('sessionPersistence').open(id, 'write')
const openMs = Date.now() - t0
const rssAfterOpen = process.memoryUsage().rss
const cold = await handle.read(0, undefined, {})
const session = ctx.sessions.prepare(id, {
  seed: cold.events, meta: structuredClone(handle.header),
  inheritedEventCount: handle.inheritedEventCount, eventState: cold.eventState,
})
const messages = session.deriveMessages().length
const afterSize = statSync(path.join(project, id, 'session.v4.jsonl.zstd')).size
const archiveDir = path.join(project, id, 'archive')
const archives = existsSync(archiveDir) ? readdirSync(archiveDir) : []
await handle.close()

// second open must be a no-op on the file (already below the threshold)
const t1 = Date.now()
const h2 = await ctx.get('sessionPersistence').open(id, 'read')
await h2.close()
const secondOpenMs = Date.now() - t1
const finalSize = statSync(path.join(project, id, 'session.v4.jsonl.zstd')).size

console.log(JSON.stringify({
  beforeBytes: beforeSize, afterBytes: afterSize, finalSize,
  openMs, secondOpenMs, rssAfterOpen: mb(rssAfterOpen), events: cold.events.length, messages,
  archives: archives.length, logs,
}, null, 2))
rmSync(root, { recursive: true, force: true })
