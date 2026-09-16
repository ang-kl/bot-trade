// agent/services/tick-segments-worker.js — PR-I, checker B-1: the segment
// sync in a worker thread.
//
// Why a worker at all. The pull is network I/O, but every pulled segment is
// VERIFIED with the real decoder (header CRC, then every record's CRC) and
// that is CPU-bound: measured ~1 s per 64 MiB, ~970-1093 ms for 1.68 M
// records. The first version awaited the pull on the keeper's event loop, so
// `/health` went 0.0009 s → 1.017 s → 0.0006 s across one segment, and a
// bounded sync could stall the loop for tens of seconds in ~1 s blocks — on
// the process that runs the heartbeat, the guard sync and the protection
// sweep. That is PR-H's checker M-1 in a new place.
//
// So the whole sync runs here: listing, pulling, decoding, verifying. The
// keeper's main thread awaits one message. Nothing in this file touches
// SQLite (it is not shared across threads) or any trading path — it writes
// segment files into the cache directory and reports what it did.
import { parentPort, workerData } from 'node:worker_threads'
import { syncFromSidecars } from './tick-segments.js'

const { destDir, sides, secret, timeoutMs, maxBytes, maxSegments } = workerData || {}

syncFromSidecars(destDir, { sides, secret, timeoutMs, maxBytes, maxSegments })
  .then((result) => parentPort.postMessage({ ok: true, result }))
  .catch((err) => parentPort.postMessage({ ok: false, error: err?.message || String(err) }))
