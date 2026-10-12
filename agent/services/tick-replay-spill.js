// agent/services/tick-replay-spill.js — Claude · № 13,571 12-Oct (W6, owner
// "Raise the cap (code change)"; claude-builder).
//
// WHY. The tick replay held every decoded quote as a JS object — measured
// 104 bytes of heap per record on a full 64 MiB segment (1,677,000 records,
// 12-10-2026) — so the 92,274,616 records both sidecars held on 12-10 would
// need about 9.6 GB of heap in a worker of the process that trades. Raising
// MAX_RECORDS alone would either kill the worker at its heap limit or crowd
// the trading process. The trials never needed every symbol at once: each
// one replays ONE symbol's stream.
//
// WHAT. A sink for `walkSegments` that writes each symbol's stream to its own
// file of fixed 32-byte entries as the segments are decoded, then hands one
// symbol's stream back at a time, as the same objects `loadSegments` builds —
// field for field and in the same key order, so a trial replayed through the
// spill is the trial the in-memory path would have produced, trial id
// included (tick-replay-spill.test.js holds the two paths equal).
//
// Entry layout (little-endian): recvMs f64 @0, bid f64 @8, ask f64 @16,
// seq u32 @24, flags u8 @28, 3 bytes unused. A null side is a flag, never a
// sentinel price.
import { openSync, writeSync, closeSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const SPILL_ENTRY_BYTES = 32
const CHUNK_ENTRIES = 2048 // 64 KiB per symbol buffered before a write
const F = Object.freeze({ SNAPSHOT: 1, CROSSED: 2, CHANGED: 4, GAP: 8, BID_NULL: 16, ASK_NULL: 32 })

/**
 * A spill store in `dir` (which must exist). Implements the walkSegments
 * sink: has / push / gapAll / symbols. Then `close()` once, `counts()` for
 * each symbol's stream length, and `read(id)` for a symbol's stream (its file
 * is deleted as it is read, so the disk drains as the replay advances).
 */
export function createSpill(dir, { maxEntries = Infinity } = {}) {
  const streams = new Map() // symbolId → { file, fd, buf, used, count }
  let closed = false
  // Codex P2 on #1330 (owner: "Add a spill-byte cap"): every entry written,
  // across all symbols. A continuity gap writes one per symbol seen so far,
  // so a gap-heavy spool can need more entries than it has records; past
  // `maxEntries` the store refuses rather than fill the disk.
  let total = 0

  const flush = (st) => {
    if (st.used) { writeSync(st.fd, st.buf, 0, st.used * SPILL_ENTRY_BYTES); st.used = 0 }
  }
  const slot = (st) => {
    if (total >= maxEntries) throw spillBoundError(maxEntries)
    total++
    if (st.used === CHUNK_ENTRIES) flush(st)
    const off = st.used * SPILL_ENTRY_BYTES
    st.used++
    st.count++
    return off
  }
  const writeQuote = (st, q) => {
    const off = slot(st)
    const b = st.buf
    b.writeDoubleLE(q.recvMs, off)
    b.writeDoubleLE(q.bid == null ? 0 : q.bid, off + 8)
    b.writeDoubleLE(q.ask == null ? 0 : q.ask, off + 16)
    b.writeUInt32LE(q.seq, off + 24)
    b.writeUInt8((q.snapshot ? F.SNAPSHOT : 0) | (q.crossed ? F.CROSSED : 0) | (q.changed ? F.CHANGED : 0) | (q.bid == null ? F.BID_NULL : 0) | (q.ask == null ? F.ASK_NULL : 0), off + 28)
  }
  const writeGap = (st) => {
    const off = slot(st)
    st.buf.fill(0, off, off + SPILL_ENTRY_BYTES)
    st.buf.writeUInt8(F.GAP, off + 28)
  }

  return {
    dir,
    has: (id) => streams.has(id),
    push(id, q) {
      if (closed) throw new Error('spill is closed')
      let st = streams.get(id)
      if (!st) {
        const file = join(dir, `sym-${id}.spill`)
        st = { file, fd: openSync(file, 'w'), buf: Buffer.alloc(CHUNK_ENTRIES * SPILL_ENTRY_BYTES), used: 0, count: 0 }
        streams.set(id, st)
      }
      writeQuote(st, q)
    },
    gapAll() { for (const st of streams.values()) writeGap(st) },
    symbols: () => [...streams.keys()],
    counts: () => new Map([...streams].map(([id, st]) => [id, st.count])),
    entries: () => total,
    close() {
      if (closed) return
      closed = true
      for (const st of streams.values()) { try { flush(st) } finally { closeSync(st.fd); st.fd = null; st.buf = null } }
    },
    /** One symbol's stream, as loadSegments builds it; the file is removed once read. */
    read(id) {
      if (!closed) throw new Error('read before close')
      const st = streams.get(id)
      if (!st) return null
      const raw = readFileSync(st.file)
      rmSync(st.file, { force: true })
      const n = Math.floor(raw.length / SPILL_ENTRY_BYTES)
      const list = new Array(n)
      for (let i = 0, off = 0; i < n; i++, off += SPILL_ENTRY_BYTES) {
        const flags = raw.readUInt8(off + 28)
        list[i] = flags & F.GAP
          ? { gapMarker: true, seq: 0, recvMs: 0, bid: 1, ask: 0, crossed: true, snapshot: false, changed: true }
          : {
              seq: raw.readUInt32LE(off + 24),
              recvMs: raw.readDoubleLE(off),
              bid: flags & F.BID_NULL ? null : raw.readDoubleLE(off + 8),
              ask: flags & F.ASK_NULL ? null : raw.readDoubleLE(off + 16),
              snapshot: (flags & F.SNAPSHOT) !== 0,
              crossed: (flags & F.CROSSED) !== 0,
              changed: (flags & F.CHANGED) !== 0,
            }
      }
      return list
    },
    /** Remove every file this store wrote (idempotent). */
    remove() {
      this.close()
      for (const st of streams.values()) { if (existsSync(st.file)) rmSync(st.file, { force: true }) }
    },
  }
}

/** The refusal past the entry cap; `code` names it to the job and the route. */
export const SPILL_OVER_BOUND = 'spill_over_bound'
function spillBoundError(maxEntries) {
  const err = new Error(`the spill reached its bound of ${maxEntries.toLocaleString('en-US')} entries (${(maxEntries * SPILL_ENTRY_BYTES).toLocaleString('en-US')} bytes) before the decode finished; each continuity gap adds one entry per symbol seen so far, so this spool needs more than its record count. Nothing was simulated and the test block was not read. Name fewer segments (segments) to bound it`)
  err.code = SPILL_OVER_BOUND
  return err
}
