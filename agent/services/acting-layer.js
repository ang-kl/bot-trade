// ---------------------------------------------------------------------------
// agent/services/acting-layer.js — the two invariants every layer that moves a
// stop or closes a position must hold.
//
//   1. ONE PASS AT A TIME. A second caller joins the pass in flight; it does
//      not start another one.
//   2. THIS ACCOUNT ONLY. A position is acted on when the ledger agrees it
//      belongs to the account this pass is authorised for AND the broker
//      confirms that account holds it. Anything else is refused before it
//      reaches the execution engine.
//
// WHY THIS FILE EXISTS. Both invariants were assumed rather than enforced, and
// both were false.
//
// On (1): `runTradeGuards` and `runProfitKeeper` are entered from TWO clocks —
// guardian.js's tick sweep on a ≥0.05% move, and fast-monitor.js's 60s band.
// Guardian's `sweeping` flag and the fast monitor's `withBudget` are separate
// guards over separate call sites, and `withBudget` abandons the WAIT rather
// than the work, so a slow pass is still running when the next one starts.
// Nothing in either module stopped two passes overlapping. The comment in
// fast-monitor.js claiming they run "here and ONLY here" was written about
// loop.js and was wrong the moment the guardian existed.
//
// On (2): trade-guard.js selected active guarded positions with no account
// column and no account filter, then executed every amend with whatever single
// credential the caller happened to hold. It did not reconcile either, so
// nothing at all stood between a foreign position id and `amendPosition` —
// where `withAccount` would stamp the WRONG account onto it. profit-keeper and
// loss-guardian share the missing filter but survive on a reconcile
// cross-check; trade-guard had no such net.
//
// Neither of these is a design question. They are defects, and this module is
// the shared answer so the next acting layer inherits it instead of
// re-deciding it.
// ---------------------------------------------------------------------------

/**
 * In-flight passes, keyed by layer name. Module state on purpose: the whole
 * point is that two DIFFERENT callers (a guardian tick and a fast-monitor
 * band) see the same pass, and a per-caller guard cannot do that.
 */
const inFlight = new Map()

/**
 * Run `work` under a single-flight lock.
 *
 * A second caller arriving while a pass is running receives THE SAME promise
 * and awaits the same result — it does not queue a second pass behind the
 * first. That is deliberate: these layers are idempotent re-assessments of
 * current state, so the answer a concurrent caller wants is "what the pass
 * that is already running decides", not "a second look at the same prices".
 *
 * Note the consequence, because it is a real change in behaviour: a guardian
 * tick arriving mid-pass now gets the result of the pass in flight rather than
 * a fresh evaluation. Response time is bounded by pass duration. That is
 * strictly better than the overlap it replaces — two passes reading the same
 * position and both deciding to amend it — but it is not the same thing as
 * "reacts on every tick".
 *
 * @param {string} key   layer name, e.g. 'profit_keeper'
 * @param {() => Promise<any>} work
 */
export function singleFlight(key, work) {
  const existing = inFlight.get(key)
  if (existing) return existing
  // Constructed BEFORE the map write and cleaned in `finally` on both paths:
  // a throwing pass must not leave the layer permanently locked out.
  const pass = (async () => work())().finally(() => {
    if (inFlight.get(key) === pass) inFlight.delete(key)
  })
  inFlight.set(key, pass)
  return pass
}

/** Which layers are mid-pass right now. Diagnostics and tests. */
export function inFlightLayers() {
  return [...inFlight.keys()]
}

/** Test seam only — the lock is module state by design (one process, one map). */
export function __resetInFlight() {
  inFlight.clear()
}

/** The account id a pass is authorised to act on, or null when creds carry none. */
export function authorisedAccountId(creds) {
  const id = creds?.accountId
  return id == null || id === '' ? null : String(id)
}

/**
 * SQL fragment + parameter for "rows belonging to this account".
 *
 * NULL is admitted deliberately. Positions predating the M1a account stamp
 * carry no `account_id`, and excluding them would silently stop guarding real
 * open positions — a protection regression dressed as a safety fix. An
 * unstamped row is *unknown*, not *foreign*, and the broker gate below is what
 * resolves it: if the account's own reconcile lists the position, it is ours
 * whatever the ledger forgot to write.
 *
 * @param {string} col  qualified column, e.g. 't.account_id'
 */
export function accountFilterSql(col) {
  return `(${col} IS NULL OR ${col} = ?)`
}

/**
 * Split candidate rows into those this pass may act on and those it may not.
 *
 * Both gates must pass:
 *   · LEDGER — the row's stamped account does not contradict this pass,
 *   · BROKER — this account's reconcile lists the position.
 *
 * The broker gate is the authoritative one and is required; a caller with no
 * reconcile must obtain one rather than skip it. That is the whole trade-guard
 * defect: a pass with no broker truth cannot know whose position it is holding.
 *
 * @param {Array<object>} rows
 * @param {object} o
 * @param {string|null} o.accountId          from authorisedAccountId(creds)
 * @param {Map<string, object>} o.live       positionId → broker position
 * @param {(r: object) => any} [o.idOf]      row → broker position id
 * @param {(r: object) => any} [o.accountOf] row → stamped account id
 * @returns {{owned: Array, foreign: Array, unknown: Array}}
 *   `foreign` = the ledger says another account owns it.
 *   `unknown` = the broker does not list it for this account (closed
 *   elsewhere, another account's, or a stale ledger row).
 */
export function scopeToAccount(rows, {
  accountId,
  live,
  idOf = (r) => r.position_id,
  accountOf = (r) => r.account_id,
} = {}) {
  const owned = []
  const foreign = []
  const unknown = []
  for (const r of rows || []) {
    const stamped = accountOf(r)
    if (stamped != null && accountId != null && String(stamped) !== accountId) {
      foreign.push(r)
      continue
    }
    const pid = idOf(r)
    if (!live || !live.has(String(pid))) {
      unknown.push(r)
      continue
    }
    owned.push(r)
  }
  return { owned, foreign, unknown }
}

/**
 * Enabled accounts on the SAME live/demo side as `baseCreds`, selected account
 * first.
 *
 * Lifted verbatim from loss-cap's sweep, which was the only layer doing it
 * correctly. One credential set reaches one host and a demo token cannot read
 * a live account, so mixing the sides produces an authorisation error per
 * account rather than a result — and profit-ratchet, which did not filter,
 * was walking every enabled row with one credential regardless of side.
 *
 * The selected account always leads and is always included, so a registry gap
 * can never silently drop the account the operator is actually looking at.
 */
export function sameSideAccountIds(db, baseCreds) {
  let roster = []
  try {
    const isLive = !!baseCreds?.isLive
    roster = db.prepare('SELECT account_id, is_live FROM accounts WHERE enabled = 1').all()
      .filter(a => (a.is_live === 1) === isLive)
      .map(a => String(a.account_id))
  } catch { roster = [] }
  const primary = authorisedAccountId(baseCreds)
  return [...new Set([...(primary ? [primary] : []), ...roster])]
}
