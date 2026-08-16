// ---------------------------------------------------------------------------
// agent/services/account-equity.js — stamp ONE account's own balance and
// leverage under its `acct:<id>:` keys.
//
// WHY THIS EXISTS. The loop's primary reconcile pass reads the broker's trader
// record for the SELECTED account and stamps both the legacy global
// `account_balance_usd` and the scoped `acct:<id>:account_balance_usd`. The
// per-account sweep that follows it — the one that reconciles every OTHER
// enabled account on the same side — reconciles positions and runs the
// protection audit, but never made that trader call. So those accounts got
// positions and an audit, and no equity of their own.
//
// The cost is not cosmetic. `getAccountBalance(db, id)` falls through to the
// unowned global when an account has nothing stamped, and that global holds
// whichever account refreshed it last. Measured 2026-08-15: accounts 43002148
// and 43069009 both reported 35,319.80 — the selected account's balance.
// Worse than the wrong number on a panel, a percentage-based loss cap computed
// off it is priced against equity the account does not have: 3% of 35,319.80
// instead of 3% of 688.17 is ~51x too permissive, so the cap can never bind.
//
// The resolver is NOT the place to fix that. Making an unstamped account read
// null was tried and reverted — `effectiveCapUsd` drops the percentage cap on
// a null balance, which would silently REMOVE the cap on exactly those
// accounts (14 loss-cap/equity-stop/ratchet tests caught it). The honest fix is
// upstream: make sure every reachable account HAS its own balance, so nothing
// ever needs the unowned global.
// ---------------------------------------------------------------------------

/**
 * Read one account's trader record and stamp its scoped equity keys.
 *
 * Deliberately does NOT write the legacy global `account_balance_usd`: that
 * key means "the selected account's balance", and having every swept account
 * overwrite it in turn is how it came to hold an arbitrary account's number in
 * the first place.
 *
 * Never throws — a broker hiccup on one account must not stop the sweep of the
 * others. Deps injectable for tests: { ws, setAccountState }.
 *
 * @returns {Promise<{accountId:string, balance:number|null, leverage:number|null, error:string|null}>}
 */
export async function stampAccountEquity(db, creds, accountId, deps = {}) {
  const out = { accountId: String(accountId), balance: null, leverage: null, error: null }
  try {
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const setAcct = deps.setAccountState
      ?? (await import('./account-registry.js')).setAccountState

    const trader = await ws.wsGetTrader(
      creds.host, creds.clientId, creds.clientSecret, creds.accessToken, accountId,
    )
    const bal = ws.traderBalance(trader)
    // `> 0` matches what getAccountBalance will accept. Stamping a zero or a
    // NaN would leave the key present but unusable, which reads as "stamped"
    // to anyone auditing coverage while still falling through to the global.
    if (Number.isFinite(bal) && bal > 0) {
      setAcct(db, accountId, 'account_balance_usd', String(bal))
      out.balance = bal
    }
    const lev = Number(trader?.leverageInCents)
    if (Number.isFinite(lev) && lev > 0) {
      setAcct(db, accountId, 'account_leverage', String(lev / 100))
      out.leverage = lev / 100
    }
  } catch (err) {
    out.error = err?.message ?? String(err)
  }
  return out
}

/**
 * Which enabled accounts still have no balance of their own — i.e. which ones
 * `getAccountBalance` would answer for out of the unowned global.
 *
 * Reporting, not repair: it names the gap so coverage can be asserted and
 * shown, rather than discovered again from three panels agreeing suspiciously.
 *
 * @returns {Array<{accountId:string, isLive:boolean}>}
 */
export function accountsMissingEquity(db, getState) {
  try {
    const rows = db.prepare(
      `SELECT account_id, is_live FROM accounts WHERE enabled = 1 ORDER BY account_id`,
    ).all()
    return rows
      .filter((r) => {
        const v = Number(getState(db, `acct:${String(r.account_id)}:account_balance_usd`))
        return !(Number.isFinite(v) && v > 0)
      })
      .map(r => ({ accountId: String(r.account_id), isLive: r.is_live === 1 }))
  } catch {
    return []
  }
}

/** cTrader's two hosts. An account is only ever reachable on its own side. */
export const hostForSide = (isLive) => (isLive ? 'live.ctraderapi.com' : 'demo.ctraderapi.com')

/**
 * Stamp equity for enabled accounts on the OTHER side from the running
 * session. READ-ONLY BY CONSTRUCTION: it asks the broker what an account is
 * worth and writes that account's own two state keys. Nothing else — no
 * position reconcile, no order sync, no protection audit, no writes to any
 * row belonging to those accounts.
 *
 * WHY IT HAS TO EXIST. The loop resolves ONE host from `ctrader_is_live` and
 * the per-account sweep filters to that side (`(a.is_live === 1) === isLive`),
 * because a demo session must not manage live positions. Correct for
 * MANAGEMENT, but it also meant the other side's accounts never had their
 * balance read — and `getAccountBalance` answers for an unstamped account out
 * of the unowned global. Measured 2026-08-16, with the session on demo: the
 * three live accounts all showed `lastReconcileAt: None`, two of them reported
 * the selected demo account's 35,319.80 through /state/profit-ratchet while
 * /state/account-engineering correctly showed `None` for the same accounts.
 * Two endpoints, same accounts, different answers.
 *
 * Reading a balance is not managing a position, so this crosses the side
 * boundary for that one purpose and nothing more.
 *
 * @returns {Promise<{swept:number, stamped:number, failed:number,
 *                    results:Array<{accountId:string,balance:number|null,error:string|null}>}>}
 */
export async function sweepCrossSideEquity(db, creds, { isLive, deps = {}, timeoutMs = 12_000 } = {}) {
  const out = { swept: 0, stamped: 0, failed: 0, timedOut: 0, results: [] }
  let rows = []
  try {
    rows = db.prepare(
      `SELECT account_id, is_live FROM accounts WHERE enabled = 1 ORDER BY account_id`,
    ).all()
  } catch { return out }

  const others = rows.filter(r => (r.is_live === 1) !== !!isLive)
  if (others.length === 0) return out
  out.swept = others.length

  // BOUNDED AND CONCURRENT, because this runs on the main trading loop.
  //
  // wsGetTrader allows 3 attempts at a 20s timeout with 2s+4s backoff — 66s
  // for ONE unreachable account. Run sequentially, three unreachable live
  // accounts would hold the cycle for 198s before scanning or dispatch
  // resumed, every reconcile pass, and an equity read that stalls trading is
  // worse than the wrong balance it set out to fix. So the reads go out
  // together and the whole sweep answers by `timeoutMs` whatever the broker
  // does. Accounts that beat the deadline still stamp — stampAccountEquity
  // writes as soon as it has an answer, so a slow straggler costs its own
  // result and nothing else.
  // The timer is CLEARED in the finally below rather than unref'd. unref was
  // the first attempt and it is subtly wrong: it lets the event loop exit
  // before the deadline fires, so the guarantee "this returns within
  // timeoutMs" would hold only while something ELSE kept the loop alive. A
  // bound that depends on unrelated work existing is not a bound.
  let timer = null
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('__deadline__'), timeoutMs)
  })

  try {
  const settled = await Promise.all(others.map(async (r) => {
    const task = stampAccountEquity(
      db,
      { ...creds, host: hostForSide(r.is_live === 1) },
      r.account_id,
      deps,
    )
    const won = await Promise.race([task, deadline])
    return won === '__deadline__'
      ? { accountId: String(r.account_id), balance: null, error: `no answer within ${timeoutMs}ms` }
      : { accountId: won.accountId, balance: won.balance, error: won.error }
  }))

  for (const res of settled) {
    out.results.push(res)
    if (res.error != null || res.balance == null) {
      out.failed++
      if (res.error?.startsWith('no answer within')) out.timedOut++
    } else out.stamped++
  }
  return out
  } finally {
    clearTimeout(timer)
  }
}
