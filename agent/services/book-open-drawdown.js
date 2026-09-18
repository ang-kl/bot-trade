// ---------------------------------------------------------------------------
// agent/services/book-open-drawdown.js — the momentum book's PER-ACCOUNT
// entry brake, measured on OPEN mark-to-market (PR-P, 16-09-2026).
//
// WHY A NEW MEASURE AND NOT ONE OF THE EXISTING BRAKES. Every automatic brake
// this repo has on a strategy reads CLOSED trades:
//
//   · adaptive-breaker.js   — 3 consecutive closed losses (per account since
//                             PR-B).
//   · edge-watchdog.js      — 15 own closes in a 20-close window, PF < 0.95.
//   · strategy-verdicts.js  — 30 own closes, judged by profit factor; it is
//                             already on the book's entry path, because every
//                             book entry goes through autoTrade() → the risk
//                             gate, which calls strategyVerdict at risk.js's
//                             clause 5b. Below 30 closes it returns `pending`
//                             (strategy-verdicts.js:78) — half risk, never a
//                             refusal.
//
// So the book is NOT ungated. It is gated on a clock it cannot reach. The
// book holds positions for 10–60 DAYS by construction (the daily cadence and
// the 24 h minimum hold are PR-K's whole point), so 3 closes is weeks, 15 is
// months and 30 is longer than the book has existed. Arming `tsmom_long` on
// all seven enabled accounts (PR-O, #908) multiplied that exposure by seven
// while leaving every automatic brake on the same slow clock. The pooled
// edge-watchdog / adaptive-breaker verdict is exempt on all of them, too,
// because arming a strategy on an account IS `isHandPinned`
// (stage-matrix.js) — only an account's OWN closed record still disarms it
// (stage-matrix.js's `ownVerdictScopes`), which is the same slow clock again.
//
// A brake that needs months on a 10–60 day strategy is decoration — CLAUDE.md
// failure mode #3, a guard whose trigger is out of reach of what it guards.
// This module measures the one thing that moves on the book's OWN horizon:
// how the positions it is ALREADY holding on that account are doing, right
// now, before they close.
//
// THE MEASURE. For each open book row on the account:
//
//     pnlR = (mark − entry) / risk0   × (+1 long, −1 short)
//
// `risk0` is the risk the row PUT UP at entry, never the trailed stop:
// trade_plans.risk_dist (written once at dispatch) first, then
// monitored_positions.initial_risk. Both are stamps from entry and neither
// moves afterwards.
//
// ALL OF THEM ARE PRICE DISTANCES, not money, and this file divides a price
// difference by them — the same arithmetic two existing readers already do,
// which is where the unit claim is checked rather than assumed:
//   · trade-plans.js scoreClosedPlans: `(exit − fill) * dir / r.risk_dist`
//     — and risk_dist is written as `Math.abs(entry − sl)` in recordTradePlan.
//   · position-manager.js rMultiple: `((currentPrice − entry_price) * dir) /
//     pos.initial_risk`.
// Both book entry paths write a plan: the market dispatch (loop.js, where
// autoTrade persists the trade) and the resting-limit fill
// (pending-orders.js). A row with NEITHER stamp — in practice a row inserted
// with `trade_id NULL`, which is never backfilled — is NOT measurable and is
// counted as unread. `stopAtr × momentum_book.atr` was the third fallback in
// the first draft and is GONE: the trail pass overwrites that `atr` with the
// CURRENT ATR on every improving trail, so the denominator grew with
// volatility and the brake quietly stopped firing during a vol expansion
// exactly when it was most needed (checker MINOR 4, 16-09-2026, verified:
// two rows at 50 % read 25 % after the ATR doubled). A denominator that
// drifts is not a risk stamp.
//
// The account's reading is the SUM of pnlR over measurable rows, expressed as
// a percentage of the risk those rows put up (one row = 1 R):
//
//     drawdownPct = −Σ pnlR / rowsMeasured × 100
//
// EXPRESSED AS A FRACTION OF RISK ON PURPOSE, not as an absolute R count. An
// absolute "down 4 R" threshold is unreachable on a book of two positions —
// each one's stop closes it at −1 R, so 4 R of open loss can never exist —
// and the guard would be decoration at exactly the sizes a newly-armed
// account has. As a fraction it fires at ANY row count: 50 % is two rows
// halfway to their stops, or eight rows an average of half a stop under
// water.
//
// ===========================================================================
// COVERAGE — WHY AN UNREAD ROW IS NOT A SAFE OMISSION (checker MAJOR 1)
// ===========================================================================
// The first draft excluded every row it could not read and then applied the
// threshold to whatever was left, on the reasoning that excluding a row
// cannot make the reading look better. That reasoning was WRONG, and the
// counterexample is not exotic:
//
//   6 rows, risk 10 each. B1–B4 sit at their stops (−1 R each) but their bars
//   never arrive, so they are `unmarked`. H1 and H2 are marked at +0.1 R.
//   The reading becomes `measured 2, drawdownPct −10` → NO BLOCK, on an
//   account carrying 4 R of open loss. Marked in full, the same book reads
//   63.3 % and blocks.
//
// If the rows that cannot be read are the ones that are bleeding, the healthy
// remainder BECOMES the reading. So a reading built on a minority of the
// account's open rows is not a reading at all, and the verdict is:
//
//   coverage = measured / carried rows.  Below `bookDrawdownMinCoveragePct`,
//   an account that is big enough to be judged (carried rows ≥ minRows) is
//   BLOCKED — not passed — and the reason says it is blocked because the
//   book cannot be SEEN, not because it is losing.
//
// WHAT THE FLOOR DOES NOT CLOSE, stated plainly because a guard whose limits
// are not written down gets read as absolute. Two gaps survive by design:
//   · AT the floor, not below it, the reading passes. At 60 % that leaves up
//     to 40 % of an account's rows unseen — 5 rows, 3 readable and flat, 2
//     unread at their stops reads 0 % and does NOT block, with 2 R of open
//     loss invisible. Raising the floor narrows this; only 100 % closes it.
//   · `drawdownPct` averages over `measured`, not over `rows`, so it is the
//     average of what can be SEEN. Seeing MORE of the same book dilutes the
//     figure (one row at −1 R reads 33.3 % across 3 measured, 20 % across 5).
// The floor bounds how much can hide behind those two; it does not remove
// them. What it does remove is the case that mattered — a small readable
// minority speaking for a large unreadable majority.
//
// FAIL CLOSED, DELIBERATELY, AND THE ARGUMENT FOR IT. Blocking an entry can
// only ever reduce exposure; being wrong costs one day of a book that decides
// once per day, and the decision is revertible from the running system with
// one POST. Adding exposure to a book nobody can price is the failure this
// module exists to prevent, and "unknown" is precisely the state in which the
// other three brakes are also silent. The one case that is NOT blocked is an
// account with nothing to be blind about: no open rows, or fewer open rows
// than could have produced a verdict anyway.
//
// AND IT IS LOUD EITHER WAY (checker MAJOR 2). Whenever anything on an
// account is unread — one row or all of them — a line reaches
// `summary.skipped` on EVERY pass: the block `reason` when it blocks, the
// `notice` when it does not. ONE line per account either way, because
// loop.js prints four and a second line saying the same thing costs another
// account its place (checker MINOR 1, second round). The line names the
// coverage AND THE CAUSE of every unread row — "symbol does not resolve on
// this account" and "no entry risk stamp (trade_id NULL)" are permanent and
// need an operator; "bars unavailable" and "never marked" clear themselves
// on the next healthy pass. A standing block whose cause cannot be read is a
// standing block someone disarms globally.
// The first draft emitted a reason ONLY when it blocked, so the case where
// the brake was blind was exactly the case that said nothing: a `deps.bars`
// that threw on every pass (broker unreachable, null symbolId, absent creds
// all take that path) carried the last marks forward until they aged past
// the TTL, at which point the brake went from blocking to open with no log
// line and no summary entry. Under this version that same sequence blocks on
// coverage and prints a line every pass.
//
// STALENESS IS MEASURED ON THE PRICE, NOT ON THE FETCH (checker MINOR 3).
// The mark carries both the bar's own epoch stamp (`bt`, from the trendbar's
// `utcTimestampInMinutes`, ctrader-ws.js) and the pass clock (`at`). Age is
// taken from `bt` when it is a plausible epoch, else from `at`, and the read
// says which basis it used. Stamping the fetch time alone meant a feed that
// kept answering with the SAME frozen bar was never stale to this guard —
// staleness could only fire when the fetch FAILED.
//
// WHAT IT NEVER TOUCHES. Entries only. Stops, rank exits, the `exit_pending`
// retry, the owed-exit sweep and the weekend bank are not read by this file
// and do not import it.
// ---------------------------------------------------------------------------

/**
 * The book state's mark key for one account/symbol.
 *
 * Both halves are percent-encoded so the separator cannot be forged: without
 * it `markKey('1', '1|AAA')` and `markKey('1|1', 'AAA')` are the same string
 * (checker NIT 8). Numeric broker account ids and ordinary symbols encode to
 * themselves, so this is a no-op on every key in production today.
 */
export const markKey = (accountId, symbol) =>
  `${encodeURIComponent(String(accountId))}|${encodeURIComponent(String(symbol).toUpperCase())}`

/** Epochs below this are not timestamps — the tests' bar index `t: 0..29`, or a zeroed field. */
export const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2015, 0, 1)

export const DEFAULT_BOOK_DRAWDOWN = Object.freeze({
  // The brake itself. Defaults ON: an off-by-default risk control on a
  // strategy that was just armed on seven accounts is the thing this file
  // exists to stop being.
  bookDrawdownOn: true,
  // Open loss, as a percentage of the risk the open rows put up, at or above
  // which the account takes no NEW book entries. 50 = the basket is halfway
  // to its stops. Conservative but reachable: one row at −0.5 R and one flat
  // does NOT trip it (25 %); two rows at −0.5 R each does.
  bookDrawdownPct: 50,
  // Never judge a basket on a single row. 2 is the smallest number that is
  // still a basket; it also means neither the drawdown verdict NOR the
  // coverage verdict can fire before the account's SECOND book position.
  bookDrawdownMinRows: 2,
  // The share of an account's open book rows that must be readable before
  // the drawdown reading counts as a reading. Below it the account is
  // blocked for blindness. 60 % leaves room for a couple of unmeasurable
  // rows on a full eight-slot book (5 of 8 readable still judges) while
  // refusing to let a healthy minority speak for a bleeding majority.
  bookDrawdownMinCoveragePct: 60,
  // A mark whose PRICE is older than this is not a reading. Generous on
  // purpose: the marks come from the book's timeframe bars ('1d'), whose
  // stamp is the bar's OPEN, so a live daily bar is already up to 24 h old
  // by this measure and a long weekend adds more. 168 h = 7 days; a mark
  // that old means the trail pass has not priced the row for a week, which
  // is a fault in its own right and is named in the reading.
  bookMarkMaxAgeHours: 168,
})

/**
 * A knob is its stored value only when that value is a real, finite number
 * INSIDE the range. Anything else — a cleared field, a string, Infinity, a
 * negative, a fat-fingered 5000 — falls back to the DEFAULT.
 *
 * It does NOT clamp to the nearest bound (checker NITs 7 and 9). Clamping
 * sends a nonsense value to an extreme: `-500` became the floor 1, which
 * freezes entries on every account from one un-confirmed field, and `5000`
 * became the ceiling 500, which is as good as off. Both are the most
 * dangerous reading of a typo. Falling back to the default is the only
 * answer that is the same for a typo in either direction, and it makes the
 * "the ceiling catches a fat finger" claim true, which the clamping version
 * only was for strings.
 */
const numOrDefault = (v, lo, hi, d) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d
}

/**
 * The five knobs, validated, from a raw config object. Merged into
 * momentumBookConfig so they live in the book's existing config and travel
 * through the same POST /actions/momentum-book merge as every other knob.
 */
export function bookDrawdownConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_BOOK_DRAWDOWN
  return {
    // `false` is the only way off. Anything else — including a cleared UI
    // field, which arrives as null or '' — leaves a risk control ON.
    bookDrawdownOn: r.bookDrawdownOn !== false,
    bookDrawdownPct: numOrDefault(r.bookDrawdownPct, 1, 500, d.bookDrawdownPct),
    // Ceiling 20, not 50 (checker MINOR 5): the book holds 8 slots, so any
    // value above that suppresses every verdict while `bookDrawdownOn` still
    // reads true — a second off-switch, and a quieter one than the real one.
    // 20 is still far above any real book; anything higher is a typo and
    // takes the default. The remaining suppression (minRows above the row
    // count on a small book) is NAMED by bookEntryBrake rather than silent.
    bookDrawdownMinRows: Math.round(numOrDefault(r.bookDrawdownMinRows, 1, 20, d.bookDrawdownMinRows)),
    // 0 is IN RANGE and means "do not judge coverage at all" — the explicit
    // way for an operator who disagrees with failing closed to turn that half
    // off without turning the drawdown half off with it.
    bookDrawdownMinCoveragePct: numOrDefault(r.bookDrawdownMinCoveragePct, 0, 100, d.bookDrawdownMinCoveragePct),
    bookMarkMaxAgeHours: numOrDefault(r.bookMarkMaxAgeHours, 1, 720, d.bookMarkMaxAgeHours),
  }
}

// CARRIED, NOT `open` (checker MAJOR 1, 16-09-2026). `exit_sent` means the
// close was SENT and not yet confirmed, and it is the status set the rest of
// the book already uses for still-carried exposure (momentumBookReport,
// momentumAccountReport, weekend-bank, naked-position-guard). Reading `open`
// alone meant that the moment the book decided an account's positions were
// bad and sent their exits, the account's reading dropped to `rows: 0` and
// the brake went silent AND open on the very next pass.
//
// BUT THE TRADE IS THE AUTHORITY ON WHETHER EXPOSURE STILL EXISTS, not the
// row's status — and that clause is load-bearing, not tidiness. NOTHING in
// this repo ever moves a row from `exit_sent` to `closed`: the only writer of
// `closed` is momentum-book.js's trail pass, which selects `status = 'open'`
// and therefore never revisits an exited row (`grep -rn "= 'closed'"` over
// momentum_book confirms it). So an account whose whole book was rank-exited
// would have carried those rows FOR EVER and been blocked for ever — a
// standing block created by the fix for the silent one. A row whose trade is
// closed is not exposure whatever the row says; a row with no trade id, or
// whose trade is still open, is.
//
// `trade_id` rides along so a row that can never be priced can say WHY, not
// just that it could not be.
const OPEN_ROWS_SQL = `
  SELECT b.symbol, b.side, b.entry_price, b.status, b.trade_id,
         (SELECT risk_dist FROM trade_plans WHERE trade_id = b.trade_id) AS plan_risk,
         (SELECT initial_risk FROM monitored_positions WHERE trade_id = b.trade_id ORDER BY id DESC LIMIT 1) AS mp_risk
    FROM momentum_book b
   WHERE b.status IN ('open', 'exit_sent') AND b.account_id = ?
     AND COALESCE((SELECT t.status FROM trades t WHERE t.id = b.trade_id), 'open') NOT IN ('closed', 'rejected', 'cancelled')`

/**
 * The risk one row put up at entry, in PRICE units, or null when no stamp
 * from entry exists. Never the row's `stop` (that is the TRAILED stop and
 * shrinks, or inverts, as the trade works) and never `atr × stopAtr` (the
 * trail overwrites `atr`, so it drifts with volatility — see the header).
 */
export function initialRiskOf(row) {
  for (const v of [row?.plan_risk, row?.mp_risk]) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/**
 * How far in the future a stamp may sit and still be a stamp. Clock skew
 * between this process and the broker's bar clock is seconds; five minutes is
 * generous and still far short of anything that could hide a stale price.
 */
export const FUTURE_STAMP_TOLERANCE_MS = 5 * 60_000

/**
 * The age of a mark's PRICE, in ms, preferring the bar's own stamp over the
 * fetch clock.
 *
 * A NEGATIVE age is not freshness (checker MINOR 4). The staleness test is
 * `age <= maxAge`, so a stamp in the future passed it for ever — a mark
 * stamped 10 years ahead was permanently fresh, which is the mirror image of
 * the frozen-feed defect `bt` was added to catch. A stamp beyond the skew
 * tolerance is treated as no stamp at all and falls through to the next
 * source, then to `none`.
 */
export function markAgeMs(mark, now) {
  const usable = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && now - n >= -FUTURE_STAMP_TOLERANCE_MS ? n : null
  }
  const bt = usable(mark?.bt)
  if (bt != null && bt >= MIN_PLAUSIBLE_EPOCH_MS) return { ms: Math.max(0, now - bt), basis: 'bar' }
  const at = usable(mark?.at)
  if (at != null) return { ms: Math.max(0, now - at), basis: 'fetch' }
  // No readable stamp at all: not fresh, not usable, and never silently fresh.
  return { ms: Infinity, basis: 'none' }
}

/**
 * The account's open book reading. Pure apart from the one read.
 *
 * @returns {{rows:number, measured:number, unmarked:number, unpriced:number,
 *            staleMarks:number, coveragePct:number|null, oldestStaleHours:number|null,
 *            ageBasis:string|null, openR:number|null, drawdownPct:number|null}}
 */
export function bookOpenDrawdown(db, { accountId, marks = {}, markFail = {}, bookCfg = {}, now = Date.now() } = {}) {
  const out = {
    rows: 0, measured: 0, unmarked: 0, unpriced: 0, staleMarks: 0, exitSent: 0,
    coveragePct: null, oldestStaleHours: null, ageBasis: null, openR: null, drawdownPct: null,
    readError: null, causes: {},
  }
  let rows = []
  // A READ THAT FAILED IS NOT AN EMPTY BOOK (checker MAJOR 3). This query
  // subselects trade_plans and monitored_positions, so schema drift on either
  // used to return `rows: 0`, take the "nothing to be blind about" carve-out
  // and turn the whole control off — silently. It is now carried out as its
  // own state, which bookEntryBrake blocks and names.
  try { rows = db.prepare(OPEN_ROWS_SQL).all(String(accountId)) } catch (err) {
    out.readError = String(err?.message || err).slice(0, 120)
    return out
  }
  out.rows = rows.length
  if (!rows.length) return out
  const cfg = bookDrawdownConfig(bookCfg)
  const maxAgeMs = cfg.bookMarkMaxAgeHours * 3_600_000
  const bases = new Set()
  let sum = 0
  let oldestStale = 0
  // WHY a row could not be read, counted by cause. The remedy for "this
  // symbol does not resolve on this account" is nothing like the remedy for
  // "the broker was down this pass" or "this row has no entry risk stamp and
  // never will", and a bare count of unread rows cannot tell them apart
  // (checker MAJOR 2).
  const cause = (why) => { out.causes[why] = (out.causes[why] || 0) + 1 }
  for (const row of rows) {
    if (String(row.status) === 'exit_sent') out.exitSent++
    const entry = Number(row.entry_price)
    const risk0 = initialRiskOf(row)
    // NOT measurable: no entry price, or no risk stamp from entry. Counted,
    // never read as flat — reading it flat is what let a healthy minority
    // speak for a bleeding majority (header, MAJOR 1).
    if (!(entry > 0) || risk0 == null) {
      out.unpriced++
      cause(row.trade_id == null
        ? 'no entry risk stamp (trade_id NULL — this row can never be priced)'
        : 'no entry risk stamp (no trade plan or initial risk for its trade)')
      continue
    }
    const key = markKey(accountId, row.symbol)
    const m = marks?.[key]
    const mark = Number(m?.c)
    if (!(mark > 0)) {
      out.unmarked++
      cause(markFail?.[key] ? String(markFail[key]) : 'never marked (the trail pass has not priced it yet)')
      continue
    }
    const age = markAgeMs(m, now)
    if (!(age.ms <= maxAgeMs)) {
      out.staleMarks++
      cause(markFail?.[key] ? `stale — ${String(markFail[key])}` : 'stale (the price is older than bookMarkMaxAgeHours)')
      if (Number.isFinite(age.ms)) oldestStale = Math.max(oldestStale, age.ms)
      continue
    }
    bases.add(age.basis)
    const dir = String(row.side) === 'short' ? -1 : 1
    sum += ((mark - entry) * dir) / risk0
    out.measured++
  }
  out.coveragePct = Math.round((out.measured / out.rows) * 1000) / 10
  if (out.staleMarks) out.oldestStaleHours = oldestStale > 0 ? Math.round((oldestStale / 3_600_000) * 10) / 10 : null
  if (bases.size) out.ageBasis = bases.has('fetch') && bases.has('bar') ? 'mixed' : [...bases][0]
  if (out.measured === 0) return out
  // `+ 0` normalises negative zero: a flat basket must report 0, not -0, in
  // the read an operator sees and in the JSON the report serialises.
  out.openR = Math.round(sum * 100) / 100 + 0
  // Positive = drawdown. A basket in PROFIT reads negative, which no
  // threshold >= 1 can ever meet — the drawdown half is one-sided by
  // construction. NOTE the denominator is `measured`, not `rows`: this is the
  // average of what can be SEEN, so seeing more of the same book dilutes it
  // (one row at -1 R reads 33.3 % across 3 measured and 20 % across 5). The
  // coverage floor bounds how much can be hidden that way; it does not
  // eliminate it. See the header.
  out.drawdownPct = Math.round((-sum / out.measured) * 1000) / 10 + 0
  return out
}

/**
 * `4 of 6 carried row(s) unread, coverage 33.3% — 3× symbol does not resolve
 * on this account, 1× no entry risk stamp (trade_id NULL …)`
 *
 * The CAUSES are the point, not the count (checker MAJOR 2): a standing block
 * an operator cannot diagnose is a standing block they will disarm globally.
 */
function unreadPhrase(read) {
  const causes = Object.entries(read.causes || {}).sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n}× ${why}`)
  return `${read.rows - read.measured} of ${read.rows} carried row(s) unread, coverage ${read.coveragePct}%`
    + (causes.length ? ` — ${causes.join('; ')}` : '')
    + (read.oldestStaleHours != null ? ` (oldest stale price ${read.oldestStaleHours} h)` : '')
}

const TAIL = ' Exits, stops, the exit_pending retry and the owed-exit sweep are untouched.'

/**
 * May this account take a NEW momentum-book entry?
 *
 * @returns {{block:boolean, reason:string|null, notice:string|null, read:object}}
 *   `reason` — why entries are refused; present only when `block`.
 *   `notice` — what an operator needs to know when nothing is being refused:
 *              rows that could not be read, or a verdict that a knob
 *              suppressed. NULL when `block` is true, because the reason
 *              already carries the same phrase and the loop prints only four
 *              lines (checker MINOR 1) — one account must cost one line.
 */
export function bookEntryBrake(db, { accountId, marks = {}, markFail = {}, bookCfg = {}, now = Date.now() } = {}) {
  // Re-validated HERE, not trusted from the caller (checker NIT 6): the
  // clamps are this module's stated defence, and a future caller that hands
  // in a raw config object must not be able to hand in `bookDrawdownPct:
  // 1e9` and get `block: false` out of a guard that believed it.
  const cfg = bookDrawdownConfig(bookCfg)
  const read = bookOpenDrawdown(db, { accountId, marks, markFail, bookCfg: cfg, now })
  const info = {
    ...read,
    limitPct: cfg.bookDrawdownPct,
    minRows: cfg.bookDrawdownMinRows,
    minCoveragePct: cfg.bookDrawdownMinCoveragePct,
    markMaxAgeHours: cfg.bookMarkMaxAgeHours,
    on: cfg.bookDrawdownOn,
  }
  const open = (notice = null) => ({ block: false, reason: null, notice, read: info })
  const blocked = (reason) => ({ block: true, reason: `${reason}${TAIL}`, notice: null, read: info })
  // OFF is the operator's explicit word, and a brake that is off has nothing
  // to report — a notice every pass on a switch someone deliberately set is
  // noise, not loudness. The route logs `entryBrake=OFF` when it is set.
  if (!cfg.bookDrawdownOn) return open()
  // A READ THAT FAILED, not an empty book (checker MAJOR 3). Fail closed and
  // say so: a `catch` that returns "nothing here" turns this control off
  // completely, which is the one outcome this module exists to prevent.
  if (read.readError) {
    return blocked(`open book UNREADABLE — the book query failed (${read.readError}), so this account's exposure cannot be measured at all; no NEW momentum-book entries until it can.`)
  }
  if (read.rows === 0) return open()
  const unread = read.rows - read.measured
  // TOO SMALL TO JUDGE. An account with fewer carried rows than could ever
  // produce a verdict is not being judged — neither on drawdown nor on
  // blindness. Blocking it for blindness would be a stricter stance on one
  // row than the drawdown half takes, which is incoherent.
  if (read.rows < cfg.bookDrawdownMinRows) {
    // …but `bookDrawdownMinRows` is itself an off-switch, and a silent one
    // (checker MINOR 5): set above the book's slot count it suppresses every
    // verdict while `bookDrawdownOn` still reads true. When it suppresses a
    // verdict that WOULD have blocked, say so.
    if (read.drawdownPct != null && read.drawdownPct >= cfg.bookDrawdownPct) {
      return open(`momentum book: open drawdown ${read.drawdownPct}% would have refused new entries, but bookDrawdownMinRows ${cfg.bookDrawdownMinRows} > ${read.rows} carried row(s) — the brake is suppressed by that knob, not by the book being healthy`)
    }
    return open(unread > 0 ? `momentum book: ${unreadPhrase(read)} — too few carried rows to judge` : null)
  }
  // BLIND. The reading is built on a minority of the account's carried rows,
  // so it is not the account's reading. Fail closed — see the header.
  if (cfg.bookDrawdownMinCoveragePct > 0 && !(read.coveragePct >= cfg.bookDrawdownMinCoveragePct)) {
    return blocked(`open book UNREADABLE — ${unreadPhrase(read)} < the ${cfg.bookDrawdownMinCoveragePct}% needed to judge this account; no NEW momentum-book entries while the book cannot be priced.`)
  }
  const notice = unread > 0 ? `momentum book: ${unreadPhrase(read)} — the entry brake reads only what it can see` : null
  if (read.measured < cfg.bookDrawdownMinRows || read.drawdownPct == null) return open(notice)
  if (!(read.drawdownPct >= cfg.bookDrawdownPct)) return open(notice)
  return blocked(`open book drawdown ${read.drawdownPct}% of the risk put up (>= ${cfg.bookDrawdownPct}%) across ${read.measured} of ${read.rows} carried row(s), coverage ${read.coveragePct}%`
    + `${unread > 0 ? ` — ${unreadPhrase(read)}` : ''}; no NEW momentum-book entries on this account until it recovers or a position closes.`)
}
