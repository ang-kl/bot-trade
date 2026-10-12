// W3 — the capped hybrid's verdict for every open position, read-only.
// Claude · № 13,361 12-Oct (ordered after № 13,350, owner "W1 W2 W3 W4 W11";
// docs/instruction-2026-10-12-decisions.md W3; claude-builder).
//
// WHY. The capped hybrid (50% at 2R, capped-hybrid-policy.js) runs inside the
// momentum partial manager every pass, and its pass already records a verdict
// for each open trade (capped-hybrid-enrolment.js: enrolled, delegated to an
// existing plan, excluded with the reason, deferred, or an error). That record
// was readable only through the private diagnostic readout. This joins the
// SAME redacted projection (diagnostic-readout.js readHybridVerdicts) to the
// open trades in scope, so each open position gets one line.
//
// Read-only: two agent_state reads (the stored pass and the tick controller)
// and two table reads (the active position monitors with their linked trades,
// momentum book links). No write, no broker read. A missing or unreadable pass
// record makes every position "not available" — never an empty,
// healthy-looking list.
//
// THE ROWS ARE THE OPEN POSITIONS TABLE'S ROWS (Codex P2 on #1326, bb9e75a0).
// The card sits under that table, which lists ACTIVE monitors LEFT JOINed to
// their trades (state.js GET /positions). Reading open trades instead dropped
// a monitor with no linked trade, or whose trade is not marked open, so the
// card could say "No open position in this view" under a table showing one.
// Those rows are now listed and named; an open trade with no active monitor
// is in neither.
import { readHybridVerdicts } from './diagnostic-readout.js'
import { accountWhere } from '../lib/account-scope.js'

const ACCOUNT = /^[1-9]\d{0,19}$/
// Precedence when a trade shows in more than one list. It does: a manual
// trade the manual enrolment acted on (enrolled, deferred or an error) is
// ALSO swept by the pass's observation loop, which records every open trade
// outside the bot candidates as `excluded` (often `candidate_not_selected`;
// capped-hybrid-enrolment.js). The enrolment's own outcome is the specific
// one, so the observation comes last.
const LISTS = [['enrolled', 'enrolled'], ['delegated', 'delegated'], ['deferred', 'deferred'], ['errors', 'error'], ['excluded', 'excluded']]

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

export function cappedHybridStatus(db, { accountId = null, now = Date.now() } = {}) {
  if (accountId != null && !ACCOUNT.test(String(accountId))) throw new RangeError('invalid_account')
  const scope = accountId == null ? null : [String(accountId)]
  const verdicts = readHybridVerdicts(db, { accountIds: scope })
  const pass = verdicts.momentum_partial_pass_json
  // Budget-deferred and error rows carry no account id (enrolment records
  // only the trade), so a scoped projection drops them; they are matched by
  // trade id from the unscoped projection instead. Trade ids are unique.
  const globalPass = scope ? readHybridVerdicts(db, { accountIds: null }).momentum_partial_pass_json : pass

  // The Open positions table's own population and scope (state.js GET
  // /positions): active monitors, scoped on the MONITOR's account with the
  // legacy-NULL convention (lib/account-scope.js), in the table's order.
  // Claude · № 13,413 12-Oct (Codex P2 on #1326 bb9e75a0; claude-builder)
  const where = accountWhere(scope ? { accountId: scope[0], all: false } : { all: true }, 'mp.account_id')
  const trades = db.prepare(`SELECT mp.id AS monitor_id, mp.trade_id AS monitor_trade_id, mp.account_id AS monitor_account_id,
      mp.symbol AS monitor_symbol, mp.side AS monitor_side, mp.strategy AS monitor_strategy,
      t.id AS id, t.status AS trade_status, t.account_id AS account_id, t.ctrader_position_id AS ctrader_position_id,
      t.symbol AS symbol, t.side AS side, t.strategy AS strategy
    FROM monitored_positions mp LEFT JOIN trades t ON t.id = mp.trade_id
    WHERE mp.status = 'active' ${where.active ? `AND ${where.where}` : ''}
    ORDER BY mp.created_at DESC, mp.id DESC`)
    // No cap: the table has none, and a cut row would have no verdict.
    // Claude · № 13,440 12-Oct (Codex P2 on #1326 3ad12c09; claude-builder)
    .all(...where.params)
  let booked = new Set()
  try {
    booked = new Set(db.prepare("SELECT DISTINCT trade_id FROM momentum_book WHERE trade_id IS NOT NULL").all().map(r => r.trade_id))
  } catch { /* no book table: no position is a book position */ }

  const hybrid = pass?.available === true ? pass.cappedHybrid : null
  // Every pass writes all five verdict lists as arrays (capped-hybrid-
  // enrolment.js `out`); the projection reads a list that is not an array as
  // `rows: null`. A section in any other shape (`{}`, a string, a list that is
  // not an array) cannot say where a position stands, so it is unavailable,
  // never an available pass with every position "not in the last pass".
  // Claude · № 13,428 12-Oct (Codex P2 on #1326 e0bdac7d; claude-builder)
  const unavailable = pass?.available !== true ? (pass?.reason || 'missing')
    : hybrid == null ? 'hybrid_section_missing'
      : hybrid.unavailableReason
        || (LISTS.some(([list]) => !Array.isArray(hybrid[list]?.rows)) ? 'hybrid_section_unreadable' : null)

  // `account|trade` → { verdict, row }, in precedence order: the scoped lists
  // first (filtered before the projection's cap), then the unscoped ones for
  // rows recorded without an account (keyed `|trade`). A row recorded under
  // another account than the trade's own (a stale record after the trade's
  // account was re-attributed) never answers for it.
  const byTrade = new Map()
  let truncatedLists = false
  if (!unavailable) {
    for (const [list, verdict] of LISTS) {
      for (const source of scope ? [hybrid, globalPass?.cappedHybrid] : [hybrid]) {
        const l = source?.[list]
        if (l?.truncated) truncatedLists = true
        for (const row of l?.rows || []) {
          const key = `${row.accountId ?? ''}|${row.tradeId}`
          if (!byTrade.has(key)) byTrade.set(key, { verdict, row, rank: LISTS.findIndex(x => x[0] === list) })
        }
      }
    }
  }
  const lookup = t => {
    const own = byTrade.get(`${t.account_id}|${t.id}`), bare = byTrade.get(`|${t.id}`)
    return own && bare ? (own.rank <= bare.rank ? own : bare) : own || bare
  }
  const coverageTruncated = hybrid?.coverage?.openTradesTruncated === true
    || hybrid?.excludedTruncated === true || hybrid?.delegatedTruncated === true

  const counts = {}
  const positions = trades.map(t => {
    const linked = t.id != null
    const base = { monitorId: t.monitor_id, tradeId: linked ? t.id : (t.monitor_trade_id ?? null),
      accountId: t.monitor_account_id ?? t.account_id ?? null,
      positionId: t.ctrader_position_id == null ? null : String(t.ctrader_position_id),
      symbol: t.symbol ?? t.monitor_symbol ?? null, side: t.side ?? t.monitor_side ?? null,
      strategy: t.strategy ?? t.monitor_strategy ?? null, book: linked && booked.has(t.id) }
    let out
    if (unavailable) out = { ...base, verdict: 'not_available', reason: unavailable }
    // The hybrid examines open trades only, so these rows are never in its
    // record; a verdict stored while a trade was open is not shown after it
    // is no longer open (the hybrid cannot act on it).
    else if (!linked) out = { ...base, verdict: 'not_in_last_pass', reason: t.monitor_trade_id == null ? 'no_linked_trade' : 'linked_trade_missing' }
    else if (t.trade_status !== 'open') out = { ...base, verdict: 'not_in_last_pass', reason: 'linked_trade_not_open' }
    else {
      const hit = lookup(t)
      if (!hit) {
        out = { ...base, verdict: 'not_in_last_pass',
          reason: truncatedLists || coverageTruncated ? 'record_truncated' : null }
      } else {
        const r = hit.row
        out = { ...base, verdict: hit.verdict, reason: r.reason ?? null,
          ...(hit.verdict === 'enrolled' ? { trigger: r.trigger ?? null, closeVolume: r.closeVolume ?? null,
            runnerVolume: r.runnerVolume ?? null, brokerTarget: r.brokerTarget ?? null } : {}),
          ...(hit.verdict === 'delegated' ? { planState: r.planState ?? null } : {}),
          observedAtMs: r.observedAtMs ?? null }
      }
    }
    counts[out.verdict] = (counts[out.verdict] || 0) + 1
    return out
  })

  const passAtMs = pass?.available === true && pass.at ? Date.parse(pass.at) : NaN
  return {
    accountId: scope ? scope[0] : 'all',
    at: iso(now),
    available: !unavailable,
    unavailableReason: unavailable,
    pass: pass?.available === true ? {
      at: pass.at ?? null,
      ageMs: Number.isFinite(passAtMs) ? Math.max(0, now - passAtMs) : null,
      ok: pass.ok === true,
      activePlans: pass.activePlans ?? null,
      examined: hybrid?.examined ?? null,
      coverage: hybrid?.coverage ?? null,
    } : null,
    counts,
    positions,
    // The redacted projection itself (scoped), for the operator who wants
    // every list, the tick controller's own exclusions and its pass age.
    verdicts,
    note: 'Read-only. Each open position in scope (the Open positions table\'s rows: active monitors and their linked trades) with the capped hybrid\'s verdict from its last stored pass (capped-hybrid-policy.js). A position with no linked open trade is listed and named, since the hybrid examines open trades only. Reasons are the allow-listed codes; error text is redacted. No broker read.',
  }
}
