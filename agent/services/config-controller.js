// ---------------------------------------------------------------------------
// agent/services/config-controller.js — C-1. Watch the settings against what
// the record says, and PROPOSE. Never write.
//
// WHY (owner, §5490·C·1 → "controller to monitor and adjust"; propose-only
// confirmed at §5496·C):
//
// On 2026-08-04, `minRR` was 1.5 on every account while two of them were
// running win rates of 34.4% and 38.6%. At a 34.4% win rate a 1.5 reward:risk
// yields an expected profit factor of 1.5 × 34.4/65.6 = 0.79 — the entry gate
// was approving trades that lose money in expectation, and the two accounts
// landed at PF 0.90 and 1.04, almost exactly where that arithmetic puts them.
//
// Every input to that finding was already in the database and had been for
// weeks. Nothing asked the question. That is what this is for.
//
// IT PROPOSES AND STOPS. The owner's reasoning, and mine: the two days before
// this was written turned up two silent write-path defects — a gate reading a
// different account's book (#627) and a management layer closing positions at
// zero R (#628). An auto-adjusting controller sitting on top of that would
// have been adjusting off numbers that were wrong about which account they
// described. Confidence in the measurement has to come first, and it has to be
// earned in public, which means proposals a human reads.
//
// EVERY PROPOSAL CARRIES ITS ARITHMETIC. Not "raise minRR to 3.2" but "this
// account wins 34.4% of the time; at that rate you need a payoff above 1.91 to
// break even and 3.20 to reach the 1.68 target; it is set to 1.5". A number
// without its derivation is something to obey or ignore, and both are wrong.
//
// AND IT REFUSES ON A THIN SAMPLE. `minSample` exists because the most
// dangerous thing a controller like this can do is turn a fortnight of variance
// into a permanent setting. §69.7.9 says it outright: prevent automatic risk
// expansion from weak samples. A proposal that cannot meet the sample bar is
// not silently dropped — it is reported as `insufficient_sample`, so the
// absence of advice is visible rather than looking like approval.
// ---------------------------------------------------------------------------

import { loadRiskConfig, DEFAULT_RISK_CONFIG, getAccountBalance } from './risk.js'

/** Trades required before this controller will say anything about an account. */
export const MIN_SAMPLE = 30

/** The profit factor the desk is aiming at (§70, owner's go-live gate). */
export const TARGET_PF = 1.68

/**
 * Closed-trade economics for one account.
 *
 * Uses net_pnl only — a trade whose realised P&L never filled is UNKNOWN, and
 * counting it as a zero-value loss would drag the win rate down and the payoff
 * with it. Same rule as everywhere else in this codebase; here it matters more
 * than usual because the output is a recommendation about real money.
 */
export function accountEconomics(db, accountId, { days = 30 } = {}) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT net_pnl FROM trades
       WHERE status = 'closed' AND net_pnl IS NOT NULL
         AND (account_id = ? OR account_id IS NULL)
         AND closed_at >= datetime('now', ?)
    `).all(String(accountId), `-${Math.max(1, Math.round(days))} days`)
  } catch { return null }

  const wins = rows.filter(r => r.net_pnl > 0).map(r => r.net_pnl)
  const losses = rows.filter(r => r.net_pnl <= 0).map(r => -r.net_pnl)
  if (!rows.length) return { trades: 0, wins: 0, losses: 0, winRate: null, avgWin: null, avgLoss: null, payoff: null, profitFactor: null }

  const sum = (a) => a.reduce((s, n) => s + n, 0)
  const avgWin = wins.length ? sum(wins) / wins.length : null
  const avgLoss = losses.length ? sum(losses) / losses.length : null
  const winRate = rows.length ? wins.length / rows.length : null
  return {
    trades: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    // Both null-safe: an account with no losses yet has no payoff ratio, and
    // reporting Infinity as though it were a measurement would be worse than
    // reporting that we cannot say.
    payoff: avgWin != null && avgLoss ? avgWin / avgLoss : null,
    profitFactor: losses.length && sum(losses) > 0 ? sum(wins) / sum(losses) : null,
  }
}

/**
 * The payoff a strategy must average to reach a target profit factor at a
 * given win rate.
 *
 *   PF = payoff × wins / losses   →   payoff = PF × (1 − w) / w
 *
 * At PF = 1 this is the breakeven payoff. Returns null for a win rate of 0 or
 * 1 — neither has a finite answer, and inventing one is how a controller ends
 * up recommending an infinite reward:risk off a four-trade sample.
 */
export function requiredPayoff(winRate, targetPf = TARGET_PF) {
  const w = Number(winRate)
  if (!Number.isFinite(w) || w <= 0 || w >= 1) return null
  return targetPf * (1 - w) / w
}

/**
 * The rules. Each returns a proposal or null.
 *
 * A rule is a function of MEASURED economics and the CURRENT config, and it
 * says what it would change, to what, and why — in numbers the reader can
 * check. Adding a rule here should feel like writing down something you would
 * otherwise have had to notice by eye.
 */
export const RULES = Object.freeze([
  {
    key: 'minRR_below_breakeven',
    /**
     * The finding that prompted this whole module. A reward:risk floor below
     * the breakeven payoff for the account's own win rate is a gate that
     * approves losing trades — not as a matter of luck, as arithmetic.
     */
    evaluate({ econ, config }) {
      const rr = Number(config.minRR)
      const breakeven = requiredPayoff(econ.winRate, 1)
      const forTarget = requiredPayoff(econ.winRate, TARGET_PF)
      if (!Number.isFinite(rr) || breakeven == null) return null
      if (rr >= forTarget) return null

      const severity = rr < breakeven ? 'danger' : 'warn'
      return {
        setting: 'minRR',
        current: rr,
        proposed: Math.round(forTarget * 100) / 100,
        severity,
        why: [
          `${(econ.winRate * 100).toFixed(1)}% win rate over ${econ.trades} closed trades.`,
          `At that rate a trade must average ${breakeven.toFixed(2)}× its risk just to break even,`,
          `and ${forTarget.toFixed(2)}× to reach the ${TARGET_PF} profit-factor target.`,
          `minRR is ${rr}.`,
          rr < breakeven
            ? `That is BELOW breakeven: the gate is approving trades that lose money in expectation.`
            : `That clears breakeven but cannot reach the target.`,
          `Measured payoff is currently ${econ.payoff == null ? 'unknown' : econ.payoff.toFixed(2)}×, profit factor ${econ.profitFactor == null ? 'unknown' : econ.profitFactor.toFixed(2)}.`,
        ].join(' '),
        expect: 'Fewer entries. Each one carries enough planned reward to survive this win rate.',
      }
    },
  },
  {
    key: 'expectancy_override_on',
    /**
     * The override lets a proposal through when Kelly has sized it to zero —
     * i.e. when the strategy's own record says it loses. Raising minRR while
     * this is on fixes one gate and leaves the other open.
     */
    evaluate({ config }) {
      if (!config.allowNegativeExpectancyOverride) return null
      return {
        setting: 'allowNegativeExpectancyOverride',
        current: true,
        proposed: false,
        severity: 'warn',
        why: 'This admits trades whose own measured record says they have negative expectancy (risk.js: Kelly sized them to zero). It works against any reward:risk floor you set.',
        expect: 'Strategies with a losing record stop trading until their record improves.',
      }
    },
  },
  {
    key: 'kelly_sample_too_thin',
    /**
     * Only interesting once the override is OFF: with it on, the sample size
     * changes nothing because the veto never fires. Stated as a rule rather
     * than a footnote so the two knobs are visibly coupled.
     */
    evaluate({ config }) {
      const n = Number(config.minTradesForKelly)
      if (config.allowNegativeExpectancyOverride) return null
      if (!Number.isFinite(n) || n >= 30) return null
      return {
        setting: 'minTradesForKelly',
        current: n,
        proposed: 30,
        severity: 'warn',
        why: `With the negative-expectancy override OFF, a strategy can now be vetoed on a ${n}-trade sample. That is thin enough to switch off a working strategy on variance.`,
        expect: 'Fewer false expectancy vetoes; a strategy must show a real losing record before it is stood down.',
      }
    },
  },
  {
    key: 'daily_cap_smaller_than_one_loss',
    /**
     * A cap below the size of a single average loss stops the account for the
     * day on its first ordinary trade. Measured, not assumed: 4,717 vetoes in
     * one week from a $16.16 cap on 43097342.
     */
    evaluate({ econ, config, balance }) {
      const pct = Number(config.dailyLossPct)
      if (!Number.isFinite(pct) || !(pct > 0) || !(balance > 0)) return null
      if (econ.avgLoss == null || !(econ.avgLoss > 0)) return null
      const capUsd = balance * pct
      if (capUsd >= econ.avgLoss * 2) return null
      return {
        setting: 'dailyLossPct',
        current: pct,
        proposed: Math.round((econ.avgLoss * 4 / balance) * 1000) / 1000,
        severity: 'danger',
        why: `The daily cap is ${capUsd.toFixed(2)} against an average loss of ${econ.avgLoss.toFixed(2)}. One ordinary losing trade stops the account for the day.`,
        expect: 'The cap becomes a brake on a bad day rather than on a normal one.',
      }
    },
  },
])

/**
 * Proposals for one account.
 *
 * @returns {{ accountId, econ, sampleOk, proposals: [], skipped: string|null }}
 */
export function proposeForAccount(db, accountId, { days = 30, minSample = MIN_SAMPLE, balance = null } = {}) {
  const econ = accountEconomics(db, accountId, { days })
  const config = loadRiskConfig(db, accountId) || DEFAULT_RISK_CONFIG

  if (!econ || econ.trades < minSample) {
    // Reported, not dropped. An absent proposal must not look like approval —
    // §69.7.9's "no automatic risk expansion from weak samples" cuts both ways.
    return {
      accountId: String(accountId),
      econ,
      sampleOk: false,
      proposals: [],
      skipped: `insufficient_sample: ${econ?.trades ?? 0} closed trades with realised P&L in ${days}d, need ${minSample}`,
    }
  }

  const proposals = []
  for (const rule of RULES) {
    let p = null
    try { p = rule.evaluate({ econ, config, balance }) } catch { p = null }
    if (p) proposals.push({ rule: rule.key, ...p })
  }
  return { accountId: String(accountId), econ, sampleOk: true, proposals, skipped: null }
}

/**
 * Every enabled account, worst first.
 *
 * DELIBERATELY NOT the LIVE account by default. A controller's first published
 * opinion should not be about the account that can lose real money, and
 * `includeLive` makes reading it a decision rather than a default.
 */
export function configProposals(db, { days = 30, minSample = MIN_SAMPLE, includeLive = false } = {}) {
  let rows = []
  try {
    rows = db.prepare('SELECT account_id, is_live, enabled FROM accounts ORDER BY account_id').all()
  } catch { return { accounts: [], proposals: 0, at: new Date().toISOString() } }

  const out = []
  for (const r of rows) {
    if (!includeLive && r.is_live === 1) continue
    if (r.enabled !== 1) continue
    // Balance comes from risk.js's own resolver so the daily-cap arithmetic
    // below sizes off the same number the cap itself uses. A controller that
    // computed its own balance could recommend a cap against a figure the cap
    // never sees.
    let balance = null
    try { balance = getAccountBalance(db, r.account_id) } catch { balance = null }
    out.push(proposeForAccount(db, r.account_id, { days, minSample, balance }))
  }
  out.sort((a, b) => b.proposals.length - a.proposals.length)
  return {
    accounts: out,
    proposals: out.reduce((n, a) => n + a.proposals.length, 0),
    // Named so a reader knows what this did NOT look at.
    scope: { days, minSample, includeLive, note: includeLive ? null : 'live accounts excluded — pass includeLive to see them' },
    at: new Date().toISOString(),
  }
}
