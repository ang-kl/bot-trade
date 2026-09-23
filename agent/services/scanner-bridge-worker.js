import { parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { publishTimeframeEvaluation } from './scanner-feed.js'
import { startScannerCollector } from './scanner-collector.js'

const db = new Database(workerData.path, { fileMustExist: true, timeout: 1000 })
let chain = Promise.resolve()
parentPort.on('message', job => {
  chain = chain.then(() => publishTimeframeEvaluation(db, job)).catch(() => {}).finally(() => parentPort.postMessage({ completed: true }))
})
startScannerCollector(db)
