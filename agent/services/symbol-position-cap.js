// ---------------------------------------------------------------------------
// agent/services/symbol-position-cap.js — a HARD CEILING on how many positions
// one symbol may hold on one account, obeyed by every submitter.
//
// WHAT HAPPENED (measured from the broker statement and the ledger, 04-08-2026,
// account 46130058 / login 5203012):
//
//   17 × DOW.US SELL, 250 lots each, broker order ids 353071385–353071402,
//   submitted inside 89 MILLISECONDS, every one stopped out at SL 30.18.
//   −$95 each: −$1,615, of which $170 is pure commission.
//
// The size was not the problem — 250 lots is the correct risk-based size for
// that balance, and the same signal placed ONE correctly-sized 59.7-lot
// position on 43097342. One signal produced seventeen full-risk positions on
// one symbol.
//
// WHY EVERY EXISTING GUARD MISSED IT. All seventeen local rows carry
// risk_event_id NULL and were created by the RECONCILER adopting them 89
// seconds after the fills — so they never went through autoTrade, whose
// write-ahead intent row and 3-minute duplicate_submission window would have
// stopped the second one. And risk.js's `duplicate_symbol` gate reads
// monitored_positions, which was empty for all seventeen: they were in flight,
// not yet reconciled. Every guard in the system reads a local table that an
// 89-millisecond burst outruns.
//
// THIS IS A CEILING, NOT A PERMISSION (owner, 05-08-2026: "maximum 2 positions
// hard cap"). It does NOT relax duplicate_symbol — that gate still refuses the
// second position through the normal path, and this changes nothing about it.
// What this adds is a floor under every OTHER path: whatever submits, however
// it got there, the seventeenth order cannot exist. A cap that only the
// well-behaved caller consults would have stopped none of these.
//
// AND IT COUNTS IN-FLIGHT WORK. The count is broker-reconciled positions PLUS
// the write-ahead intents that have not resolved yet — because the whole
// failure was seventeen orders that were all "not a position yet" at the
// moment each one was checked.
//
// AND IT COUNTS RESTING LIMIT ORDERS (added 05-08-2026, after the ceiling
// above was traced against the real event and found NOT to cover it).
//
// The seventeen were not a burst of submissions. They were a QUEUE: thirteen
// surviving `pending_orders` rows show one closed-market limit placed every
// 4-8 minutes from 10:41 to 12:03 on 04-08, every one at level 29.84 with the
// same stop to sixteen decimal places, each with its own risk_event_id. They
// rested at the broker for over an hour, then all filled inside 89ms when
// price crossed that single price once.
//
// The first version of this ceiling counted `monitored_positions` (open) and
// `trades` in a submitting state. A resting limit is NEITHER — it lives in
// `pending_orders` and `broker_orders` — so the cap could only ever have bitten
// at fill time, and these fills arrived through the reconciler, which does not
// consult it. The ceiling had a hole exactly the shape of the incident it was
// built for.
//
// A resting order is exposure the moment it is placed: nobody has to press
// anything for it to become a position. So it counts, and it counts from
// BROKER TRUTH (`broker_orders`) UNION our own intent (`pending_orders`),
// deduplicated by order id — because the failure mode was precisely our intent
// record being cleared while the broker order stayed alive.
// ---------------------------------------------------------------------------

/**
 * Owner-set: 2 on 05-08-2026, raised to 3 the same day.
 *
 * THIS IS A CONCURRENCY LIMIT, NOT A QUOTA (owner: "2 symbol capped means
 * concurrent trading at the same time, not over time"). Every input below is
 * a live state — `active` positions, `submitting`/`unconfirmed` orders,
 * `working` limits. A symbol the bot traded seventeen times last week, all
 * closed, is at zero: closed, filled, cancelled and expired rows never count,
 * so the ceiling caps simultaneous exposure and never rations opportunity.
 *
 * `duplicate_symbol` still refuses the second entry on the normal path, so
 * anything reaching this line is either a deliberate extra leg or a submitter
 * that bypassed the gate. Three lets the former through and stops the latter
 * from becoming seventeen.
 */
export const DEFAULT_MAX_PER_SYMBOL = 3

/** Ledger states that mean "an order may be live at the broker right now". */
export const IN_FLIGHT_STATUSES = Object.freeze(['submitting', 'unconfirmed'])

/**
 * How many positions does this account hold on this symbol, counting work that
 * has not landed yet?
 *
 * @returns {{total, open, inFlight, resting}} — `open` is broker-reconciled,
 *   `inFlight` is submitted-and-unresolved, `resting` is a limit order sitting
 *   at the broker waiting for price. All three are real exposure: none of them
 *   needs anyone to do anything for it to become a position.
 */
export function countForSymbol(db, accountId, symbol) {
  const sym = String(symbol || '').toUpperCase()
  const acct = accountId != null ? String(accountId) : null
  let open = 0
  let inFlight = 0
  let resting = 0
  try {
    // NULL-account rows count for every account. That only ever makes the cap
    // STRICTER, which is the correct direction for a safety ceiling — the
    // same reasoning risk.js uses for its scoped reads.
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM monitored_positions
       WHERE status = 'active' AND UPPER(symbol) = ?
         AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
    `).get(sym, acct, acct)
    open = row?.n || 0
  } catch { open = 0 }
  try {
    const marks = IN_FLIGHT_STATUSES.map(() => '?').join(',')
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM trades
       WHERE status IN (${marks}) AND UPPER(symbol) = ?
         AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
    `).get(...IN_FLIGHT_STATUSES, sym, acct, acct)
    inFlight = row?.n || 0
  } catch { inFlight = 0 }
  try {
    // UNION, not sum: an order that appears in both tables is ONE order. The
    // broker's book leads because our own row is the thing that went missing;
    // a pending row with no broker id yet still counts under a synthetic key
    // so an unacknowledged placement cannot be placed twice over.
    //
    // EVERY resting order counts, the owner's manual ones included (owner,
    // 05-08-2026: "flip"). This shipped with `is_bot = 1` on the reasoning
    // that freezing the bot because a human left an order resting was a
    // surprise nobody asked for — the owner's call is the other way, and it is
    // the better one: a manual limit and a bot limit fill into the same
    // account, at the same price, on the same margin. The ceiling is about
    // total simultaneous exposure to one symbol, not about who typed it.
    const row = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT CAST(order_id AS TEXT) AS k FROM broker_orders
         WHERE status = 'working' AND UPPER(symbol) = ?
           AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
        UNION
        SELECT COALESCE(CAST(order_id AS TEXT), 'pending:' || id) AS k FROM pending_orders
         WHERE status = 'working' AND UPPER(symbol) = ?
           AND (account_id = ? OR account_id IS NULL OR ? IS NULL)
      )
    `).get(sym, acct, acct, sym, acct, acct)
    resting = row?.n || 0
  } catch { resting = 0 }
  return { total: open + inFlight + resting, open, inFlight, resting }
}

/**
 * May this account open ANOTHER position on this symbol?
 *
 * Pure given the counts, so the decision is testable without a database and
 * the same table can be read from a route.
 *
 * @returns {{allow: boolean, reason?: string, count, cap}}
 */
export function symbolCapVerdict({ symbol, accountId, count, cap = DEFAULT_MAX_PER_SYMBOL }) {
  const n = Number(count?.total ?? count) || 0
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : DEFAULT_MAX_PER_SYMBOL
  if (n < limit) return { allow: true, count: n, cap: limit }
  const held = count?.open ?? n
  const flight = count?.inFlight ?? 0
  const rest = count?.resting ?? 0
  return {
    allow: false,
    count: n,
    cap: limit,
    reason: `symbol_position_cap ${symbol}=${n}/${limit} on ${accountId ?? 'selected'}`
      + ` (${held} open at the broker, ${flight} submitted and unresolved,`
      + ` ${rest} resting at a limit)`
      + ' — hard ceiling, obeyed by every submitter',
  }
}

/** The whole check, for a caller that has a db. */
export function checkSymbolCap(db, { accountId, symbol, cap = DEFAULT_MAX_PER_SYMBOL } = {}) {
  const count = countForSymbol(db, accountId, symbol)
  return { ...symbolCapVerdict({ symbol, accountId, count, cap }), ...count }
}

/**
 * Clusters ALREADY over the ceiling — the detector half.
 *
 * Owner, 05-08-2026, on what to do about positions that exist now: "if exist
 * now, alert only. It should not happen again." So this reports and never
 * closes. Auto-closing seventeen positions on a reading is a bigger action
 * than the one that created them, and #179's nine 0066.HK were protected by
 * their own SL/TP the whole time — loud is right, automatic is not.
 *
 * Counts BROKER-RECONCILED positions only. An in-flight order is a burst in
 * progress, which the cap above refuses; it is not yet a cluster to report.
 */
export function overCapClusters(db, { cap = DEFAULT_MAX_PER_SYMBOL } = {}) {
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : DEFAULT_MAX_PER_SYMBOL
  try {
    // opened_at lives on `trades`, not on monitored_positions — the position
    // row carries no timestamp of its own, so the join is what makes the
    // report say WHEN a cluster formed. An adopted row with no trade link
    // still counts; it just has no time to show.
    return db.prepare(`
      SELECT UPPER(mp.symbol) AS symbol, mp.account_id AS accountId, COUNT(*) AS n,
             MIN(t.opened_at) AS firstAt, MAX(t.opened_at) AS lastAt
        FROM monitored_positions mp
        LEFT JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active'
       GROUP BY UPPER(mp.symbol), mp.account_id
      HAVING COUNT(*) > ?
       ORDER BY n DESC
    `).all(limit).map(r => ({ ...r, cap: limit, over: r.n - limit }))
  } catch { return [] }
}

/** One line per cluster, for the log and the alert. */
export const clusterLine = (c) =>
  `${c.symbol} × ${c.n} on ${c.accountId ?? 'unattributed'} (cap ${c.cap}, ${c.over} over)`
  + `${c.firstAt ? ` — opened ${c.firstAt}${c.lastAt && c.lastAt !== c.firstAt ? ` … ${c.lastAt}` : ''}` : ''}`

/**
 * Clusters of RESTING ORDERS over the ceiling — the half that was missing.
 *
 * On 04-08 this would have fired at 10:56, on the third order, eighty-seven
 * minutes before the market opened and turned all of them into positions.
 * `overCapClusters` above could not have: there was nothing in
 * monitored_positions to see until every one of them had already filled.
 *
 * Alert only, same as its sibling — cancelling resting orders on a reading is
 * a bigger action than the one that created them, and the owner's instruction
 * for existing clusters was explicit.
 */
export function overCapRestingOrders(db, { cap = DEFAULT_MAX_PER_SYMBOL } = {}) {
  const limit = Number.isFinite(Number(cap)) && Number(cap) > 0 ? Math.floor(Number(cap)) : DEFAULT_MAX_PER_SYMBOL
  try {
    return db.prepare(`
      SELECT UPPER(symbol) AS symbol, account_id AS accountId, COUNT(*) AS n,
             MIN(placed_at) AS firstAt, MAX(placed_at) AS lastAt,
             MIN(level) AS minLevel, MAX(level) AS maxLevel
        FROM pending_orders
       WHERE status = 'working'
       GROUP BY UPPER(symbol), account_id
      HAVING COUNT(*) > ?
       ORDER BY n DESC
    `).all(limit).map(r => ({ ...r, cap: limit, over: r.n - limit }))
  } catch { return [] }
}

/** One line per resting cluster. Names the price, because that is the tell. */
export const restingLine = (c) =>
  `${c.symbol} × ${c.n} RESTING on ${c.accountId ?? 'unattributed'} (cap ${c.cap}, ${c.over} over)`
  + `${c.minLevel != null ? ` @ ${c.minLevel === c.maxLevel ? c.minLevel : `${c.minLevel}–${c.maxLevel}`}` : ''}`
  + `${c.firstAt ? ` — placed ${c.firstAt}${c.lastAt && c.lastAt !== c.firstAt ? ` … ${c.lastAt}` : ''}` : ''}`
