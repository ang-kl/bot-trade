import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { publishTimeframeEvaluation, scannerRequest } from './scanner-feed.js'
import { pollScannerMirrors } from './scanner-candidates.js'
import { TickComparisonReader, retainComparisons } from './scanner-comparison.js'
import { setState } from '../db.js'

const db = new Database(workerData.path, { fileMustExist: true, timeout: 1000 })
const tick = new TickComparisonReader()
let chain = Promise.resolve(), polling = false
parentPort.on('message', job => {
  chain = chain.then(() => publishTimeframeEvaluation(db, job)).catch(() => {}).finally(() => parentPort.postMessage({ completed: true }))
})
async function poll() {
  if (polling) return
  polling = true
  try {
    retainComparisons(db)
    const mirrors = await pollScannerMirrors(db)
    if (process.env.SCANNER_TICK_URL && process.env.SCANNER_TICK_SECRET) {
      const deadline = Date.now() + 4000
      for (let pages = 0; pages < 32 && Date.now() < deadline; pages++) {
        let page = await scannerRequest(process.env.SCANNER_TICK_URL, process.env.SCANNER_TICK_SECRET, `/comparisons?after=${tick.after}`)
        if (tick.instance && page.instanceId !== tick.instance) page = await scannerRequest(process.env.SCANNER_TICK_URL, process.env.SCANNER_TICK_SECRET, '/comparisons?after=0')
        tick.consume(db, page)
        if (tick.after >= page.latestCursor || !page.candidates.length) break
      }
    }
    setState(db, 'scanner_bridge_poll_json', JSON.stringify({ readAtMs: Date.now(), mirrors, tickCursor: tick.after, orderAuthority: false }))
  } catch { setState(db, 'scanner_bridge_poll_json', JSON.stringify({ readAtMs: Date.now(), error: 'comparison_read_or_contract_failed', orderAuthority: false })) }
  finally { polling = false }
}
setInterval(poll, 15_000); poll()
