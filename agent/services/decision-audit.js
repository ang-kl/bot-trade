// ---------------------------------------------------------------------------
// agent/services/decision-audit.js — the check AFTER the risk decision.
//
// WHY THIS EXISTS. Owner, 2026-08-03: "no, I cannot help you. you are to
// either program cPP and actively check risk decision after it has been
// completed or suggest another service to do that after risk decision is
// done." The trigger was concrete — the agent had gone a morning without
// entering anything, and answering "why" required a human to paste an
// endpoint's JSON, because nothing in the system asked the question itself.
//
// THE FAILURE CLASS, WHICH THIS REPO HAS NOW HIT THREE TIMES. Every
// controller has a heartbeat, so a loop that STOPS is caught immediately. A
// loop that runs perfectly and achieves nothing is not: it scans, it
// analyses, it decides "no" every time, and every heartbeat beats OK. That is
// indistinguishable from a quiet market. The same shape produced #170 (the
// vol gate answering NORMAL for want of a baseline it never had) and the
// protection audit reading "idle" while nothing was checked. Silence is not
// health, but nothing was measuring the difference.
//
// So this module runs AFTER the risk gate has finished deciding, reads what
// was actually written, and answers two questions the gate itself cannot:
//
//   1. WHAT HAPPENED TO THE PIPELINE — of everything considered this FX day,
//      how much reached the gate, how much the gate approved, and if nothing
//      traded, WHICH stage consumed it. The verdict deliberately distinguishes
//      `no_signal` (scans ran, nothing set up — a legitimate answer) from
//      `blocked` (a gate ate everything — a config answer). Collapsing those
//      two is how a monitor becomes noise.
//
//   2. DID APPROVALS ACTUALLY LAND — an approved risk decision with no trade
//      row behind it is a SILENT DROP: the gate said yes, and nothing
//      happened, and no error was raised. That is the most dangerous state in
//      the system and until now nothing looked for it.
//
// WHY NOT C++. The owner offered the sidecar as the place for this. It is the
// wrong host: `risk_events` and `decision_log` are written by Node and live in
// Node's SQLite file (agent/db.js:287, :368). The C++ engine holds no DB
// handle and receives credentials by push (cpp-exec has no read path to these
// tables at all). Auditing Node's decisions from C++ would mean shipping the
// decision log over HTTP to a process that would have to ship its verdict
// back — two new failure modes for zero benefit. The audit belongs beside the
// data.
//
// NON-NEGOTIABLE: like decision-log.js and position-events.js, nothing here
// throws. An auditor that can break trading is worse than no auditor.
// ---------------------------------------------------------------------------

import { fxDayStartSql } from './risk.js'

/** How long an open market may produce nothing before that is worth saying. */
export const QUIET_ALERT_MIN = Math.max(15, Number(process.env.DECISION_AUDIT_QUIET_MIN) || 90)

/** Terminal readings. Ordered by how much they demand of the reader. */
export const VERDICTS = Object.freeze({
  TRADED: 'traded',
  BLOCKED: 'blocked',
  NO_SIGNAL: 'no_signal',
  SILENT_DROP: 'silent_drop',
  IDLE: 'idle',
})

const int = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/**
 * Group rows to [{key, n}] descending. Small and local on purpose — the
 * shape is the point, and a shared helper would hide it.
 */
function topBy(rows, keyOf, limit = 5) {
  const m = new Map()
  for (const r of rows || []) {
    const k = keyOf(r)
    if (k == null || k === '') continue
    m.set(k, (m.get(k) || 0) + int(r.n ?? 1))
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, n]) => ({ key, n }))
}

/**
 * Audit the decisions the risk gate has ALREADY completed for this FX day.
 *
 * Scoped by account when asked. The scoped-read convention applies —
 * `account_id IS NULL` rows belong to whoever is asking, because they predate
 * per-account stamping and dropping them would understate every window that
 * spans the migration.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{accountId?: string|null, marketOpen?: boolean, now?: Date}} opts
 * @returns {{
 *   verdict: string, because: string, scope: string,
 *   sinceFxDayOpen: boolean, considered: number, reachedGate: number,
 *   approved: number, vetoed: number, tradesOpened: number,
 *   silentDrops: number, topVetoes: Array<{key,n}>, topSkipStages: Array<{key,n}>,
 *   quietMinutes: number|null, at: string,
 * }}
 */
export function auditDecisions(db, { accountId = null, marketOpen = true, now = new Date() } = {}) {
  const at = now.toISOString()
  const scope = accountId == null ? 'all accounts' : `account ${accountId}`
  const blank = {
    verdict: VERDICTS.IDLE, because: 'no decision records for this FX day', scope,
    sinceFxDayOpen: true, considered: 0, reachedGate: 0, approved: 0, vetoed: 0,
    tradesOpened: 0, pendingOrders: 0, placementReceipts: 0, landed: 0,
    silentDrops: 0, topVetoes: [], topSkipStages: [],
    quietMinutes: null, at,
  }

  try {
    // A VALUE, not a SQL fragment — `fxDayStartSql` returns
    // '2026-08-02 21:00:00' and must be BOUND. And every comparison
    // normalises the stored side: `datetime('now')` writes space-separated
    // with no zone, while ISO writers use a 'T', so a raw comparison silently
    // matches nothing. That is the same trap global-guards.js documents.
    const dayStart = fxDayStartSql()
    // The scoped-read convention: NULL account rows are included because they
    // predate per-account stamping, and dropping them would understate every
    // window spanning the migration.
    const acctSql = accountId == null ? '' : ' AND (account_id = ? OR account_id IS NULL)'
    const acctArgs = accountId == null ? [] : [String(accountId)]

    // EVERY upstream decision, including 'proceed'. Filtering to skip/veto
    // here was a real bug caught by this module's own first test run: a
    // pipeline that ran fine and simply found no setup writes only 'proceed'
    // rows, so `considered` came out 0 and a healthy quiet market reported as
    // `idle` — the precise conflation this module exists to prevent. Activity
    // and rejection are different quantities and are now counted separately.
    const upstream = db.prepare(`
      SELECT stage, reason, decision, COUNT(*) AS n
        FROM decision_log
       WHERE REPLACE(created_at, 'T', ' ') >= ?${acctSql}
       GROUP BY stage, reason, decision
    `).all(dayStart, ...acctArgs)
    const skips = upstream.filter(r => r.decision === 'skip' || r.decision === 'veto')

    // risk_events carries no account column, so a per-account view of the
    // GATE is not available and must not be implied. Said in `gateScope`
    // rather than silently returning portfolio numbers under an account
    // heading — the mistake this whole module exists to stop.
    // PLACEMENT RECEIPTS ARE NOT GATE DECISIONS.
    //
    // Found by this module's FIRST production reading, 2026-08-03: it reported
    // "235 approved but only 100 orders — 135 approvals went nowhere", which
    // was wrong. A successfully placed order writes TWO approved risk_events:
    // the gate's own verdict (pending-orders.js:351, closed-market-limits.js:
    // 184) and then a second confirmation row once the broker accepts it
    // (pending-orders.js:442 `pending_order_placed`, closed-market-limits.js:
    // 237 `closed_market_limit_placed`). Subtracting orders from a count that
    // double-counts every success manufactures a silent drop out of a healthy
    // day — the precise false alarm this module must not produce, because an
    // alert that cries wolf is worse than no alert.
    //
    // So receipts are separated out. They are not decisions; they are
    // EVIDENCE that a decision landed, and they are counted as such.
    const gate = db.prepare(`
      SELECT approved, veto_reason,
             CASE WHEN checks_json LIKE '%_placed":true%'
                    OR checks_json LIKE '%_placed": true%' THEN 1 ELSE 0 END AS is_receipt,
             COUNT(*) AS n
        FROM risk_events
       WHERE REPLACE(created_at, 'T', ' ') >= ?
       GROUP BY approved, veto_reason, is_receipt
    `).all(dayStart)

    const placementReceipts = gate
      .filter(r => int(r.approved) === 1 && int(r.is_receipt) === 1)
      .reduce((a, r) => a + int(r.n), 0)
    const approved = gate
      .filter(r => int(r.approved) === 1 && int(r.is_receipt) !== 1)
      .reduce((a, r) => a + int(r.n), 0)
    const vetoed = gate.filter(r => int(r.approved) !== 1).reduce((a, r) => a + int(r.n), 0)
    const reachedGate = approved + vetoed
    const skipped = skips.reduce((a, r) => a + int(r.n), 0)
    // `considered` is EVERYTHING the pipeline looked at — proceeds included.
    // `skipped` is only what it rejected upstream. Keeping these apart is what
    // lets "ran and found nothing" be a different verdict from "ran and was
    // blocked", which is the distinction the whole module turns on.
    const upstreamRows = upstream.reduce((a, r) => a + int(r.n), 0)
    const considered = reachedGate + upstreamRows

    // `opened_at`, not `created_at` — trades has no created_at column, and a
    // query naming one would throw into the catch below and report every day
    // as idle.
    const tradesOpened = int(db.prepare(`
      SELECT COUNT(*) AS n FROM trades
       WHERE REPLACE(opened_at, 'T', ' ') >= ?${acctSql}
    `).get(dayStart, ...acctArgs)?.n)

    // THE SILENT DROP. The gate said yes N times and fewer than N trades
    // exist. Not proof on its own — an approval can legitimately become a
    // pending order rather than a fill — so pending orders count as landed.
    let pending = 0
    try {
      // `placed_at` here — a third table, a third column name. Spelled out
      // because guessing one of these is exactly how this audit would come to
      // report a clean day as a silent drop.
      pending = int(db.prepare(`
        SELECT COUNT(*) AS n FROM pending_orders
         WHERE REPLACE(placed_at, 'T', ' ') >= ?${acctSql}
      `).get(dayStart, ...acctArgs)?.n)
    } catch { pending = 0 }
    // A broker receipt is itself proof the order left the building, so it
    // counts toward landed even if the pending_orders row has since been
    // filled, cancelled or pruned out of the day's window.
    const landed = Math.max(tradesOpened + pending, placementReceipts)
    const silentDrops = Math.max(0, approved - landed)

    const topVetoes = topBy(gate.filter(r => int(r.approved) !== 1), r => r.veto_reason || 'unspecified')
    const topSkipStages = topBy(skips, r => (r.reason ? `${r.stage}:${r.reason}` : r.stage))

    // Minutes since the last thing the pipeline did at all. Null when it has
    // done something recently — a number here is the quiet itself.
    let quietMinutes = null
    try {
      const last = db.prepare(`
        SELECT MAX(t) AS t FROM (
          SELECT MAX(REPLACE(created_at, 'T', ' ')) AS t FROM decision_log
           WHERE REPLACE(created_at, 'T', ' ') >= ?
          UNION ALL
          SELECT MAX(REPLACE(created_at, 'T', ' ')) AS t FROM risk_events
           WHERE REPLACE(created_at, 'T', ' ') >= ?
        )
      `).get(dayStart, dayStart)?.t
      const ms = last ? Date.parse(String(last).replace(' ', 'T') + 'Z') : NaN
      if (Number.isFinite(ms)) quietMinutes = Math.max(0, Math.round((now.getTime() - ms) / 60_000))
    } catch { quietMinutes = null }

    if (considered === 0 && tradesOpened === 0) {
      return { ...blank, quietMinutes, because: marketOpen
        ? 'market open, but the pipeline recorded no decisions this FX day'
        : 'market closed — no decisions expected' }
    }

    // Verdict, most serious first. A silent drop outranks everything: it means
    // the gate approved and nothing happened, which no other reading covers.
    let verdict, because
    if (silentDrops > 0) {
      verdict = VERDICTS.SILENT_DROP
      because = `${approved} approved at the gate but only ${landed} order(s)/trade(s) exist — ${silentDrops} approval(s) went nowhere`
    } else if (landed > 0) {
      verdict = VERDICTS.TRADED
      because = `${landed} order(s)/trade(s) from ${approved} approval(s)`
    } else if (reachedGate > 0) {
      verdict = VERDICTS.BLOCKED
      // guardName, not the raw reason: `because` is published verbatim in the
      // PUBLIC projection, and reasons carry prices, sizes, order ids and raw
      // error text. Caught by decision-audit.test.js, which found "0.42" from
      // `below_min_volume: 0.42 lots` sitting in the public body after the
      // topVetoes list had already been sanitised. The full reason is still
      // available in `topVetoes` for Telegram and the logs, which are
      // owner-only.
      because = `${vetoed} proposal(s) reached the risk gate and every one was vetoed — top reason: ${guardName(topVetoes[0]?.key) || 'unspecified'}`
    } else if (skipped > 0) {
      // Nothing even reached the gate. THIS is the config answer, and naming
      // the dominant stage is the whole value — "why didn't it trade" becomes
      // one string instead of a log dig.
      verdict = VERDICTS.BLOCKED
      because = `nothing reached the risk gate — ${skipped} decision(s) stopped upstream, dominant stage: ${publicKey(topSkipStages[0]?.key) || 'unknown'}`
    } else {
      verdict = VERDICTS.NO_SIGNAL
      because = 'scans ran and no setup qualified — not a blocked gate'
    }

    return {
      verdict, because, scope, sinceFxDayOpen: true,
      considered, reachedGate, approved, vetoed,
      tradesOpened, pendingOrders: pending, placementReceipts, landed,
      silentDrops, topVetoes, topSkipStages, quietMinutes, at,
      // Stated, not implied: risk_events has no account column, so gate
      // numbers are portfolio-wide even when the skip numbers are scoped.
      gateScope: 'all accounts (risk_events carries no account column)',
    }
  } catch (err) {
    // An auditor that throws would take down the loop phase it runs in. It
    // reports its own failure instead, which is still more than silence.
    return { ...blank, verdict: VERDICTS.IDLE, because: `audit failed: ${err?.message || err}` }
  }
}

/**
 * Should this reading interrupt the owner?
 *
 * Deliberately narrow. A monitor that fires on every quiet hour teaches the
 * owner to ignore it, and then the one time it matters it looks the same as
 * the 200 times it did not — the lesson already written into
 * heartbeat.js's stall alerting.
 */
export function shouldAlert(audit, { marketOpen = true, quietAlertMin = QUIET_ALERT_MIN } = {}) {
  if (!audit) return null
  // A silent drop is always worth waking someone for, market open or not.
  if (audit.verdict === VERDICTS.SILENT_DROP) {
    return { level: 'error', text: `Silent drop: ${audit.because}` }
  }
  if (!marketOpen) return null
  if (audit.verdict === VERDICTS.BLOCKED && audit.considered > 0) {
    return { level: 'warn', text: `Nothing traded: ${audit.because}` }
  }
  if (audit.verdict === VERDICTS.IDLE && (audit.quietMinutes ?? 0) >= quietAlertMin) {
    return { level: 'warn', text: `Pipeline quiet for ${audit.quietMinutes}m with the market open — no decisions recorded at all` }
  }
  return null
}

/**
 * Reduce a free-text reason to its structural IDENTIFIER — the guard or rule
 * name — discarding everything after it.
 *
 * THIS IS A SECURITY BOUNDARY, not a formatting nicety. Reasons are written
 * with template literals and routinely carry live trading detail:
 *
 *   `below_min_volume: ${volLots} lots`                    (a SIZE)
 *   `pending_invalidated: close ${close} beyond SL ${row.sl} — order ${id}…`
 *                                        (two PRICES and a broker ORDER ID)
 *   `sizing_failed: ${err.message}`                        (arbitrary text)
 *
 * The public /health projection promises counts and names only. Passing a raw
 * reason through would break that promise the first time one of these fired —
 * and the `topBlock` field shipped in #571 had exactly that exposure through
 * decision_log.reason before this existed.
 *
 * So: keep the leading identifier, drop the rest. Anything that is not a plain
 * identifier character ends the name, and the result is capped. A reason that
 * begins with detail rather than a name yields '' and is omitted entirely
 * rather than being half-published.
 */
export function guardName(reason) {
  const m = String(reason ?? '').trim().match(/^[A-Za-z][A-Za-z0-9_-]{0,63}/)
  return m ? m[0] : ''
}

/**
 * The counts-only projection safe to expose WITHOUT authentication.
 *
 * /health's unauthenticated subset is deliberately minimal and its comment
 * warns that anything new defaults to authenticated. This is the explicit
 * exception, and it is drawn narrowly: verdict, stage NAMES, and counts.
 * No symbol, no side, no price, no volume, no P&L, no balance, no account id.
 * A reader learns that the pipeline is stuck and which stage owns it — the
 * same class of operational fact as `status` and `uptime`, which are already
 * public — and learns nothing about what is being traded or with how much.
 */
export function publicPipelineView(audit) {
  if (!audit) return null
  return {
    verdict: audit.verdict,
    because: audit.because,
    considered: audit.considered,
    reachedGate: audit.reachedGate,
    approved: audit.approved,
    vetoed: audit.vetoed,
    trades: audit.tradesOpened,
    pending: audit.pendingOrders,
    landed: audit.landed,
    silentDrops: audit.silentDrops,
    // Stage names and guard names only, each reduced to its identifier by
    // guardName(). `topSkipStages` keys are "stage:reason" — the stage is
    // already a bare identifier, and the reason is sanitised before it joins.
    topBlock: publicKey(audit.topSkipStages?.[0]?.key) || publicKey(audit.topVetoes?.[0]?.key) || null,
    // RE-AGGREGATE AFTER SANITISING. Sanitising maps many raw reasons onto one
    // guard name — `overexposed_USD: 3 of 3` and `overexposed_USD: 2 of 2`
    // both become `overexposed_USD` — so a straight map leaves the SAME guard
    // listed twice with its count split. The first live reading showed exactly
    // that: overexposed_USD at 138 and again at 18, understating it as 138
    // when it was really 156, and burning a slot that a fifth distinct guard
    // should have had. Merge, then re-sort, then take the top five.
    topVetoes: Object.entries(
      (audit.topVetoes || []).reduce((acc, v) => {
        const g = guardName(v.key)
        if (g) acc[g] = (acc[g] || 0) + (Number(v.n) || 0)
        return acc
      }, {}),
    ).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([guard, n]) => ({ guard, n })),
    quietMinutes: audit.quietMinutes,
    at: audit.at,
  }
}

/** "stage:free text with a price in it" -> "stage:guard_name". */
function publicKey(key) {
  if (!key) return null
  const [stage, ...rest] = String(key).split(':')
  const s = guardName(stage)
  if (!s) return null
  const r = guardName(rest.join(':'))
  return r ? `${s}:${r}` : s
}

/** One-line text for Telegram / logs. */
export function toText(audit) {
  if (!audit) return 'no audit'
  const bits = [
    `verdict ${audit.verdict}`,
    audit.because,
    `considered ${audit.considered} · gate ${audit.reachedGate} (${audit.approved} ok / ${audit.vetoed} veto) · landed ${audit.landed} (${audit.tradesOpened} trade(s), ${audit.pendingOrders} pending)`,
  ]
  if (audit.topSkipStages?.length) bits.push(`upstream: ${audit.topSkipStages.map(s => `${s.key} ${s.n}`).join(', ')}`)
  if (audit.topVetoes?.length) bits.push(`vetoes: ${audit.topVetoes.map(s => `${s.key} ${s.n}`).join(', ')}`)
  return bits.join('\n')
}
