// agent/services/tick-research.js — P4: the trial ledger (plan §6, §7).
// A trial is one replay run: strategy id + version + profile hash, the data
// manifest (which segments, how many events, decoder version), the cost
// and latency assumptions, and the results per chronological block. Every
// run is recorded, including failures — the ledger is what the evidence
// importer (P6) and the owner judge, and a run that was never written
// cannot be judged.
import { createHash } from 'node:crypto'

export function trialIdFor(trial) {
  const canon = JSON.stringify({ p: trial.profileHash, m: trial.manifest, s: trial.sim })
  return createHash('sha256').update(canon).digest('hex').slice(0, 20)
}

/** Insert (or ignore, when the same trial exists) one trial from a replay result. */
export function importTickTrial(db, trial, { note = null } = {}) {
  for (const k of ['strategyId', 'strategyVersion', 'profileHash', 'params', 'sim', 'manifest', 'summary', 'blocks']) {
    if (trial[k] == null) return { ok: false, reason: `missing ${k}` }
  }
  const trialId = trial.trialId || trialIdFor(trial)
  const r = db.prepare(`INSERT OR IGNORE INTO tick_trials (trial_id, strategy_id, version, profile_hash, params_json, sim_json, manifest_json, summary_json, blocks_json, note)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(trialId, String(trial.strategyId), String(trial.strategyVersion), String(trial.profileHash), JSON.stringify(trial.params), JSON.stringify(trial.sim), JSON.stringify(trial.manifest), JSON.stringify(trial.summary), JSON.stringify(trial.blocks), note)
  return { ok: true, trialId, inserted: r.changes === 1 }
}

/** The ledger for GET /state/tick-research: newest first, parsed. */
export function tickTrialsView(db, { limit = 50 } = {}) {
  let rows = []
  try { rows = db.prepare('SELECT * FROM tick_trials ORDER BY id DESC LIMIT ?').all(limit) } catch { rows = [] }
  const trials = rows.map(r => ({
    trialId: r.trial_id, at: r.at, strategyId: r.strategy_id, version: r.version, profileHash: r.profile_hash,
    params: JSON.parse(r.params_json), sim: JSON.parse(r.sim_json), manifest: JSON.parse(r.manifest_json),
    summary: JSON.parse(r.summary_json), blocks: JSON.parse(r.blocks_json), note: r.note,
  }))
  const byProfile = {}
  for (const t of trials) {
    const validation = t.blocks.find(b => b.name === 'validation') || null
    const test = t.blocks.find(b => b.name === 'test') || null
    // AUDIT 11-09-2026 (plan §7): the test block is WITHHELD on a research
    // trial (blocks[test].withheld); only a trial run with includeTest —
    // the owner's confirmation run — carries test figures, and the profile
    // row says how many of its trials were of which kind.
    byProfile[t.profileHash] ??= { profileHash: t.profileHash, trials: 0, params: t.params, validationTrades: 0, validationNetR: 0, testTrials: 0, testWithheld: 0, testTrades: 0, testNetR: 0 }
    const row = byProfile[t.profileHash]
    row.trials++
    if (validation && validation.trades != null) { row.validationTrades += validation.trades; row.validationNetR = +(row.validationNetR + (validation.netR || 0)).toFixed(4) }
    if (test && test.withheld) row.testWithheld++
    else if (test && test.trades != null) { row.testTrials++; row.testTrades += test.trades; row.testNetR = +(row.testNetR + (test.netR || 0)).toFixed(4) }
  }
  return {
    at: new Date().toISOString(), trials, profiles: Object.values(byProfile),
    note: 'P4: research trials only — no profile here is approved for trading; acceptance (plan §7) needs out-of-sample expectancy with an interval on independent blocks, cost and parameter-neighbourhood robustness, and the multiple-testing adjustment, judged by the owner before P6 imports evidence.',
  }
}
