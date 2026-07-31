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
  try {
    const snap = JSON.parse(getState(db, 'broker_snapshot_cache_json') || 'null')
    liveAt = snap?.fetchedAt ?? null
    if (row.ctrader_position_id != null) {
      live = (snap?.account?.positions || [])
        .find(p => String(p?.positionId) === String(row.ctrader_position_id)) || null
    }
  } catch { live = null }

  const meta = {
    schemaVersion: SCHEMA_VERSION,
    // Revision: identity + the facts that can change. Later phases fold their
    // sections in; callers cache explanations by this value.
    revision: `${id}:${row.current_sl}:${row.current_tp}:${row.status}:${liveAt ?? 'nolive'}`,
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
      account: UNKNOWN,
      bars: UNKNOWN,
      indicators: UNKNOWN,
      execution: UNKNOWN,
      intention: UNKNOWN,
      journal: [],
      correlation: UNKNOWN,
      environment: UNKNOWN,
      fleet: UNKNOWN,
      advisories: [
        { kind: 'phase', detail: 'phase-1 shell: identity and position facts only — all other sections are UNKNOWN by design' },
        ...(live ? [] : [{ kind: 'staleness', detail: 'no broker snapshot row for this position — price/P&L unknown' }]),
      ],
      provenance: { position: position.source, brokerSnapshotAt: liveAt },
    },
  }
}
