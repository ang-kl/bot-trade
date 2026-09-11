// agent/services/tick-research-worker.js — PR-H: the CPU-bound half of the
// research action in a worker thread (checker M-1: the decode + sims
// blocked the keeper's event loop for tens of seconds). Receives the files,
// the normalised plan and the replay thresholds; posts back the replayed
// trials with their verdicts. No database here — the import happens on
// the main thread.
import { parentPort, workerData } from 'node:worker_threads'
import { replayFiles } from './tick-research-run.js'

try {
  const replayed = replayFiles(workerData.files, workerData.plan, workerData.replay)
  parentPort.postMessage({ ok: true, replayed })
} catch (err) {
  parentPort.postMessage({ ok: false, error: err?.message || String(err) })
}
