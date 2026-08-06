#!/usr/bin/env node
// ---------------------------------------------------------------------------
// agent/scripts/exit-counterfactual.mjs — run Phase 7 and print the table.
//
//   node agent/scripts/exit-counterfactual.mjs
//   node agent/scripts/exit-counterfactual.mjs --days 14 --min-sample 50
//   node agent/scripts/exit-counterfactual.mjs --all-origins   # NOT edge evidence
//   node agent/scripts/exit-counterfactual.mjs --json
//
// READ-ONLY. It opens the database, reads closed trades and their stored bar
// windows, and writes nothing. There is no --apply because there is nothing to
// apply: this measures, it does not change a rule.
//
// --all-origins exists for diagnosing the harness itself (is the replay working
// at all?) and is labelled in the output as NOT evidence of strategy edge, per
// the repair prompt. Do not quote a number produced under it.
// ---------------------------------------------------------------------------

import { initDB } from '../db.js'
import { exitCounterfactual, MIN_SAMPLE } from '../services/exit-counterfactual.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1 || i + 1 >= argv.length) return fallback
  const n = Number(argv[i + 1])
  return Number.isFinite(n) ? n : fallback
}

const db = initDB(process.env.AGENT_DB || 'agent.db')
const report = exitCounterfactual(db, {
  days: opt('days', 30),
  minSample: opt('min-sample', MIN_SAMPLE),
  cleanOnly: !flag('all-origins'),
})

if (flag('json')) {
  console.log(JSON.stringify(report, null, 2))
  process.exit(0)
}

const pad = (s, n) => String(s ?? '—').padEnd(n)
const rpad = (s, n) => String(s ?? '—').padStart(n)

console.log(`\nEXIT COUNTERFACTUAL — ${report.days}d, ${report.cleanOnly ? 'clean bot origins only' : 'ALL ORIGINS (not edge evidence)'}`)
console.log(`${report.considered} closed trade(s) considered, ${report.eligible} replayable.`)
console.log(`skipped: ${JSON.stringify(report.skipped)}`)

if (report.verdict === 'INSUFFICIENT') {
  console.log(`\n${report.note}\n`)
  process.exit(0)
}

console.log('')
console.log(`${pad('rule', 16)}${rpad('usable', 7)}${rpad('win%', 7)}${rpad('PF', 8)}${rpad('expR', 8)}${rpad('totR', 9)}${rpad('holdMin', 8)}${rpad('ambig', 7)}${rpad('trunc', 7)}`)
console.log('-'.repeat(76))
if (report.actual) {
  const a = report.actual
  console.log(`${pad('AS RECORDED', 16)}${rpad(a.usable, 7)}${rpad(a.winRate, 7)}${rpad(a.profitFactor, 8)}${rpad(a.expectancyR, 8)}${rpad(a.totalR, 9)}${rpad('—', 8)}${rpad('—', 7)}${rpad('—', 7)}`)
}
for (const r of report.rules) {
  const thin = r.usable < report.minSample ? ' *' : ''
  console.log(`${pad(r.rule + thin, 16)}${rpad(r.usable, 7)}${rpad(r.winRate, 7)}${rpad(r.profitFactor, 8)}${rpad(r.expectancyR, 8)}${rpad(r.totalR, 9)}${rpad(r.medianHoldMin, 8)}${rpad(r.ambiguous, 7)}${rpad(r.truncated, 7)}`)
}
console.log(`\n* below the ${report.minSample}-trade floor — read as illustrative, not as a result.`)
console.log('ambig = one bar touched both stop and target; intrabar order is unknown and NOT assumed.')
console.log('trunc = the rule was still holding when the stored bar window ended; no exit invented.\n')
