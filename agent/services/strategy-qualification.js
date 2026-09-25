// ---------------------------------------------------------------------------
// agent/services/strategy-qualification.js — bar-side qualification, REPORT
// ONLY (V3 Q4b / PR-B1; plan P6/P7; owner decisions D1–D3,
// docs/dual-environment-plan-2026-09-25.md).
//
// THE QUESTION. The evidence gate (evidence-gate.js) and the 30-close
// verdict (strategy-verdicts.js) judge a strategy on one account over a
// rolling window: 30 closes at PF ≥ 1.5 in money. Two things were not
// visible anywhere: what that record reads in R (D1), and whether 30 closes
// can ARRIVE inside the window at the rate the strategy actually closes —
// failure mode #3, a bar whose trigger never arrives keeps a restored
// strategy pending at half risk for ever. This report answers both, per
// strategy × enabled account, and pooled across accounts with copies of one
// signal counted once (docs/tick-momentum/plan.md §7: "copies of the same
// signal across accounts are correlated exposure, not independent
// samples").
//
// NOTHING GATES ON IT. No gate, verdict, bar, cap or threshold reads these
// figures. The population, the bar (minCloses) and the window (windowDays)
// are READ from the evidence gate — never copied — and every cell is
// reconciled against evidenceRecord, the gate's own reader, so a report that
// drifts from what the gate judges says so (`reconciled: false`). Moving a
// gate to R, to since-pin counting or to copies-once is the owner's
// decision (H-P6-7).
//
// CLOSED WINDOWS (D3). The rolling window has no closed windows, and trade
// rows are rewritten after close (the pnl backfill, reconcileTradePrices-
// ToBroker — failure mode #6). So the fixed record is kept separately: UTC
// calendar months, fixed by the calendar before any trade lands, sealed
// into `qualification_windows` on the first report read after the month
// closes. The table is append-only (SQLite triggers refuse UPDATE and
// DELETE). A later read that finds a sealed month's figures moved appends a
// RESTATEMENT beside the sealed row; the sealed row itself never changes,
// and the report shows both. Stored figures are raw counts and sums; the
// bar is applied when they are shown, so an owner change to minCloses moves
// the presentation, never the record.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import { getState } from '../db.js'
import { wilsonInterval } from '../lib/tick-replay-sim.js'
import { evidenceRecord, evidenceRows, loadEvidenceGate } from './evidence-gate.js'
import { isHandPinned } from './stage-matrix.js'
import { STRATEGY_KEYS } from './strategies.js'
import { netRof, summarizeR, summarizeUsd, R_NET_METRIC_ID, USD_NET_METRIC } from './pf-metrics.js'

const DAY = 86_400_000

/** Closes in this many trailing days set the rate the ETA runs on. */
export const RATE_DAYS = 30
/** A copy opens on another account within this long of the signal's first open. */
export const COPY_WINDOW_MS = 15 * 60_000
/** How many closed calendar months are sealed and shown. */
export const CLOSED_MONTHS = 3
export const UNREACHABLE = 'unreachable at current rate'

/**
 * The definition every figure here is computed under. Frozen and versioned
 * like basis-performance.js METRIC_DEFINITION: the test pins this object
 * exactly, so an edit without a new id is red, and the id keys the sealed
 * windows (a new id starts a new record, it never restates the old one).
 */
export const QUALIFICATION_DEFINITION = Object.freeze({
  id: 'bar-qualification-v1',
  population: "the evidence gate's (evidence-gate.js evidenceRows): status closed, net_pnl known, a label_strategy, origin bot_*, closed_at in the window; per account = the account's rows plus unscoped legacy rows",
  bar: 'evidence_gate_json minCloses over windowDays, read at report time, never copied',
  profitFactorR: 'r-net-v1 (pf-metrics.js) over R-scored closes; unscored closes counted by reason',
  profitFactorUsd: "usd-net-v0 (pf-metrics.js) over closes: the gate's own figure",
  winRate: 'r-net-v1 wins / R-scored closes, with the Wilson 95 % interval (z = 1.96); reported, never a bar (D2)',
  insufficient: 'a figure whose own count is under the bar reads {status: "insufficient"}, never a number',
  rate: 'closes in the last 30 days (closed_at) / 30, per day',
  eta: 'the first day t (0 < t <= windowDays) at which the closes still inside the rolling window at t plus rate x t reach the bar; none: "unreachable at current rate"',
  steadyState: "rate x windowDays: what the rolling window holds once today's closes have aged out",
  pooled: "per strategy across every account; a copy = the same strategy, symbol and side opened on a DIFFERENT account within 15 minutes of the signal's first open; a signal counts once: R = mean net R of its scored copies, money = the sum of its copies",
  closedWindows: 'UTC calendar months; sealed append-only on the first report read after the month closes (the last 3); a later difference is appended as a restatement and the sealed row never changes',
})

/** A close/open stamp as ms. A stamp with no zone (SQLite datetime) is UTC. */
export function stampMs(s) {
  if (s == null || s === '') return null
  const t = String(s).trim()
  const iso = t.includes('T') ? t : t.replace(' ', 'T')
  const ms = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`)
  return Number.isFinite(ms) ? ms : null
}

const iso = (ms) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString())
const acctKey = (r) => (r.account_id == null ? 'unscoped' : String(r.account_id))

function sideOf(s) {
  const x = String(s ?? '').toUpperCase()
  if (x === 'BUY' || x === 'LONG') return 'BUY'
  if (x === 'SELL' || x === 'SHORT') return 'SELL'
  return x
}

function withR(row) {
  const n = netRof(row)
  return { ...row, netR: n.netR, unscorableAs: n.unscorableAs, closedMs: stampMs(row.closed_at), openedMs: stampMs(row.opened_at) }
}

/**
 * Exact figures over closes ({net_pnl, netR, unscorableAs}) with NO bar
 * applied — the form a closed window is stored in.
 */
export function rawFigures(items) {
  const list = items || []
  const usd = summarizeUsd(list.map(x => x.net_pnl))
  const r = summarizeR(list)
  return {
    closes: list.length,
    usd: { wins: usd.wins, losses: usd.losses, grossWinUsd: usd.grossWinUsd, grossLossUsd: usd.grossLossUsd, netUsd: usd.net, profitFactor: usd.profitFactor },
    r: { scored: r.scored, unscorable: r.unscorable, unscorableBy: r.unscorableBy, wins: r.wins, losses: r.losses, grossWinR: r.grossWinR, grossLossR: r.grossLossR, netR: r.netR, profitFactor: r.profitFactor, lossless: r.lossless },
    winRate: r.scored > 0 ? wilsonInterval(r.wins, r.scored) : null,
  }
}

/**
 * The bar applied to raw figures: a derived figure whose own count is under
 * it reads insufficient (principle 6). Counts are shown either way.
 */
export function present(raw, bar) {
  const under = (n) => ({ status: 'insufficient', trades: n, needed: bar })
  const rOk = raw.r.scored >= bar
  const uOk = raw.closes >= bar
  return {
    closes: raw.closes,
    status: rOk && uOk ? 'measured' : 'insufficient',
    profitFactorR: rOk ? raw.r.profitFactor : under(raw.r.scored),
    profitFactorUsd: uOk ? raw.usd.profitFactor : under(raw.closes),
    winRate: rOk && raw.winRate ? { ...raw.winRate, method: 'wilson-95' } : under(raw.r.scored),
    usd: { wins: raw.usd.wins, losses: raw.usd.losses, netUsd: raw.usd.netUsd },
    r: { scored: raw.r.scored, unscorable: raw.r.unscorable, unscorableBy: raw.r.unscorableBy, wins: raw.r.wins, losses: raw.r.losses, netR: raw.r.netR, lossless: raw.r.lossless },
  }
}

/**
 * The first t in [0, W] days at which (closes still in the rolling window at
 * t) + rate·t ≥ bar, or null. `expiries` (ascending, days) is when each
 * current close leaves the window: a close stamped c is inside while
 * c ≥ now + t − W, i.e. until t = c + W − now.
 */
function etaDays(expiries, closes, bar, rate, W) {
  if (closes >= bar) return 0
  if (!(rate > 0)) return null
  let kept = closes
  let from = 0
  for (let i = 0; i <= expiries.length; i++) {
    const until = i < expiries.length ? Math.min(expiries[i], W) : W
    const t = Math.max(from, (bar - kept) / rate)
    if (t <= until) return t
    if (i < expiries.length) kept -= 1
    from = until
  }
  return null
}

/**
 * Can the bar be reached inside the rolling window at the current rate?
 * `stamps` are the window's close stamps (ms; null = unparseable, taken to
 * leave the window at once — the conservative reading — and counted).
 */
export function reachability(stamps, { bar, windowDays, now, rateDays = RATE_DAYS }) {
  const W = windowDays
  const list = stamps || []
  const closes = list.length
  const unstamped = list.filter(ms => !Number.isFinite(ms)).length
  const recent = list.filter(ms => Number.isFinite(ms) && ms >= now - rateDays * DAY).length
  const rate = recent / rateDays
  const steady = rate * W
  const base = {
    closes, needed: Math.max(0, bar - closes), closesLast30d: recent,
    ratePerDay: +rate.toFixed(4), steadyStateCloses: +steady.toFixed(1), sustainable: steady >= bar,
    unstamped,
  }
  const expiries = list.map(ms => (Number.isFinite(ms) ? Math.min(W, Math.max(0, (ms + W * DAY - now) / DAY)) : 0)).sort((a, b) => a - b)
  const t = etaDays(expiries, closes, bar, rate, W)
  if (t === 0) return { ...base, verdict: 'reached', etaDays: 0, etaAt: iso(now) }
  if (t == null) return { ...base, verdict: UNREACHABLE, etaDays: null, etaAt: null }
  return { ...base, verdict: 'reachable', etaDays: Math.round(t * 10) / 10, etaAt: iso(Math.round(now + t * DAY)) }
}

/**
 * Copies of one signal across accounts, for ONE strategy's rows: the same
 * symbol and side, opened on a different account within COPY_WINDOW_MS of
 * the signal's first open. A row with no readable open stamp cannot be
 * matched and stands alone (counted `unmatched`).
 */
export function clusterCopies(rows, windowMs = COPY_WINDOW_MS) {
  const open = new Map()
  const signals = []
  let unmatched = 0
  const sorted = [...(rows || [])].sort((a, b) => ((a.openedMs ?? Infinity) - (b.openedMs ?? Infinity)) || (a.id - b.id))
  for (const r of sorted) {
    const acct = acctKey(r)
    if (!Number.isFinite(r.openedMs)) {
      unmatched += 1
      signals.push({ copies: [r], accounts: new Set([acct]), firstOpenMs: null })
      continue
    }
    const key = `${r.symbol}|${sideOf(r.side)}`
    const list = open.get(key) || []
    let joined = null
    for (let i = list.length - 1; i >= 0; i--) {
      if (r.openedMs - list[i].firstOpenMs > windowMs) break
      if (!list[i].accounts.has(acct)) { joined = list[i]; break }
    }
    if (joined) { joined.copies.push(r); joined.accounts.add(acct); continue }
    const c = { copies: [r], accounts: new Set([acct]), firstOpenMs: r.openedMs }
    list.push(c)
    open.set(key, list)
    signals.push(c)
  }
  return { signals, unmatched }
}

/** One signal as one close: mean net R of its scored copies, money summed. */
function signalItem(c) {
  const scored = c.copies.filter(x => x.netR != null && Number.isFinite(x.netR))
  const netR = scored.length ? scored.reduce((a, x) => a + x.netR, 0) / scored.length : null
  const closed = c.copies.map(x => x.closedMs).filter(Number.isFinite)
  return {
    net_pnl: c.copies.reduce((a, x) => a + Number(x.net_pnl), 0),
    netR,
    unscorableAs: scored.length ? null : (c.copies[0].unscorableAs ?? 'noR'),
    closedMs: closed.length ? Math.min(...closed) : null,
  }
}

/** Pooled raw figures for one strategy's rows, with the copy counts. */
function pooledRaw(rows) {
  const { signals, unmatched } = clusterCopies(rows)
  const items = signals.map(signalItem)
  return {
    items,
    raw: {
      ...rawFigures(items),
      pooled: {
        signals: signals.length, copies: rows.length, collapsed: rows.length - signals.length, unmatched,
        accountIds: [...new Set(rows.map(acctKey))].sort(),
      },
    },
  }
}

function accountCurrencies(db) {
  const m = new Map()
  try { for (const r of db.prepare('SELECT account_id, base_currency FROM accounts').all()) m.set(String(r.account_id), r.base_currency ? String(r.base_currency) : null) } catch { /* none */ }
  return m
}

/**
 * Pooled money across accounts adds each account's own currency as stored.
 * With more than one currency in the pool the sum is not a figure in any
 * one of them, so PF-USD reads mixed_currency instead of a number.
 */
function presentPooled(raw, bar, ccy) {
  const shown = present(raw, bar)
  const currencies = [...new Set(raw.pooled.accountIds.map(a => (a === 'unscoped' ? 'unknown' : (ccy.get(a) || 'unknown'))))].sort()
  const mixed = currencies.length > 1
  return {
    ...shown,
    profitFactorUsd: mixed ? { status: 'mixed_currency', currencies } : shown.profitFactorUsd,
    usd: mixed ? { ...shown.usd, netUsd: { status: 'mixed_currency', currencies } } : shown.usd,
    currencies,
    signals: raw.pooled.signals, copies: raw.pooled.copies, collapsed: raw.pooled.collapsed,
    unmatched: raw.pooled.unmatched, accounts: raw.pooled.accountIds.length,
  }
}

// ---------------------------------------------------------------------------
// Closed windows (D3): UTC calendar months, sealed append-only.
// ---------------------------------------------------------------------------

/** The last `n` fully closed UTC calendar months before `now`'s month, oldest first. */
export function monthWindows(now, n = CLOSED_MONTHS) {
  const d = new Date(now)
  const y = d.getUTCFullYear(), m = d.getUTCMonth()
  const out = []
  for (let i = n; i >= 1; i--) {
    const fromMs = Date.UTC(y, m - i, 1)
    const toMs = Date.UTC(y, m - i + 1, 1)
    out.push({ key: new Date(fromMs).toISOString().slice(0, 7), fromMs, toMs })
  }
  return out
}

export function ensureQualificationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qualification_windows (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      definition     TEXT NOT NULL,
      window_key     TEXT NOT NULL,
      from_ms        INTEGER NOT NULL,
      to_ms          INTEGER NOT NULL,
      scope          TEXT NOT NULL CHECK(scope IN ('window','account','pooled')),
      strategy       TEXT NOT NULL,
      account_id     TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK(kind IN ('sealed','restatement')),
      supersedes     INTEGER,
      figures_json   TEXT NOT NULL,
      digest         TEXT NOT NULL,
      recorded_at_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_qualification_windows_sealed
      ON qualification_windows(definition, window_key, scope, strategy, account_id) WHERE kind = 'sealed';
    CREATE TRIGGER IF NOT EXISTS trg_qualification_windows_no_update BEFORE UPDATE ON qualification_windows
      BEGIN SELECT RAISE(ABORT, 'qualification_windows is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_qualification_windows_no_delete BEFORE DELETE ON qualification_windows
      BEGIN SELECT RAISE(ABORT, 'qualification_windows is append-only'); END;
  `)
}

const digest = (f) => createHash('sha256').update(JSON.stringify(f)).digest('hex')
const keyOf = (scope, strategy, accountId) => `${scope}|${strategy}|${accountId}`

/** A month's raw figures, keyed scope|strategy|account — from the data only. */
function windowFigures(db, w) {
  const rows = evidenceRows(db, { fromMs: w.fromMs, toMs: w.toMs }).map(withR)
  const out = new Map()
  const accts = [...new Set(rows.filter(r => r.account_id != null).map(r => String(r.account_id)))].sort()
  const strategies = [...new Set(rows.map(r => String(r.label_strategy)))].sort()
  let cells = 0
  for (const s of strategies) {
    const ofS = rows.filter(r => String(r.label_strategy) === s)
    for (const a of accts) {
      const list = ofS.filter(r => r.account_id == null || String(r.account_id) === a)
      if (list.length) { out.set(keyOf('account', s, a), rawFigures(list)); cells += 1 }
    }
    out.set(keyOf('pooled', s, ''), pooledRaw(ofS).raw)
  }
  out.set(keyOf('window', '', ''), { closes: rows.length, cells, strategies: strategies.length })
  return out
}

function emptyFigures(scope) {
  if (scope === 'window') return { closes: 0, cells: 0, strategies: 0 }
  if (scope === 'pooled') return pooledRaw([]).raw
  return rawFigures([])
}

/**
 * Seal each closed month not yet sealed; for a sealed month, append a
 * restatement for every key whose figures moved since its latest record.
 * Never updates or deletes a row (the table's triggers would refuse).
 */
export function sealClosedWindows(db, { now = Date.now(), months = CLOSED_MONTHS } = {}) {
  ensureQualificationTable(db)
  const def = QUALIFICATION_DEFINITION.id
  const ins = db.prepare(`INSERT INTO qualification_windows
    (definition, window_key, from_ms, to_ms, scope, strategy, account_id, kind, supersedes, figures_json, digest, recorded_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const read = db.prepare('SELECT * FROM qualification_windows WHERE definition = ? AND window_key = ? ORDER BY id')
  const out = { sealed: 0, restated: 0, errors: [] }
  for (const w of monthWindows(now, months)) {
    try {
      const live = windowFigures(db, w)
      const existing = read.all(def, w.key)
      const put = (k, f, kind, supersedes) => {
        const [scope, strategy, account] = k.split('|')
        ins.run(def, w.key, w.fromMs, w.toMs, scope, strategy, account, kind, supersedes, JSON.stringify(f), digest(f), now)
      }
      db.transaction(() => {
        if (!existing.some(r => r.scope === 'window' && r.kind === 'sealed')) {
          for (const [k, f] of live) { put(k, f, 'sealed', null); out.sealed += 1 }
          return
        }
        const latest = new Map()
        for (const r of existing) latest.set(keyOf(r.scope, r.strategy, r.account_id), r)
        for (const k of new Set([...latest.keys(), ...live.keys()])) {
          const f = live.get(k) ?? emptyFigures(k.split('|')[0])
          const prev = latest.get(k)
          if (digest(f) === (prev ? prev.digest : digest(emptyFigures(k.split('|')[0])))) continue
          put(k, f, 'restatement', prev ? prev.id : null)
          out.restated += 1
        }
      })()
    } catch (err) {
      out.errors.push(`${w.key}: ${err.message}`)
    }
  }
  return out
}

/** The stored record of each closed month, the bar applied for display. */
export function readClosedWindows(db, { now = Date.now(), months = CLOSED_MONTHS, bar, ccy = new Map() } = {}) {
  let rowsOf = () => []
  try {
    ensureQualificationTable(db)
    const read = db.prepare('SELECT * FROM qualification_windows WHERE definition = ? AND window_key = ? ORDER BY id')
    rowsOf = (key) => read.all(QUALIFICATION_DEFINITION.id, key)
  } catch { /* shown as unsealed */ }
  return monthWindows(now, months).map(w => {
    const rows = rowsOf(w.key)
    const head = { window: w.key, from: iso(w.fromMs), to: iso(w.toMs) }
    const seal = rows.find(r => r.scope === 'window' && r.kind === 'sealed')
    if (!seal) return { ...head, sealed: false }
    const groups = new Map()
    for (const r of rows) {
      const k = keyOf(r.scope, r.strategy, r.account_id)
      if (!groups.has(k)) groups.set(k, { sealed: null, restatements: [] })
      const g = groups.get(k)
      if (r.kind === 'sealed') g.sealed = r
      else g.restatements.push(r)
    }
    const show = (scope, f) => (scope === 'pooled' ? presentPooled(f, bar, ccy) : present(f, bar))
    const cells = [], pooled = []
    for (const [k, g] of groups) {
      const [scope, strategy, accountId] = k.split('|')
      if (scope === 'window') continue
      const last = g.restatements[g.restatements.length - 1]
      const entry = {
        strategy, ...(scope === 'account' ? { accountId } : {}),
        sealed: g.sealed ? show(scope, JSON.parse(g.sealed.figures_json)) : null,
        restatements: g.restatements.length,
        ...(last ? { current: show(scope, JSON.parse(last.figures_json)), restatedAt: iso(last.recorded_at_ms) } : {}),
      }
      ;(scope === 'pooled' ? pooled : cells).push(entry)
    }
    const byName = (a, b) => a.strategy.localeCompare(b.strategy) || String(a.accountId ?? '').localeCompare(String(b.accountId ?? ''))
    const sealedWindow = JSON.parse(seal.figures_json)
    return {
      ...head,
      sealed: true,
      sealedAt: iso(seal.recorded_at_ms),
      sealLagHours: +((seal.recorded_at_ms - w.toMs) / 3_600_000).toFixed(1),
      closes: sealedWindow.closes,
      restatements: rows.filter(r => r.kind === 'restatement').length,
      cells: cells.sort(byName),
      pooled: pooled.sort(byName),
    }
  })
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

function enabledAccounts(db) {
  try { return db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id').all().map(r => String(r.account_id)) } catch { return [] }
}

/**
 * GET /state/strategy-qualification.
 *
 * @param {object} db
 * @param {{now?: number}} [opts]
 */
export function strategyQualificationReport(db, { now = Date.now() } = {}) {
  const cfg = loadEvidenceGate(db)
  const bar = cfg.minCloses
  const W = cfg.windowDays
  const ccy = accountCurrencies(db)
  const rows = evidenceRows(db, { windowDays: W, now }).map(withR)
  const byStrategy = new Map()
  for (const r of rows) {
    const s = String(r.label_strategy)
    if (!byStrategy.has(s)) byStrategy.set(s, [])
    byStrategy.get(s).push(r)
  }
  const strategies = [...new Set([...STRATEGY_KEYS, ...byStrategy.keys()])].sort()
  const accounts = enabledAccounts(db)

  const cells = []
  let emptyCells = 0
  for (const a of accounts) {
    for (const s of strategies) {
      const list = (byStrategy.get(s) || []).filter(r => r.account_id == null || String(r.account_id) === a)
      const pinned = isHandPinned(db, getState, a, s)
      if (!list.length && !pinned) { emptyCells += 1; continue }
      const raw = rawFigures(list)
      const gate = evidenceRecord(db, { strategy: s, accountId: a, windowDays: W, now })
      cells.push({
        strategy: s, accountId: a, pinned,
        legacyUnscoped: list.filter(r => r.account_id == null).length,
        ...present(raw, bar),
        reachability: reachability(list.map(r => r.closedMs), { bar, windowDays: W, now }),
        reconciled: gate.closes === raw.closes && gate.profitFactor === raw.usd.profitFactor && gate.profitFactorR === raw.r.profitFactor,
      })
    }
  }

  const pooled = []
  for (const s of strategies) {
    const list = byStrategy.get(s) || []
    if (!list.length) continue
    const { items, raw } = pooledRaw(list)
    pooled.push({
      strategy: s,
      ...presentPooled(raw, bar, ccy),
      reachability: reachability(items.map(x => x.closedMs), { bar, windowDays: W, now }),
    })
  }

  const sealing = sealClosedWindows(db, { now })
  const closedWindows = readClosedWindows(db, { now, bar, ccy })
  const count = (list, f) => list.filter(f).length
  return {
    at: iso(now),
    reportOnly: true,
    gates: "none: no gate, verdict, bar or cap reads these figures (Q4b). Judging in R, counting since the pin, or counting copies once is the owner's decision (H-P6-7).",
    definition: QUALIFICATION_DEFINITION,
    metrics: { profitFactorR: R_NET_METRIC_ID, profitFactorUsd: USD_NET_METRIC.id, usd: USD_NET_METRIC },
    bar: { closes: bar, windowDays: W, source: 'evidence_gate_json via loadEvidenceGate (evidence-gate.js)' },
    window: { from: iso(now - W * DAY), to: iso(now), days: W },
    accounts,
    summary: {
      cells: cells.length, emptyCells,
      measured: count(cells, c => c.status === 'measured'),
      insufficient: count(cells, c => c.status === 'insufficient'),
      reached: count(cells, c => c.reachability.verdict === 'reached'),
      reachable: count(cells, c => c.reachability.verdict === 'reachable'),
      unreachable: count(cells, c => c.reachability.verdict === UNREACHABLE),
    },
    reconciled: cells.every(c => c.reconciled),
    cells,
    pooled,
    closedWindows,
    sealing,
    note: 'Per strategy x enabled account on the evidence gate population and window; pooled per strategy across every account with copies of one signal counted once. PF-R is r-net-v1 (net R), PF-USD usd-net-v0 (what the gate judges); win rate is r-net-v1 with its Wilson interval. The ETA ages today\'s closes out of the rolling window; "unreachable at current rate" means the bar cannot be met inside it at the last 30 days\' rate. Closed months are the sealed record: a restatement is recorded beside a sealed figure, never over it.',
  }
}
