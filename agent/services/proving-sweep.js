// ---------------------------------------------------------------------------
// agent/services/proving-sweep.js — armed strategies must EARN their arming.
//
// The advisories kept saying "ARMED but unproven — never backtested, no
// backtest GO on record" (vwap_trend, rsi_meanrev, fib_confluence, …) and
// nothing acted on it. This sweep does: once per day per strategy, any ARMED
// strategy with NO backtest baseline on record gets a GO backtest queued
// through the agent's own /actions/backtest route (self-call with the master
// secret — the same code path the Tune button uses, so results persist into
// backtest_baselines_json exactly like a manual run and the advisory clears
// itself when the strategy proves out).
//
// One at a time (backtest jobs are heavy); skipped entirely while another
// job runs. Attempts are stamped so a failing strategy is retried at most
// daily, never hammered.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { enabledStrategies } from './strategies.js'

const DAY_MS = 86_400_000

/** Pick the next armed strategy needing proof: no baseline + no fresh attempt. */
export function pickUnprovenStrategy(db, now = Date.now()) {
  const armed = enabledStrategies(db, getState).map(s => s.key)
  let baselines = {}
  try { baselines = JSON.parse(getState(db, 'backtest_baselines_json') || '{}') || {} } catch { baselines = {} }
  let attempts = {}
  try { attempts = JSON.parse(getState(db, 'proving_attempts_json') || '{}') || {} } catch { attempts = {} }
  return armed.find(k => !baselines[k] && (!(attempts[k] > 0) || now - attempts[k] > DAY_MS)) || null
}

/**
 * Queue a proving backtest for one unproven armed strategy, if any and if no
 * backtest job is already running. Best-effort — a failure stamps the attempt
 * so the next try is tomorrow, and never throws into the loop.
 */
export async function runProvingSweep(db, {
  fetchImpl = fetch,
  port = process.env.PORT || '3001',
  secret = process.env.AGENT_SECRET,
  now = Date.now(),
} = {}) {
  const candidate = pickUnprovenStrategy(db, now)
  if (!candidate) return { queued: null }

  const { currentJob } = await import('./backtest-job.js')
  const job = currentJob()
  if (job && job.status === 'running') return { queued: null, reason: 'job_running' }
  if (!secret) return { queued: null, reason: 'no_secret' }

  // Stamp BEFORE the call — a crashing backtest must not retry every loop.
  let attempts = {}
  try { attempts = JSON.parse(getState(db, 'proving_attempts_json') || '{}') || {} } catch { attempts = {} }
  attempts[candidate] = now
  setState(db, 'proving_attempts_json', JSON.stringify(attempts))

  const res = await fetchImpl(`http://127.0.0.1:${port}/actions/backtest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ strategy: candidate, timeframes: ['4h', '1d'] }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { queued: null, reason: `backtest_call_${res.status}: ${String(body).slice(0, 120)}` }
  }
  return { queued: candidate }
}
