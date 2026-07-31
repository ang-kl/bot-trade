// ---------------------------------------------------------------------------
// cockpit-snapshot.js — PHASE 1 of the cockpit live-wiring prompt
// (instr/Bot-Trade_Cockpit_Live-Wiring_Insight_Prompt_v1.md): identity and the
// read-only endpoint SHELL.
//
// This phase deliberately returns ONLY what identity + the local database can
// vouch for: the meta block and the position block. Every other section of the
// target contract (bars, indicators, execution, intention, journal,
// correlation, environment, fleet) is present with status 'unknown' — the
// prompt's core rule is that missing data is UNKNOWN, never a fabricated
// default, and the shell must demonstrate that discipline before any section
// is wired for real in later phases.
//
// IDENTITY IS THE POINT OF THIS PHASE. The cockpit's click path carried the
// broker position id in the URL and everything else in an in-memory Map that a
// reload empties. This route accepts the DURABLE id (monitored_positions.id),
// requires the caller to say which account it believes the position belongs
// to, and refuses to answer when they disagree — the prompt's "no silent
// account fallback": a wrong-account request gets a safe not-found, never the
// other account's data.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { fxDayStartSql, loadRiskConfig } from './risk.js'

const SCHEMA_VERSION = 1

const UNKNOWN = Object.freeze({ status: 'unknown' })

/**
 * Build the Phase-1 cockpit snapshot for one position.
 *
 * @param {object} db          better-sqlite3 handle
 * @param {number} dbPositionId monitored_positions.id — the durable identity
 * @param {{accountId: string|null, explicit: boolean}} scope
 *                              requestedAccount() result for this request
 * @returns {{status: number, body: object}} HTTP status + payload. 400 for an
 *   unusable id, 404 for not-found OR wrong-account (indistinguishable on
 *   purpose — a wrong-account probe must not learn that the id exists).
 */
export function cockpitSnapshot(db, dbPositionId, scope, nowMs = Date.now()) {
  const id = Number(dbPositionId)
  if (!Number.isInteger(id) || id <= 0) {
    return { status: 400, body: { error: 'dbPositionId must be a positive integer' } }
  }
  // The prompt: "Reject wrong-account, ambiguous or missing identity." An
  // implicit scope (nothing asked, defaulted from the selected account) is
  // ambiguous for a deep link — the link may have been minted while another
  // account was selected, and answering from the CURRENT selection would be
  // exactly the silent fallback this phase exists to remove.
  if (!scope?.explicit) {
    return { status: 400, body: { error: 'account is required — pass ?account=<accountId> (the cockpit never falls back to the selected account)' } }
  }

  const row = db.prepare(
    `SELECT mp.*, t.volume AS volume, t.opened_at AS opened_at,
            t.ctrader_position_id AS ctrader_position_id
       FROM monitored_positions mp
       LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.id = ?`
  ).get(id)

  // Not found and wrong-account are the SAME answer. An M1 legacy row with
  // NULL account_id belongs to every scope, matching accountWhere()'s
  // convention everywhere else in the app.
  const rowAccount = row?.account_id == null ? null : String(row.account_id)
  const wrongAccount = row && rowAccount != null && scope.accountId != null &&
    rowAccount !== String(scope.accountId)
  if (!row || wrongAccount) {
    return { status: 404, body: { error: `no position ${id} in account ${scope.accountId}` } }
  }

  // Broker snapshot cache (the ~30s monitor refresh) — reused, never a fresh
  // broker call: the prompt forbids new handshakes on read paths. Its absence
  // is a status, not a zero.
  let live = null
  let liveAt = null
  let snapAccount = null
  try {
    const snap = JSON.parse(getState(db, 'broker_snapshot_cache_json') || 'null')
    liveAt = snap?.fetchedAt ?? null
    snapAccount = snap?.account ?? null
    if (row.ctrader_position_id != null) {
      live = (snap?.account?.positions || [])
        .find(p => String(p?.positionId) === String(row.ctrader_position_id)) || null
    }
  } catch { live = null }

  // PHASE 2 — the cache is the SELECTED account's snapshot (one cache, by
  // design, until per-account snapshots arrive). If it belongs to a different
  // account than this request, using it would hand account A's balance to a
  // cockpit showing account B — so it is discarded for BOTH the account block
  // and the per-position live enrichment, with an advisory saying why.
  const snapIsThisAccount = snapAccount != null &&
    (snapAccount.accountId == null ||
      String(snapAccount.accountId) === String(rowAccount ?? scope.accountId))
  if (!snapIsThisAccount) { live = null }

  const meta = {
    schemaVersion: SCHEMA_VERSION,
    // Revision: identity + the facts that can change. Later phases fold their
    // sections in; callers cache explanations by this value.
    revision: `${id}:${row.current_sl}:${row.current_tp}:${row.status}:${lastJournalId(db, row)}:${liveAt ?? 'nolive'}`,
    fetchedAt: new Date(nowMs).toISOString(),
    accountId: rowAccount ?? String(scope.accountId ?? ''),
    dbPositionId: id,
    brokerPositionId: row.ctrader_position_id != null ? String(row.ctrader_position_id) : null,
    tradeId: row.trade_id ?? null,
    dataMode: 'live',
    // Overall honesty flag for the shell: identity + local facts only.
    overall: 'partial',
  }

  const position = {
    symbol: row.symbol,
    side: row.side ?? null,
    lots: row.volume ?? null,
    entry: row.entry_price ?? null,
    sl: row.current_sl ?? null,
    tp: row.current_tp ?? null,
    price: live?.price ?? null,
    bid: live?.bid ?? null,
    ask: live?.ask ?? null,
    pnl: live?.pnl ?? live?.netPnl ?? null,
    pnlCurrency: live?.currency ?? null,
    openedAt: row.opened_at ?? null,
    // Filled by the route wrapper below when the cached symbol-hours helper is
    // available — null (unknown) when it is not, never a guess.
    marketOpen: null,
    marketSource: null,
    mfeR: row.mfe_r ?? null,
    maeR: row.mae_r ?? null,
    status: row.status,
    // Provenance, per the contract: which parts are local truth vs broker
    // cache, and how old the cache is.
    source: live ? 'local-db+broker-snapshot-cache' : 'local-db',
    asOf: liveAt,
  }

  return {
    status: 200,
    body: {
      meta,
      position,
      account: buildAccount(db, snapIsThisAccount ? snapAccount : null, liveAt, rowAccount ?? scope.accountId),
      bars: UNKNOWN,
      indicators: UNKNOWN,
      execution: buildExecution(db, row, live, liveAt),
      intention: UNKNOWN,
      journal: buildJournal(db, row, rowAccount),
      correlation: UNKNOWN,
      environment: UNKNOWN,
      fleet: UNKNOWN,
      advisories: [
        { kind: 'phase', detail: 'phase-4: identity, position, account, execution and journal are live/derived (bars+indicators fill in the route); intention, correlation, environment and fleet remain UNKNOWN by design' },
        ...(snapAccount != null && !snapIsThisAccount
          ? [{ kind: 'account-scope', detail: `broker snapshot cache belongs to account ${snapAccount.accountId} — not used for this position's account/live facts` }]
          : []),
        ...(live ? [] : [{ kind: 'staleness', detail: 'no broker snapshot row for this position — price/P&L unknown' }]),
      ],
      provenance: { position: position.source, brokerSnapshotAt: liveAt },
    },
  }
}

// ---------------------------------------------------------------------------
// PHASE 2 builders — account and execution, from facts the app already holds.
// ---------------------------------------------------------------------------

/**
 * The account block: broker health from the snapshot cache, the daily-loss
 * RULE from risk config, and the day's realized usage from the trades table.
 *
 * `snapAccount` is null when the cache is missing OR belongs to a different
 * account — both yield status 'unknown' for the broker figures rather than
 * another account's balance. The loss-cap fields are RULE + DERIVED and can
 * be stated even then, but only when the balance they need exists.
 */
function buildAccount(db, snapAccount, liveAt, accountId) {
  const h = snapAccount?.health ?? null
  const balance = h?.balance ?? null

  // Daily loss cap = dailyLossPct × balance (the same formula the risk gate
  // uses), anchored to the FX day open per the owner-approved #91 move.
  let dailyLossCap = null
  let dailyLossUsed = null
  try {
    const pct = loadRiskConfig(db)?.dailyLossPct
    if (balance != null && Number.isFinite(pct) && pct > 0) dailyLossCap = balance * pct
    const anchor = fxDayStartSql()
    const rows = db.prepare(
      `SELECT COALESCE(SUM(net_pnl), 0) AS net FROM trades
        WHERE status = 'closed' AND net_pnl IS NOT NULL
          AND closed_at >= ?
          AND (account_id = ? OR account_id IS NULL)`
    ).get(anchor, accountId == null ? null : String(accountId))
    // "Used" is adverse-only: a profitable day has used none of the cap.
    dailyLossUsed = Math.max(0, -Number(rows?.net ?? 0))
  } catch { /* stays null / unknown */ }

  return {
    currency: snapAccount?.currency ?? null,
    balance,
    equity: h?.equity ?? null,
    usedMargin: h?.usedMargin ?? null,
    freeMargin: h?.freeMargin ?? null,
    dailyLossCap,
    dailyLossUsed,
    source: snapAccount ? 'broker-snapshot-cache + risk-config' : 'risk-config-only',
    asOf: snapAccount ? liveAt : null,
    status: snapAccount ? 'live' : 'unknown',
  }
}

/**
 * The execution block. spreadNow is DERIVED from the cached bid/ask;
 * spreadBacktest comes from the trade's own entry forensics when the
 * collect-forward capture recorded them; latency has NO authoritative source
 * in this app (loop-phase lag measures the agent's event loop, not the broker
 * round-trip) and is therefore UNKNOWN rather than a proxy dressed as a fact.
 */
function buildExecution(db, row, live, liveAt) {
  const facts = []
  let spreadNow = null
  if (live?.bid != null && live?.ask != null && live.ask >= live.bid) {
    spreadNow = Number((live.ask - live.bid).toPrecision(6))
    facts.push({ id: 'spread-now', detail: `ask ${live.ask} − bid ${live.bid} from the broker snapshot cache`, asOf: liveAt })
  }

  // Entry-time forensics captured by the Perf Ledger collect-forward work —
  // read from the trade row, never recomputed after the fact.
  let slippageAtEntry = null
  let spreadAtEntry = null
  try {
    if (row.trade_id != null) {
      const t = db.prepare('SELECT slippage_price, spread_at_entry FROM trades WHERE id = ?').get(row.trade_id)
      slippageAtEntry = t?.slippage_price ?? null
      spreadAtEntry = t?.spread_at_entry ?? null
      if (slippageAtEntry != null) facts.push({ id: 'slippage-entry', detail: 'signed, adverse-positive, price units — captured at fill time' })
    }
  } catch { /* columns exist since Perf Ledger PR A; stays null on any read issue */ }

  const spreadRatio = spreadNow != null && spreadAtEntry != null && spreadAtEntry > 0
    ? Number((spreadNow / spreadAtEntry).toPrecision(4))
    : null
  if (spreadRatio != null) facts.push({ id: 'spread-ratio', detail: 'spreadNow ÷ spread_at_entry (the entry capture is the baseline; no backtest spread series exists)' })

  return {
    spreadNow,
    spreadBacktest: null,          // no backtest spread series exists — UNKNOWN, per the prompt
    spreadRatio,
    latencyMs: null,               // no authoritative broker-latency metric exists — UNKNOWN
    slippageAtEntry,
    spreadAtEntry,
    status: spreadNow != null || slippageAtEntry != null ? 'partial' : 'unknown',
    facts,
  }
}

// ---------------------------------------------------------------------------
// PHASE 4 — the real tweak journal. position_events IS the journal: it is
// already written by the profit keeper, the loop's broker actions, the manual
// routes and the C++ trail poll (P10), so this phase only READS and maps.
// Nothing is invented: no dates, no OHLC, no R values beyond what the writer
// recorded at the moment of the event. An empty journal is an honest answer
// for a fresh position.
// ---------------------------------------------------------------------------

/**
 * Events for THIS position, by durable identity: trade_id when the row has
 * one, else the broker position id. Account-scoped with the M1 NULL
 * convention — an event stamped for a DIFFERENT account never shows, even if
 * a positionId collision were to exist across accounts (the open question the
 * multi-account work has not yet closed; scoping here means the journal
 * cannot become the place that bug leaks through).
 */
function journalRows(db, row, accountId) {
  const params = []
  const idTerms = []
  if (row.trade_id != null) { idTerms.push('trade_id = ?'); params.push(Number(row.trade_id)) }
  if (row.ctrader_position_id != null) { idTerms.push('position_id = ?'); params.push(String(row.ctrader_position_id)) }
  if (!idTerms.length) return []
  const acct = accountId == null ? null : String(accountId)
  params.push(acct, acct)
  return db.prepare(
    `SELECT id, at, kind, from_value, to_value, r_at, price_at, reason, source, detail_json
       FROM position_events
      WHERE (${idTerms.join(' OR ')})
        AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
      ORDER BY at ASC, id ASC`
  ).all(...params)
}

function buildJournal(db, row, accountId) {
  try {
    return journalRows(db, row, accountId).map(e => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      from: e.from_value,
      to: e.to_value,
      rAt: e.r_at,
      priceAt: e.price_at,
      reason: e.reason,
      // actor/source verbatim from the writer — profit_keeper,
      // cpp_trail_engine, manual, … — never re-attributed at read time.
      source: e.source,
      detail: (() => { try { return e.detail_json ? JSON.parse(e.detail_json) : null } catch { return e.detail_json } })(),
    }))
  } catch { return [] }
}

/** Newest journal event id, for the snapshot revision. 0 when none. */
function lastJournalId(db, row) {
  try {
    const rows = journalRows(db, row, row.account_id == null ? null : String(row.account_id))
    return rows.length ? rows[rows.length - 1].id : 0
  } catch { return 0 }
}
