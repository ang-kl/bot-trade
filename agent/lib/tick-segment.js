// agent/lib/tick-segment.js — P3b: the reader for the sidecar's tick
// segments (cpp-exec/src/tick_recorder.hpp, format v1). Decodes a sealed
// (or torn) segment into QuoteEvent objects (lib/entry-contracts.js, plan
// §4) and gap markers, verifying every checksum and stopping at the first
// bad or short record — the torn tail is reported, never guessed at. The
// format constants here are pinned against the C++ header by
// tick-segment.test.js so the two cannot drift apart silently.
import { validateQuoteEvent } from './entry-contracts.js'

export const FORMAT_VERSION = 1
export const HEADER_BYTES = 64
export const RECORD_BYTES = 40
export const ABSENT = -(2n ** 63n) // INT64_MIN
export const FLAGS = Object.freeze({ BID_PRESENT: 1, ASK_PRESENT: 2, BID_CHANGED: 4, ASK_CHANGED: 8, SNAPSHOT: 16, CROSSED: 32, REPEAT: 64 })
export const KIND = Object.freeze({ QUOTE: 0, GAP: 1 })
export const GAP_REASONS = Object.freeze({ 1: 'queue_overflow', 2: 'reserve_pause', 3: 'reconnect', 4: 'restart', 5: 'switched_off' })

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0 }
  return t
})()
export function crc32(buf, len = buf.length) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

export function decodeHeader(buf) {
  if (buf.length < HEADER_BYTES || buf.toString('latin1', 0, 4) !== 'TKSG') return null
  if (buf.readUInt16LE(4) !== FORMAT_VERSION || buf.readUInt16LE(6) !== HEADER_BYTES) return null
  if (crc32(buf, 60) !== buf.readUInt32LE(60)) return null
  const feedRaw = buf.subarray(24, 60)
  const nul = feedRaw.indexOf(0)
  return {
    environment: buf.readUInt8(8) === 1 ? 'live' : 'demo',
    generation: buf.readUInt32LE(12),
    startedMs: Number(buf.readBigUInt64LE(16)),
    feedId: feedRaw.subarray(0, nul < 0 ? 36 : nul).toString('utf8'),
  }
}

export function decodeRecord(buf, off = 0) {
  if (buf.length < off + RECORD_BYTES) return null
  if (crc32(buf.subarray(off, off + 36)) !== buf.readUInt32LE(off + 36)) return null
  return {
    recvMs: Number(buf.readBigUInt64LE(off)),
    seq: buf.readUInt32LE(off + 8),
    symbolId: buf.readUInt32LE(off + 12),
    bid: buf.readBigInt64LE(off + 16),
    ask: buf.readBigInt64LE(off + 24),
    flags: buf.readUInt8(off + 32),
    kind: buf.readUInt8(off + 33),
    generation: buf.readUInt16LE(off + 34),
  }
}

/** Encoders for tests and fixtures (mirror of the C++ encoders). */
export function encodeHeader({ environment = 'demo', generation = 0, startedMs = 0, feedId = '' }) {
  const b = Buffer.alloc(HEADER_BYTES)
  b.write('TKSG', 0, 'latin1'); b.writeUInt16LE(FORMAT_VERSION, 4); b.writeUInt16LE(HEADER_BYTES, 6)
  b.writeUInt8(environment === 'live' ? 1 : 0, 8); b.writeUInt32LE(generation, 12); b.writeBigUInt64LE(BigInt(startedMs), 16)
  b.write(String(feedId).slice(0, 36), 24, 'utf8'); b.writeUInt32LE(crc32(b, 60), 60)
  return b
}
export function encodeRecord({ recvMs = 0, seq = 0, symbolId = 0, bid = ABSENT, ask = ABSENT, flags = 0, kind = 0, generation = 0 }) {
  const b = Buffer.alloc(RECORD_BYTES)
  b.writeBigUInt64LE(BigInt(recvMs), 0); b.writeUInt32LE(seq, 8); b.writeUInt32LE(symbolId, 12)
  b.writeBigInt64LE(BigInt(bid), 16); b.writeBigInt64LE(BigInt(ask), 24); b.writeUInt8(flags, 32); b.writeUInt8(kind, 33); b.writeUInt16LE(generation, 34)
  b.writeUInt32LE(crc32(b, 36), 36)
  return b
}

/**
 * A whole segment → { header, records, truncated }. `records` are raw
 * decoded records in file order (quotes and gaps); decoding stops at the
 * first bad checksum or short record.
 */
export function readSegment(buf) {
  const header = decodeHeader(buf)
  if (!header) return { header: null, records: [], truncated: true }
  const records = []
  let off = HEADER_BYTES
  let truncated = false
  while (off < buf.length) {
    const r = decodeRecord(buf, off)
    if (!r) { truncated = true; break }
    records.push(r)
    off += RECORD_BYTES
  }
  return { header, records, truncated }
}

/**
 * Raw records → plan §4 QuoteEvents (validated) and gap markers, replaying
 * the recorder's own flags: per-side freshness from the *UpdatedSeq fields,
 * `quality.snapshot` from the SNAPSHOT flag, `missingSide` whenever the
 * event carries one side only (the contract's own rule). `symbol` names come from
 * `symbolNames` (id → name) or fall back to `#<id>`.
 */
export function toQuoteEvents(segment, { symbolNames = {} } = {}) {
  const out = []
  const last = new Map() // symbolId → { bidSeq, askSeq, gen }
  for (const r of segment.records) {
    if (r.kind === KIND.GAP) {
      out.push({ gap: true, reason: GAP_REASONS[Number(r.ask)] || `reason_${r.ask}`, count: Number(r.bid), recvMs: r.recvMs, generation: r.generation })
      continue
    }
    if (r.flags & FLAGS.REPEAT) {
      // An identical repeat is an observation, not a quote change: the
      // contract refuses a non-snapshot event that changes no side (plan
      // §4, "exclude identical repeats from signal counters"). Kept in the
      // stream as a marker so nothing is dropped silently.
      out.push({ repeat: true, symbolId: r.symbolId, seq: r.seq, recvMs: r.recvMs, generation: r.generation })
      continue
    }
    let st = last.get(r.symbolId)
    if (!st || st.gen !== r.generation) { st = { bidSeq: null, askSeq: null, gen: r.generation }; last.set(r.symbolId, st) }
    const hasBid = (r.flags & FLAGS.BID_PRESENT) !== 0, hasAsk = (r.flags & FLAGS.ASK_PRESENT) !== 0
    if (hasBid) st.bidSeq = r.seq
    if (hasAsk) st.askSeq = r.seq
    const ev = {
      environment: segment.header.environment,
      feedId: segment.header.feedId,
      symbolId: r.symbolId,
      symbol: symbolNames[r.symbolId] || `#${r.symbolId}`,
      generation: r.generation,
      seq: r.seq,
      brokerTsMs: null,
      recvMonoNs: r.recvMs * 1_000_000,
      bid: hasBid ? Number(r.bid) : null,
      ask: hasAsk ? Number(r.ask) : null,
      changedMask: ((r.flags & FLAGS.BID_CHANGED) ? 1 : 0) | ((r.flags & FLAGS.ASK_CHANGED) ? 2 : 0),
      bidUpdatedSeq: st.bidSeq,
      askUpdatedSeq: st.askSeq,
      quality: {
        snapshot: (r.flags & FLAGS.SNAPSHOT) !== 0,
        stale: false,
        crossed: (r.flags & FLAGS.CROSSED) !== 0,
        missingSide: !hasBid || !hasAsk, // the contract's rule: true whenever a side of THIS event is null
      },
    }
    const v = validateQuoteEvent(ev)
    out.push(v.ok ? ev : { invalid: true, errors: v.errors, record: r })
  }
  return out
}
