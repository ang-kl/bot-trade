#!/usr/bin/env node
// Live, READ-ONLY acceptance for the stop-loss policy (02-10-2026, PR-3).
// GETs the agent's state routes with the read secret and grades them with
// agent/lib/stop-loss-grader.js. It calls nothing under /actions, places,
// amends or cancels nothing, and prints no secret and no full account id.
//
//   AGENT_URL=https://… AGENT_SECRET_READ=… node scripts/verify-stop-loss-integrated.mjs [--baseline file.json]
//
// --baseline: if the file is absent it is written (take-profit by account and
// position); if present, take-profit levels are compared against it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { gradeStopLoss, targetSnapshot } from '../agent/lib/stop-loss-grader.js'

const base = (process.env.AGENT_URL || 'https://sg-trade.up.railway.app').replace(/\/$/, '')
const secret = process.env.AGENT_SECRET_READ
if (!secret) { console.error('AGENT_SECRET_READ is not set'); process.exit(2) }
const bi = process.argv.indexOf('--baseline')
const baselinePath = bi > 0 ? process.argv[bi + 1] : null

async function get(path) {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`${path} answered ${r.status}`)
  return r.json()
}
const [policy, maeChandelier, heartbeats] = await Promise.all([
  get('/state/stop-policy').catch(e => { console.error(e.message); return null }),
  get('/state/mae-chandelier').catch(e => { console.error(e.message); return null }),
  get('/state/heartbeats').catch(e => { console.error(e.message); return null }),
])
let baselineTp = null
if (baselinePath && existsSync(baselinePath)) baselineTp = JSON.parse(readFileSync(baselinePath, 'utf8'))
const result = gradeStopLoss({ policy, maeChandelier, heartbeats, baselineTp })
if (baselinePath && !baselineTp && heartbeats) { writeFileSync(baselinePath, JSON.stringify(targetSnapshot(heartbeats), null, 1)); console.log(`baseline written to ${baselinePath}`) }
for (const c of result.checks) console.log(`${c.verdict.padEnd(15)} ${c.id.padEnd(20)} ${c.detail}`)
console.log(`\nOVERALL ${result.verdict}`)
process.exit(result.verdict === 'FAIL' ? 1 : 0)
