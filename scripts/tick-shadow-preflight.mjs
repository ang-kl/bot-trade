#!/usr/bin/env node
// Read an authenticated GET /state/heartbeats response saved to a file.
// Produces a reviewable Option 2 rollout plan; never contacts or changes a service.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/tick-shadow-preflight.mjs <heartbeats.json>')
  process.exitCode = 2
} else {
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'))
    const runtime = body.runtime
    if (!runtime?.sides || !runtime?.accounts) throw new Error('Input must contain controller runtime evidence from /state/heartbeats')
    const atMs = Date.parse(runtime.at || '')
    const ageMs = Date.now() - atMs
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 360_000) throw new Error('Runtime evidence is absent, future-dated or older than six minutes; fetch it again')
    const live = runtime.sides.find(s => s.service === 'cpp-acct')
    if (!live) throw new Error('Live sidecar evidence is missing')
    const accounts = runtime.accounts.filter(a => a.environment === 'live' && a.enabled)
    const blockers = accounts.flatMap(a => {
      const p = a.protection
      const reasons = []
      if (!p?.hasRun || p.ok !== true || p.stale || p.lastAttemptOk === false) reasons.push('broker protection not freshly verified')
      if (![p?.naked, p?.targetless, p?.phantom, p?.unmatched].every(v => Number.isFinite(v) && v >= 0)) reasons.push('protection counts incomplete')
      if (p?.phantom > 0 || p?.unmatched > 0) reasons.push('broker and position records disagree')
      if (p?.naked > 0) reasons.push(`${p.naked} missing stop(s)`)
      if (p?.targetless > 0) reasons.push(`${p.targetless} missing target(s)`)
      return reasons.map(reason => ({ accountId: a.accountId, reason }))
    })
    if (!accounts.length) blockers.push({ reason: 'No enabled live account represented' })
    if (!live.healthFresh || live.connected !== true) blockers.push({ reason: 'Live sidecar connection not freshly verified' })
    console.log(JSON.stringify({
      mode: 'PREPARE_ONLY', service: 'cpp-acct', observedAt: runtime.at,
      approvalRequired: true, protectionBlockers: blockers,
      currentTickBlock: live.tickBlock,
      change: live.tickBlock === 'unavailable' ? { variable: 'TICK_SPOOL_PATH', proposedValue: '/data/tick' } : null,
      storage: 'Verify the directory is writable and bounded. Shadow can run without durable storage; replay retention requires a volume. Disk reserve must remain enforced.',
      restartEffect: 'Feed interruption and in-memory trailing reset. Confirm broker stops and targets before restarting.',
      verifyAfterRestart: ['Fresh status from both services', 'Live shadow ON and feed timestamps advancing during an open market', 'Entry modes, tick entry account roster and risk gates unchanged', 'Broker SL/TP audit complete for each enabled account'],
      rollback: 'Restore the previous TICK_SPOOL_PATH setting, including unset if originally absent; restart requires the same approval and protection checks.',
    }, null, 2))
    if (blockers.length) process.exitCode = 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
