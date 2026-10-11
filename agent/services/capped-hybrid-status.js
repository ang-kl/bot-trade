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
// and two table reads (open trades, momentum book links). No write, no broker
// read. A missing or unreadable pass record makes every position "not
// available" — never an empty, healthy-looking list.
import { readHybridVerdicts } from './diagnostic-readout.js'
import { accountWhere } from '../lib/account-scope.js'

const ACCOUNT = /^[1-9]\d{0,19}$/
export const CAPPED_HYBRID_STATUS_MAX_POSITIONS = 200
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

  // The scoped-read convention (lib/account-scope.js accountWhere): a legacy
  // row with no account is shown for every account, as the Open positions
  // table beside the card shows it (Codex P2 on #1326).
  const where = accountWhere(scope ? { accountId: scope[0], all: false } : { all: true })
  const open = db.prepare(`SELECT id, account_id, ctrader_position_id, symbol, side, strategy FROM trades
    WHERE status = 'open' ${where.active ? `AND ${where.where}` : ''} ORDER BY id LIMIT ?`)
    .all(...where.params, CAPPED_HYBRID_STATUS_MAX_POSITIONS + 1)
  const positionsTruncated = open.length > CAPPED_HYBRID_STATUS_MAX_POSITIONS
  const trades = open.slice(0, CAPPED_HYBRID_STATUS_MAX_POSITIONS)
  let booked = new Set()
  try {
    booked = new Set(db.prepare("SELECT DISTINCT trade_id FROM momentum_book WHERE trade_id IS NOT NULL").all().map(r => r.trade_id))
  } catch { /* no book table: no position is a book position */ }

  const hybrid = pass?.available === true ? pass.cappedHybrid : null
  const unavailable = pass?.available !== true ? (pass?.reason || 'missing')
    : hybrid == null ? 'hybrid_section_missing'
      : hybrid.unavailableReason || null

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
    const base = { tradeId: t.id, accountId: t.account_id, positionId: t.ctrader_position_id == null ? null : String(t.ctrader_position_id),
      symbol: t.symbol ?? null, side: t.side ?? null, strategy: t.strategy ?? null, book: booked.has(t.id) }
    let out
    if (unavailable) out = { ...base, verdict: 'not_available', reason: unavailable }
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
    positionsTruncated,
    // The redacted projection itself (scoped), for the operator who wants
    // every list, the tick controller's own exclusions and its pass age.
    verdicts,
    note: 'Read-only. Each open trade in scope with the capped hybrid\'s verdict from its last stored pass (half at 2R; capped-hybrid-policy.js). Reasons are the allow-listed codes; error text is redacted. No broker read.',
  }
}
