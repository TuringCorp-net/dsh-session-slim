/**
 * Keyword/time search over an archived raw session log.
 */
import { streamEvents } from './transcript.mjs'

const SEARCHABLE = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result', 'system/message',
  'compaction/summary', 'session/title', 'assistant/attempt',
])

function textOf(ev) {
  const d = ev.data ?? {}
  if (Array.isArray(d.content)) return d.content.filter(b => b?.type === 'text').map(b => b.text).join(' ')
  if (Array.isArray(d.message?.content)) return d.message.content.filter(b => b?.type === 'text').map(b => b.text).join(' ')
  return ''
}

function snippet(haystack, needle, width = 120) {
  const i = haystack.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return ''
  const start = Math.max(0, i - width)
  const end = Math.min(haystack.length, i + needle.length + width)
  return (start > 0 ? '…' : '') + haystack.slice(start, end).replace(/\s+/g, ' ') + (end < haystack.length ? '…' : '')
}

/**
 * Search one archive without loading it into memory.
 * @param file - archive path (zstd-compressed JSONL)
 * @param options.query - case-insensitive substring; empty matches everything
 * @param options.from / options.to - epoch milliseconds bounds
 * @param options.limit - maximum hits returned
 * @param options.types - optional event type filter
 */
export async function searchArchive(file, options = {}) {
  const query = (options.query ?? '').trim()
  const from = options.from ?? -Infinity
  const to = options.to ?? Infinity
  const limit = options.limit ?? 20
  const types = options.types ? new Set(options.types) : SEARCHABLE
  const hits = []
  const counts = new Map()
  let scanned = 0
  for await (const ev of streamEvents(file)) {
    if (ev.type === 'session') continue
    scanned++
    if (ev.time !== undefined && (ev.time < from || ev.time > to)) continue
    if (!types.has(ev.type)) continue
    let matched = true
    let where = 'data'
    if (query) {
      const body = textOf(ev)
      if (body.toLowerCase().includes(query.toLowerCase())) where = 'text'
      else {
        const raw = JSON.stringify(ev.data ?? '')
        matched = raw.toLowerCase().includes(query.toLowerCase())
        where = matched ? 'payload' : where
      }
    }
    if (!matched) continue
    counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1)
    if (hits.length < limit) {
      const body = textOf(ev)
      const raw = query ? JSON.stringify(ev.data ?? '') : ''
      hits.push({
        seq: ev.seq,
        time: ev.time,
        iso: ev.time ? new Date(ev.time).toISOString() : null,
        type: ev.type,
        where,
        snippet: query ? (where === 'text' ? snippet(body, query) : snippet(raw, query)) : (body.slice(0, 160).replace(/\s+/g, ' ') || raw.slice(0, 160)),
      })
    }
  }
  return { scanned, hits, counts: Object.fromEntries(counts), limited: hits.length >= limit }
}
