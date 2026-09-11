// agent/lib/tick-segment.test.js — P3b: the segment reader round-trips the
// recorder's format, verifies checksums, stops at a torn tail, replays the
// flags into valid QuoteEvents, and its constants are pinned to the C++
// header so the two formats cannot drift apart silently.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { encodeHeader, encodeRecord, readSegment, toQuoteEvents, crc32, FLAGS, KIND, ABSENT, HEADER_BYTES, RECORD_BYTES, FORMAT_VERSION } from './tick-segment.js'

function segment(records, header = {}) {
  return Buffer.concat([encodeHeader({ environment: 'demo', generation: 1, startedMs: 1757548800000, feedId: 'demo.ctraderapi.com', ...header }), ...records.map(encodeRecord)])
}

test('round trip, checksum, torn tail, and the QuoteEvent replay of the flags', () => {
  const recs = [
    { recvMs: 1757548800000, seq: 1, symbolId: 41, bid: 108123n, ask: 108131n, flags: FLAGS.BID_PRESENT | FLAGS.ASK_PRESENT | FLAGS.SNAPSHOT, generation: 1 },
    { recvMs: 1757548800005, seq: 2, symbolId: 41, bid: 108124n, ask: ABSENT, flags: FLAGS.BID_PRESENT | FLAGS.BID_CHANGED, generation: 1 },
    { recvMs: 1757548800009, seq: 3, symbolId: 41, bid: 108124n, ask: 108131n, flags: FLAGS.BID_PRESENT | FLAGS.ASK_PRESENT | FLAGS.REPEAT, generation: 1 },
    { recvMs: 1757548800010, seq: 4, symbolId: 0, bid: 3n, ask: 1n, flags: 0, kind: KIND.GAP, generation: 1 },
    { recvMs: 1757548800020, seq: 5, symbolId: 42, bid: ABSENT, ask: 7n, flags: FLAGS.ASK_PRESENT | FLAGS.SNAPSHOT, generation: 1 },
  ]
  const buf = segment(recs)
  assert.equal(buf.length, HEADER_BYTES + recs.length * RECORD_BYTES)
  const seg = readSegment(buf)
  assert.equal(seg.truncated, false)
  assert.deepEqual(seg.header, { environment: 'demo', generation: 1, startedMs: 1757548800000, feedId: 'demo.ctraderapi.com' })
  assert.equal(seg.records.length, 5)
  assert.equal(seg.records[1].ask, ABSENT)
  const evs = toQuoteEvents(seg, { symbolNames: { 41: 'EURUSD' } })
  assert.equal(evs.length, 5)
  assert.equal(evs[0].symbol, 'EURUSD'); assert.equal(evs[0].quality.snapshot, true); assert.equal(evs[0].quality.missingSide, false); assert.equal(evs[0].changedMask, 0)
  assert.equal(evs[1].bid, 108124); assert.equal(evs[1].ask, null); assert.equal(evs[1].changedMask, 1); assert.equal(evs[1].bidUpdatedSeq, 2); assert.equal(evs[1].askUpdatedSeq, 1); assert.equal(evs[1].quality.missingSide, true)
  assert.deepEqual(evs[2], { repeat: true, symbolId: 41, seq: 3, recvMs: 1757548800009, generation: 1 }, 'an identical repeat is a marker, not a QuoteEvent')
  assert.deepEqual(evs[3], { gap: true, reason: 'queue_overflow', count: 3, recvMs: 1757548800010, generation: 1 })
  assert.equal(evs[4].symbol, '#42'); assert.equal(evs[4].quality.missingSide, true, 'one-sided event')
  for (const ev of evs) if (!ev.gap && !ev.repeat) assert.equal(ev.invalid, undefined, JSON.stringify(ev.errors))
  // a flipped bit fails the checksum and stops the read there
  const bad = Buffer.from(buf); bad[HEADER_BYTES + RECORD_BYTES + 17] ^= 1
  const seg2 = readSegment(bad)
  assert.equal(seg2.records.length, 1); assert.equal(seg2.truncated, true)
  // a torn tail
  const torn = buf.subarray(0, buf.length - 13)
  const seg3 = readSegment(torn)
  assert.equal(seg3.records.length, 4); assert.equal(seg3.truncated, true)
  // a corrupt header
  const hb = Buffer.from(buf); hb[9] = 0xFF
  assert.equal(readSegment(hb).header, null)
  assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926) // the CRC-32 check value
})

test('the format constants are the C++ header\'s', () => {
  const hpp = readFileSync(new URL('../../cpp-exec/src/tick_recorder.hpp', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(hpp, new RegExp(`kFormatVersion = ${FORMAT_VERSION};`))
  assert.match(hpp, new RegExp(`kHeaderBytes = ${HEADER_BYTES};`))
  assert.match(hpp, new RegExp(`kRecordBytes = ${RECORD_BYTES};`))
  for (const [name, bit] of Object.entries(FLAGS)) assert.match(hpp, new RegExp(`${name} = ${bit}[,}]`), name)
  const cpp = readFileSync(new URL('../../cpp-exec/src/tick_recorder.cpp', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')
  assert.match(cpp, /std::memcpy\(out, "TKSG", 4\)/)
  assert.match(cpp, /put32\(out \+ 36, crc32\(out, 36\)\)/)
  assert.match(cpp, /put32\(out \+ 60, crc32\(out, 60\)\)/)
})
