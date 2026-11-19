/**
 * Streaming analysis of a DSH v4 JSONL session log and construction of a
 * "transcript" event stream: the conversation that is still visible on the
 * surface, reduced to messages, without tool traffic, reasoning or replay data.
 *
 * Two passes over the compressed log keep peak memory near the size of the
 * final transcript instead of the size of the whole log.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'

export const SURFACE_TYPES = new Set([
  'system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result',
])

/**
 * Session-level settings the rest of DSH derives from the log, not from the
 * header: the permission knobs and the model chosen for this session. They are
 * last-write-wins projection state, so the transcript carries the final value
 * of each — dropping them makes a resumed session fall back to composition
 * defaults, which silently changed a user's permissions after slimming.
 */
export const KNOB_TYPES = new Set([
  'permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection',
])

/** Stream one decoded JSONL record per line from a zstd-compressed session log. */
export async function * streamEvents(srcPath) {
  const child = spawn('zstd', ['-dc', srcPath], { stdio: ['ignore', 'pipe', 'ignore'] })
  const rl = readline.createInterface({ input: child.stdout })
  for await (const line of rl) {
    if (!line) continue
    try { yield JSON.parse(line) } catch { /* torn tail line: ignore */ }
  }
}

/**
 * Replay the canonical surface fold over the log without retaining payloads.
 * @returns header, the surviving surface nodes ({seq,type}) and event totals.
 */
export async function readSurface(srcPath) {
  const nodes = []
  const knobs = new Map()
  let header = null
  let total = 0
  let lastTitle = null
  for await (const ev of streamEvents(srcPath)) {
    if (ev.type === 'session') { header = ev; continue }
    total++
    if (ev.type === 'session/title') {
      const k = ev.data?.messageSeqs
      if (Array.isArray(k) && k.length === 0) lastTitle = ev
      continue
    }
    if (KNOB_TYPES.has(ev.type)) { knobs.set(ev.type, ev); continue }
    if (!SURFACE_TYPES.has(ev.type)) continue
    const op = ev.surfaceOp
    if (op === undefined || op === 'append') { nodes.push({ seq: ev.seq, type: ev.type }); continue }
    const a = nodes.findIndex(n => n.seq === op.startSeq)
    const b = nodes.findIndex(n => n.seq === op.endSeq)
    if (a < 0 || b < a) { nodes.push({ seq: ev.seq, type: ev.type }); continue }
    nodes.splice(a, b - a + 1, { seq: ev.seq, type: ev.type })
  }
  return { header, nodes, total, lastTitle, knobs: [...knobs.values()].sort((a, b) => a.seq - b.seq) }
}

/** Read the payloads of exactly the given sequence numbers. */
export async function readEvents(srcPath, seqs) {
  const want = new Set(seqs)
  const out = new Map()
  for await (const ev of streamEvents(srcPath)) {
    if (want.has(ev.seq)) out.set(ev.seq, ev)
  }
  return out
}

/**
 * Group surface nodes into turns: one user message plus the assistant messages
 * that answer it; the protected system head gets its own turn.
 * @returns array of {kind, events}
 */
export function groupTurns(nodes, bySeq) {
  const groups = []
  let current = null
  for (const node of nodes) {
    const ev = bySeq.get(node.seq)
    if (!ev) continue
    if (ev.type === 'system/message') {
      groups.push({ kind: 'system', events: [ev] })
      current = null
      continue
    }
    if (ev.type === 'user/message') {
      current = { kind: 'user', events: [ev] }
      groups.push(current)
      continue
    }
    if (ev.type === 'assistant/message') {
      const text = (ev.data?.message?.content ?? []).filter(
        b => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0,
      )
      if (text.length === 0) continue
      const clean = {
        ...ev,
        data: { turn: 0, step: 1, message: { ...ev.data.message, content: text }, ...(ev.data.usage === undefined ? {} : { usage: ev.data.usage }), ...(ev.data.interrupted === undefined ? {} : { interrupted: ev.data.interrupted }), stream: [] },
      }
      if (current === null) { current = { kind: 'assistant', events: [clean] }; groups.push(current); continue }
      current.events.push(clean)
      continue
    }
    // tool/result and developer/message are dropped with the tool traffic they belong to.
  }
  return groups
}

/**
 * Build a complete, dense transcript event list from the visible surface.
 * @param header - original v4 header (id/cwd/createdAt are preserved)
 * @param groups - turns produced by {@link groupTurns}
 * @param options.title - optional title override
 */
export function buildTranscript(header, groups, options = {}) {
  const events = []
  let seq = 0
  let turn = 0
  // Settings first, exactly where DSH itself writes them: before turn 1 and
  // outside any step.
  for (const ev of options.knobs ?? []) {
    const copy = { ...ev, seq: seq++, time: ev.time ?? (header.createdAt ?? Date.now()) }
    delete copy.surfaceOp
    delete copy.sourceEventSeqs
    events.push(copy)
  }
  const push = (type, data, surfaceOp) => {
    const ev = { type, seq: seq++, time: (header.createdAt ?? Date.now()) + seq, data }
    if (surfaceOp !== undefined) ev.surfaceOp = surfaceOp
    events.push(ev)
  }
  for (const group of groups) {
    turn++
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    for (const ev of group.events) {
      if (ev.type === 'system/message') push('system/message', { ...ev.data, turn, step: 1 }, 'append')
      else if (ev.type === 'user/message') push('user/message', ev.data, 'append')
      else push('assistant/message', { ...ev.data, turn, step: 1 }, 'append')
    }
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  if (options.title !== undefined) {
    push('session/title', { title: options.title, messageSeqs: [], source: { kind: 'user' } })
  }
  return { events, turns: turn }
}

/** Human-visible text of a message event, in the same shape the resume path derives. */
export function messageText(ev) {
  const content = ev.data?.message?.content ?? ev.data?.content ?? []
  return content.filter(b => b && b.type === 'text').map(b => b.text.trim()).filter(Boolean).join(' ')
}
