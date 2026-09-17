// Is every open position actually protected RIGHT NOW?
//
// WHY THIS EXISTS (owner report, 2026-07-29). An ETHUSD short closed carrying
// the reason "stopped beyond the SL — gap/slippage through the stop". It had
// no stop loss at all: `sl_price` was NULL, and reconciler.js's classifier
// read `Number(null)` as 0 rather than "absent", so `exit > 0` was true for
// every short and stamped a stop that never existed. That bug is fixed at its
// source. This module addresses the larger gap the owner actually pointed at.
//
// The system had guards for the MOMENT of action and none for the STATE:
//
//   · risk.js refuses to open without a bracket
//   · manual-position-guards.js refuses to ADD to a naked position
//   · /actions/position-protect can attach a bracket on demand
//
// but nothing ever asked, of the positions already open, "is this one still
// protected?" A bracket can go missing after entry — an amend that failed, a
// broker-side cancellation, a position adopted from the broker that never had
// one, a partial close that dropped the remainder's stop. Every one of those
// leaves capital exposed silently, and the ledger's own close reason was
// actively reassuring about it.
//
// BROKER TRUTH, NOT OUR BOOKKEEPING. Reading `monitored_positions.current_sl`
// alone would only prove we THINK there is a stop. What protects money is the
// stop the broker is holding, so `brokerPositions` (already fetched every
// reconcile pass) is the authority, and a disagreement between the two is
// itself reportable — arguably the more dangerous state, because the UI shows
// a stop that will not fire.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TAKE-PROFIT REQUIREMENT, APPLIED TO POSITIONS WE DID NOT OPEN
//
// exec-engine.js refuses a market order with no take profit attached
// (`guard_no_target`, owner-approved 2026-07-22: SL-only was never enough to
// call a trade managed). But that guard fires at SUBMISSION, and an ADOPTED
// position never passes through it — the reconciler takes it from broker
// truth, brackets and all, or brackets and none. So the one rule the owner
// asked for most explicitly was the one rule adopted positions were exempt
// from. The 0003.HK pair found on 2026-07-29 had stops and no targets.
//
// It cannot be enforced retroactively — a position is already open — so the
// equivalent is to detect it and, since 04-08-2026, to FIX it.
//
// THAT LAST PART REVERSES A DECISION MADE HERE, and the reversal is the point.
// This module used to say, in as many words, that it would not attach a target
// itself: "choosing a take-profit price is a strategy judgement … a guessed one
// closes trades at a level nothing supports, which is worse than none at all."
// That was right about guessing and wrong about the conclusion, because the
// alternative shipped was not "a human decides" — it was a Telegram button
// nobody taps. Owner, 04-08-2026: "SO MANY POSITIONS WITH NO TARGET SET",
// pasting six. §43 requires protection to have its own functioning path, and a
// target that materialises only if someone happens to be looking at their phone
// is not one.
//
// What changed underneath is that the guess is gone: tp-suggest.js computes a
// target from real volume structure (the HVN work, #163), and the alert has
// been printing it for days. Applying the number we already trust enough to
// recommend is a smaller step than continuing to recommend it and do nothing.
//
// STILL DELIBERATELY NOT DONE:
//
//   · touching a position opened OUTSIDE the bot (`source === 'external'`).
//     That is the owner's own trade and their own exit; choosing one for them
//     is overruling a decision nobody asked us about.
//   · inventing a target when the suggester returns nothing. No target is
//     better than an unsupported one — that half of the original reasoning
//     stands unchanged.
//   · ALERT on a take-profit DISAGREEMENT the way it alerts on a stop
//     disagreement. Targets are amended constantly in normal operation — the
//     profit keeper ratchets them, partial ladders move them — so a mismatch
//     alert would fire during ordinary work. A check that cries wolf during
//     normal operation trains the owner to ignore it, which is the same
//     outcome as not having it. MISSING is unambiguous; different is not.
//     Since 02-09-2026 the disagreement IS measured — `tpDrift`, counted in
//     the audit record and nowhere else — because "not alerted" had quietly
//     become "not looked at", and a book that disagrees with the broker on
//     the exit is a fact worth having on record even when it is not a fault.
// ─────────────────────────────────────────────────────────────────────────────
import { getState, setState } from '../db.js'
import { makeBookHeldCheck } from './book-held.js'
import { normPosId } from '../lib/pos-id.js'

/** Alert at most this often per position, so a persistent gap does not spam. */
const MUTE_MS = Math.max(60_000, Number(process.env.NAKED_ALERT_MUTE_MS) || 3600_000)

// A missing target is a management gap, not live unbounded risk — the stop
// still caps the loss. So it alerts on a slower cadence than a naked position,
// and never with the siren.
const TARGET_MUTE_MS = Math.max(60_000, Number(process.env.TARGETLESS_ALERT_MUTE_MS) || 6 * 3600_000)

const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

/**
 * Compare our open book against broker truth.
 *
 * @param {Array} openRows   rows with { id, symbol, trade_id, ctrader_position_id, current_sl, account_id, source }
 * @param {Array} brokerPositions  [{ positionId, stopLoss, takeProfit }]
 * @returns {{naked:Array, targetless:Array, phantom:Array, tpDrift:Array, checked:number, unmatched:number}}
 *   naked      — no stop at the broker: real, live, unprotected exposure
 *   targetless — stop present, no take profit: the order-time rule, unmet
 *   phantom    — we show a stop the broker is not holding: the UI is lying
 *   tpDrift    — both hold a target and they differ by more than 0.1% of
 *                price. REPORT ONLY: counted in the audit record, never
 *                alerted and never written to action_log, because the
 *                keeper's ratchet and partial ladders move targets in
 *                normal operation and a siren that fires then gets ignored.
 *                Until 02-09-2026 the target was not compared at all, so a
 *                book/broker disagreement on the exit was invisible.
 */
export function auditProtection(openRows = [], brokerPositions = []) {
  const byId = new Map()
  for (const p of brokerPositions || []) {
    if (p?.positionId != null) byId.set(String(p.positionId), p)
  }

  const naked = []
  const targetless = []
  const phantom = []
  const tpDrift = []
  let unmatched = 0

  for (const row of openRows) {
    const pid = row?.ctrader_position_id == null ? null : String(row.ctrader_position_id)
    const bp = pid ? byId.get(pid) : null
    if (!bp) {
      // No broker position to compare against. NOT reported as naked: the
      // reconciler owns "open here, absent there" and calling it unprotected
      // would double-report a different fault as this one.
      unmatched++
      continue
    }
    const brokerSl = num(bp.stopLoss)
    const ourSl = num(row.current_sl)

    if (brokerSl == null || brokerSl === 0) {
      naked.push({
        monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
        positionId: pid, accountId: row.account_id ?? null,
        ourSl,
        detail: ourSl != null
          // The worse of the two: our book shows protection, the broker holds
          // none. Anyone reading the UI believes this position is covered.
          ? `we show a stop at ${ourSl} but the broker holds NONE — this position is unprotected and the UI says otherwise`
          : 'no stop loss at the broker and none on record — this position is unprotected',
      })
    } else {
      if (ourSl != null && Math.abs(brokerSl - ourSl) > Math.abs(brokerSl) * 0.001) {
        phantom.push({
          monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
          positionId: pid, accountId: row.account_id ?? null,
          ourSl, brokerSl,
          detail: `stop disagreement — we show ${ourSl}, the broker holds ${brokerSl}`,
        })
      }
      // Only asked of positions that HAVE a stop. A naked position needs a
      // stop first; adding "and no target either" underneath the siren is
      // noise on top of an emergency.
      const brokerTp = num(bp.takeProfit)
      if (brokerTp == null || brokerTp === 0) {
        const src = row.source || 'unknown'
        targetless.push({
          monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
          positionId: pid, accountId: row.account_id ?? null,
          source: src, brokerSl,
          detail: src === 'external'
            // Opened by hand at the broker, so it never met the order-time
            // rule and arguably was never meant to. Still reported — the
            // owner asked to see unmanaged exposure, not just the bot's.
            ? `no take profit at the broker (opened outside the bot) — stop at ${brokerSl}, no target`
            : `no take profit at the broker — an order placed through the bot could not have been submitted this way (guard_no_target); this one was adopted, so the guard never saw it`,
        })
      } else {
        // Both sides hold a target: compare them. Same 0.1%-of-price band
        // as the stop check above; a book target that was never recorded is
        // the "never recorded" case, not drift.
        const ourTp = num(row.current_tp)
        if (ourTp != null && ourTp !== 0 && Math.abs(brokerTp - ourTp) > Math.abs(brokerTp) * 0.001) {
          tpDrift.push({
            monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
            positionId: pid, accountId: row.account_id ?? null,
            ourTp, brokerTp,
            detail: `target disagreement — we show ${ourTp}, the broker holds ${brokerTp} (report only)`,
          })
        }
      }
    }
  }
  return { naked, targetless, phantom, tpDrift, checked: openRows.length, unmatched }
}

/** Which findings are due an alert, given the mute window. Pure — testable. */
export function dueForAlert(findings, lastAlertMap, nowMs, muteMs = MUTE_MS) {
  return findings.filter(f => {
    const last = Number(lastAlertMap?.[String(f.positionId)] || 0)
    return !(last > 0) || (nowMs - last) >= muteMs
  })
}

const STATE_KEY = 'naked_position_alerts_json'
const TARGET_STATE_KEY = 'targetless_position_alerts_json'
const LOG_STATE_KEY = 'protection_log_writes_json'
const LAST_AUDIT_KEY = 'protection_audit_last_json'

// ─────────────────────────────────────────────────────────────────────────────
// THE APPLY WINDOW IS ITS OWN MAP, AND THAT IS THE WHOLE FIX (16-09-2026).
//
// Measured in production: `17 targetless` on every pass, stable for 4.5 days,
// with exactly ONE `target SET` line across 12-09 → 16-09. The applier worked;
// it almost never got to run.
//
// Why: `lastTargetAlerts` was doing two jobs at once — "do not re-alert this
// position for 6h" AND "do not re-attempt a target on this position for 6h" —
// while TWO callers stamp it at very different rates. The fast monitor's
// runProtectionAuditAllAccounts pass runs every ~60s and was never given an
// applier (no production caller set `deps.auditOpts`; grep found it only in
// tests). The loop pass, which DOES carry suggestTarget/applyTarget, runs every
// ~3–5 min. So whenever a 6-hour window expired, the 60-second path that COULD
// NOT apply consumed it first, and the path that could found everything muted.
// A guard whose trigger is out of reach of what it guards.
//
// Splitting the maps makes the invariant structural rather than a matter of
// which caller happens to win a race:
//
//   A FINDING ELIGIBLE FOR A TARGET CANNOT BE MUTED BY A PASS THAT COULD NOT
//   HAVE APPLIED ONE.
//
// Only a pass holding an `applyTarget` ever stamps this map, and it stamps only
// the findings it actually worked. A pass with no applier leaves it untouched,
// so it cannot consume the next pass's window. The alert map keeps its own job
// and its own cadence, unchanged.
//
// Stamped on ATTEMPT, not on success: a bar fetch plus an amend per position
// per window is the cost this bounds, and a persistently refused amend must not
// become a 60-second retry storm against the broker.
// ─────────────────────────────────────────────────────────────────────────────
const APPLY_STATE_KEY = 'targetless_apply_attempts_json'
/**
 * How long a TRANSIENT refusal waits before the position is tried again.
 *
 * The claim is stamped BEFORE the amend, which is what closes the two-pass
 * race — but it meant a sixty-second WS blip muted a position for the full six
 * hours. Measured in the review's cost run: three positions refused on a read
 * failure, all three then unreachable for six hours, because the prune only
 * clears a stamp once the position stops being targetless and a refused
 * position stays targetless.
 *
 * So the window is reason-dependent. A refusal the broker will still give the
 * same answer to tomorrow — it already holds a target, the read says another
 * position, the stop is on the wrong side — keeps the full window. A refusal
 * that is about REACHING the broker gets this one instead: long enough not to
 * be a retry storm, short enough that a blip is not a working day.
 */
const TARGET_APPLY_RETRY_MS = Math.max(
  60_000, Number(process.env.TARGET_APPLY_RETRY_MS) || 5 * 60_000,
)
/**
 * Most positions one pass will work.
 *
 * LOWERED FROM 3 TO 1 UNTIL IT IS MEASURED (17-09-2026, third review). The
 * original 3 was a latency estimate made BEFORE the applier grew a live
 * pre-amend broker read, and the review measured what that costs: the work is
 * serial and additive, `maxConcurrent` 1, elapsed = the sum. Each apply opens a
 * fresh WS session, and `wsReconcile` is `withRetry(..., 2)` at a 25s timeout
 * with 2s/4s backoff — 81s worst case for ONE read. At 4 accounts × 3 that is
 * twelve live reads inside a 60s band.
 *
 * One per account per pass still clears a 17-position backlog inside twenty
 * minutes, on positions that have been targetless for days. The band budget in
 * fast-monitor.js is the hard stop; this is the part that keeps it from being
 * needed. Raise it when someone has measured a real pass, not before.
 */
export const MAX_APPLY_PER_PASS = Math.max(1, Number(process.env.TARGET_APPLY_MAX_PER_PASS) || 1)
const TARGET_APPLY_MUTE_MS = Math.max(
  60_000, Number(process.env.TARGET_APPLY_MUTE_MS) || 6 * 3600_000,
)

/** How often one position+kind may re-enter action_log. See the write loop. */
const LOG_MUTE_MS = Math.max(60_000, Number(process.env.PROTECTION_LOG_MUTE_MS) || 3600_000)

/**
 * THE BOOK EXEMPTION LIVES IN `book-held.js` NOW (16-09-2026, review).
 *
 * This module and `weekend-bank.js` each carried their own copy of the same
 * query, and the copies were one commit from diverging: this one was corrected
 * to ask by trade id as well (a book row whose `position_id` is still NULL —
 * the resting-limit path — is otherwise not exempt at all), while the weekend
 * bank's copy kept the hole and would have CLOSED that runner ahead of a
 * weekend. One rule, one place; see book-held.js for the rule and the
 * measurements on both sides.
 *
 * Re-exported so callers and tests that name these keep working and there is
 * still exactly one definition behind them.
 */
export { bookHeldPositionIds, bookHeldTradeIds, makeBookHeldCheck } from './book-held.js'

/**
 * Each account is audited against its OWN broker snapshot, so each needs its
 * own record — a single global key would mean whichever account ran last
 * silently overwrote the rest, and the panel would report one account's book
 * as if it were the whole one.
 */
const auditKeyFor = (accountId) =>
  (accountId == null || accountId === '' ? LAST_AUDIT_KEY : `acct:${accountId}:${LAST_AUDIT_KEY}`)

/**
 * THE MUTE MAPS ARE PER ACCOUNT TOO — and for a sharper reason than the audit
 * record above (owner, 04-08-2026: three targetless alerts pasted back, two of
 * them the identical USDBRL position).
 *
 * They were global while this pass runs once per account, and the prune step at
 * the end of the pass deletes every entry whose position is not in THIS pass's
 * findings. So account A alerted and stamped its ids, then account B's pass
 * pruned them away as "no longer open" — and A re-alerted on the next cycle,
 * for ever. The mute window was not merely leaky; between two accounts it was
 * cancelled outright.
 *
 * Scoping the map makes the prune correct by construction: a pass only ever
 * sees, stamps and prunes the account it is auditing.
 */
const muteKeyFor = (accountId, key) =>
  (accountId == null || accountId === '' ? key : `acct:${accountId}:${key}`)

/**
 * Run the audit, record it, apply targets where it may, and alert on anything
 * newly unprotected.
 *
 * Never throws: a protection AUDIT that can crash the loop would remove more
 * safety than it adds.
 *
 * @param {object} opts
 * @param {Function|null} opts.suggestTarget  (finding) => {tp, basis}|null
 * @param {Function|null} opts.applyTarget    (finding, suggestion) => {ok}
 * @param {number} opts.applyMuteMs   how long before the same position may be
 *   re-attempted. Its OWN window, stamped only by a pass holding an applier —
 *   see APPLY_STATE_KEY.
 * @param {Set<string>|string[]|null} opts.applyExcludeIds  position ids whose
 *   repair belongs to another path in this same sweep (target-restore puts back
 *   the target the bot RECORDED, which beats a fresh structural guess). Excluded
 *   so one pass never sends two amends to one position.
 */
export async function runProtectionAudit(db, openRows, brokerPositions, {
  nowMs = Date.now(), sendMessage = null, muteMs = MUTE_MS, targetMuteMs = TARGET_MUTE_MS,
  logMuteMs = LOG_MUTE_MS, accountId = null, suggestTarget = null, applyTarget = null,
  applyMuteMs = TARGET_APPLY_MUTE_MS, applyExcludeIds = null,
  maxApplyPerPass = MAX_APPLY_PER_PASS,
} = {}) {
  try {
    const audit = auditProtection(openRows, brokerPositions)

    const readMap = (key) => {
      try { return JSON.parse(getState(db, key) || '{}') } catch { return {} }
    }
    const lastAlerts = readMap(muteKeyFor(accountId, STATE_KEY))
    const lastTargetAlerts = readMap(muteKeyFor(accountId, TARGET_STATE_KEY))

    const due = dueForAlert(audit.naked, lastAlerts, nowMs, muteMs)
    const targetDue = dueForAlert(audit.targetless, lastTargetAlerts, nowMs, targetMuteMs)

    const KIND = new Map()
    for (const f of audit.naked) KIND.set(f, 'POSITION_UNPROTECTED')
    for (const f of audit.targetless) KIND.set(f, 'POSITION_NO_TARGET')
    for (const f of audit.phantom) KIND.set(f, 'POSITION_STOP_MISMATCH')

    // THE DURABLE TRAIL IS RATE-LIMITED TOO. It was not: the mute windows
    // above gate Telegram only, so this loop wrote a row for EVERY finding on
    // EVERY pass. protection_audit is loop-tied, so one standing condition
    // emitted a row every few minutes for as long as it lasted —
    // POSITION_STOP_MISMATCH in particular, because until the reconciler
    // learned to converge a standing disagreement (see reconciler.js) nothing
    // could ever clear it, so it logged forever.
    //
    // One row per position per kind per LOG_MUTE_MS still reconstructs
    // duration — a position naked for six hours leaves six rows, which is
    // enough to answer "how long was it exposed" — while a page of
    // action_log stops being one position repeating itself.
    const logMutes = readMap(muteKeyFor(accountId, LOG_STATE_KEY))
    for (const [f, method] of KIND) {
      const key = `${method}|${f.positionId}`
      const last = Number(logMutes[key] || 0)
      if (last > 0 && (nowMs - last) < logMuteMs) continue
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          method, '/protection-audit', JSON.stringify(f).slice(0, 2000),
        )
        logMutes[key] = nowMs
      } catch { /* audit best-effort */ }
    }

    if (due.length && typeof sendMessage === 'function') {
      const lines = due.map(f => `· ${f.symbol} (position ${f.positionId}) — ${f.detail}`)
      try {
        await sendMessage(
          `\u{1F6A8} ${due.length} OPEN POSITION${due.length > 1 ? 'S' : ''} WITH NO STOP LOSS\n${lines.join('\n')}\n\nSet one with POST /actions/position-protect, or close the position.`
        )
        for (const f of due) lastAlerts[String(f.positionId)] = nowMs
      } catch { /* a failed alert must not lose the audit */ }
    }

    // ── THE THREE LOAD-BEARING EXEMPTIONS, IN ONE PLACE ──
    //
    // Hoisted out of the Telegram branch along with the apply loop below, so
    // they are evaluated once and asked by the applier, the alert lines, the
    // buttons and the stdout breakdown from the same answer. They are:
    //
    //  · A HUMAN'S OWN POSITION — the owner's hand-placed trade. Choosing an
    //    exit for it would be the bot overruling a decision it was never asked
    //    about. NEVER touched.
    //
    //    `external` AND `manual` (16-09-2026, review). Every other guard in
    //    this system pairs the two as "the human's own" — profit-keeper.js and
    //    loss-guardian.js both do — and this one did not, so a position the
    //    owner placed through the bot's manual route was amended while the
    //    identical position placed at the broker was not. The distinction the
    //    old test drew is about which DOOR the order came through, which is
    //    not a fact about whose decision the exit is. Matched
    //    case-insensitively: `reconciler.js` writes lowercase today, so an
    //    upper- or mixed-case `source` is latent rather than live, but an
    //    exemption that turns on the casing of a string column is not one to
    //    leave sharp.
    //  · a momentum-book row (09-09-2026) — exits by the trail, never by a
    //    target. The right tail is the whole edge (plan principle 2), and a
    //    1.5R floor on a position meant to run for weeks caps exactly that.
    //    Measured: three 0005.HK rows on ACCT-DEMO-1/2/3 were given a target
    //    at 09:36 SGT with nothing on stdout to say so. Reported, never
    //    amended — the same shape as the weekend bank's exemption (#851).
    //
    //    ASKED BY POSITION ID *AND* TRADE ID (16-09-2026, review), because the
    //    position-id question fails OPEN on a book row whose `position_id` is
    //    still NULL — the resting-limit path. See bookHeldTradeIds above.
    //  · no computable suggestion — no target is better than an invented one.
    //    Checked in the apply loop, where the suggestion is in hand.
    //
    // MAKING THE APPLIER REACHABLE MUST NOT MAKE IT REACH THESE. The first two
    // are decided before a suggestion is even requested, so an exempt position
    // costs no bar fetch and can reach no amend by any path.
    const HUMAN_SOURCES = new Set(['external', 'manual'])
    const humanOwned = (f) => HUMAN_SOURCES.has(String(f.source || '').trim().toLowerCase())
    // SCOPE NOTE, STATED IN BOTH PLACES (17-09-2026, third review).
    // `accountId` defaults to null here, and null means "ask across every
    // account" — so an unscoped audit pass treats a book row on ANY account as
    // held. That is the conservative direction for THIS guard (the cost of
    // over-exempting is a position that keeps its stop and gains no target),
    // and it is the OPPOSITE of the choice weekend-bank.js makes with the same
    // helper, where over-exempting means not closing before a gap. Two guards,
    // two costs, two defaults — written down in both files so the difference
    // reads as a decision rather than an inconsistency.
    const bookHolds = makeBookHeldCheck(db, accountId)
    const bookHeldFinding = (f) => bookHolds(f.positionId, f.tradeId)
    const excluded = applyExcludeIds instanceof Set
      ? applyExcludeIds
      : new Set((applyExcludeIds || []).map(String))
    const applyEligible = (f) =>
      !humanOwned(f) &&
      !bookHeldFinding(f) &&
      !excluded.has(String(f.positionId))

    // Owner 01-08: propose a concrete price with a one-tap Set-TP button
    // instead of only pointing at the curl. Memoised per finding so a position
    // that is both applied and alerted in the same pass fetches bars ONCE, and
    // so an exempt position never fetches them at all.
    const suggestions = new Map()
    const getSuggestion = async (f) => {
      if (suggestions.has(f)) return suggestions.get(f)
      let s = null
      if (typeof suggestTarget === 'function') {
        try {
          const r = await suggestTarget(f)
          if (r && Number(r.tp) > 0) s = r
        } catch { /* a failed suggestion must not lose the alert */ }
      }
      suggestions.set(f, s)
      return s
    }

    // ── APPLY IT, DON'T ONLY ASK (owner, 04-08-2026: "SO MANY POSITIONS WITH
    // NO TARGET SET") ──
    //
    // OUT OF THE TELEGRAM BRANCH (16-09-2026). This loop used to be nested
    // inside `if (targetDue.length && typeof sendMessage === 'function')`, so
    // with TELEGRAM_BOT_TOKEN unset the bot set no targets at all. Setting
    // protection is not a notification; §43 asks protection to have its own
    // functioning path, and one that depends on a chat token is not one.
    //
    // ON ITS OWN MUTE MAP, so a pass with no applier cannot consume the window
    // of the pass that has one — see APPLY_STATE_KEY above for the measurement.
    //
    // STILL BOUNDED THE SAME WAY: only positions the bot owns, only where a
    // suggestion actually computed, never a book row, never an external one.
    // And a take profit can only ever close in profit, so the worst case is a
    // suboptimal exit, never a loss the position would not otherwise have taken.
    const applied = new Map()
    const applyFailed = new Set()
    const noSuggestion = new Set()
    const deferred = new Set()
    const applyMuteKey = muteKeyFor(accountId, APPLY_STATE_KEY)

    // ── ONE POSITION, ONE AMEND. THE CLAIM IS THE LOCK (16-09-2026, review) ──
    //
    // The first draft read the mute map once, computed the whole due list from
    // that snapshot, stamped into the in-memory object and persisted only at
    // the end of the pass. Two doors to a double amend, both measured:
    //
    //  · TWO PASSES. The ~60s sweep and the loop's pass interleave on the
    //    `await` inside getSuggestion. Both read an empty window, both amend:
    //    `['loop:P1','sweep:P1']`. This PR is what opened that door — before
    //    it, the sweep had no applier to race with.
    //  · TWO ROWS, ONE PASS. Two `monitored_positions` rows carrying the same
    //    `ctrader_position_id` produce two findings with the same positionId,
    //    both measured against the pre-pass map, so both amend. This repo
    //    ships `findOpenDuplicates` and `duplicate-watch` precisely because
    //    duplicate open rows happen.
    //
    // `claimApply` is the fix and it is deliberately SYNCHRONOUS end to end:
    // read, test, stamp and persist with no `await` anywhere inside it.
    // better-sqlite3 is synchronous, so a read-modify-write with no suspension
    // point cannot interleave with another pass in this process — the claim is
    // durable BEFORE the amend is attempted, not after it returns. A failed
    // write returns false and no amend follows: no claim, no amend.
    const claimApply = (pid) => {
      const m = readMap(applyMuteKey)
      const last = Number(m[pid] || 0)
      if (last > 0 && (nowMs - last) < applyMuteMs) return false
      m[pid] = nowMs
      try { setState(db, applyMuteKey, JSON.stringify(m)) } catch { return false }
      return true
    }
    // Shorten a claim already made, for a refusal that is about reaching the
    // broker rather than about the position. Rewinding the stamp rather than
    // deleting it keeps the window bounded: the next attempt is
    // TARGET_APPLY_RETRY_MS away, not on the next 60-second pass.
    const backOffApply = (pid) => {
      const m = readMap(applyMuteKey)
      m[pid] = nowMs - Math.max(0, applyMuteMs - TARGET_APPLY_RETRY_MS)
      try { setState(db, applyMuteKey, JSON.stringify(m)) } catch { /* non-fatal */ }
    }

    if (typeof applyTarget === 'function') {
      // Belt and braces on door 2: the claim already rejects the second row of
      // a duplicate pair (its stamp is `nowMs`, so the window test is 0 < w),
      // but that makes correctness depend on `applyMuteMs > 0`, which is a
      // caller's argument. The explicit set does not.
      const seen = new Set()
      let workedThisPass = 0
      for (const f of audit.targetless) {
        if (!applyEligible(f)) continue
        const pid = String(f.positionId)
        if (seen.has(pid)) continue
        // A FRESH-BOOT BAND, NOT A FRESH-BOOT STALL (review). Nothing is
        // stamped at boot, so pass one would otherwise run a bar fetch plus an
        // amend for every targetless position, sequentially, per account — at
        // 2–4s a round trip, 17 of them blow past the fast monitor's 60s band
        // and park `protection_band` at ok:false. The work is spread over
        // passes instead; the window only ever delays a repair, and the
        // positions in question have been targetless for days.
        if (workedThisPass >= maxApplyPerPass) { deferred.add(f); continue }
        if (!claimApply(pid)) continue
        seen.add(pid)
        workedThisPass++
        const s = await getSuggestion(f)
        if (!s) { noSuggestion.add(f); continue }
        try {
          const r = await applyTarget(f, s)
          if (r && r.ok) {
            applied.set(f, s)
            // The Telegram line was the only record. A target that appears
            // on a position must be attributable from the log too.
            console.log(`[protection] ${accountId ?? '?'}: target SET on ${f.symbol} (position ${f.positionId}) — TP ${s.tp} (${s.basis})`)
          } else {
            applyFailed.add(f)
            // `retryable` marks a refusal about REACHING the broker. The
            // applier is the only layer that can tell those apart, so it says
            // so rather than leaving this one to parse an error string.
            if (r && r.retryable) backOffApply(pid)
          }
        } catch {
          // A throw is always transient from here: nothing was established
          // about the position, so nothing justifies a six-hour silence.
          applyFailed.add(f)
          backOffApply(pid)
        }
      }
    }

    // ── WHAT CLASS IS EACH TARGETLESS POSITION? ──
    //
    // Production logged `17 targetless` every pass for 4.5 days and nothing
    // else. That number cannot distinguish a momentum-book row holding no
    // target BY DESIGN from a position that lost its target and should get one
    // back, so nobody reading the log could tell whether it was a standing fact
    // or a standing fault — which is exactly how it sat for days. The breakdown
    // already existed in memory and went only to Telegram.
    if (audit.targetless.length) {
      const counts = new Map()
      const bump = (k) => counts.set(k, (counts.get(k) || 0) + 1)
      //
      // EVERY CLASS NAMES WHAT THIS PASS DID, NOT WHAT ANOTHER PASS MIGHT DO
      // (16-09-2026, review). The `excluded` class used to read "book target
      // restored elsewhere", asserting an outcome this function cannot observe
      // — measured against the real target-restore, it said that over 0-of-3
      // repairs with the restore switched off, 0-of-1 with a NULL entry_price
      // and 0-of-1 with a recorded target on the wrong side of entry, three of
      // which are PERMANENT starvation rather than delay. The sweep now only
      // defers a position that target-restore will actually act on (it asks
      // `restoreEnabled` and `planTargetRestore` directly), and the class says
      // "deferred to" — the routing, which is true — with the OUTCOME logged
      // by the sweep after the restore has run.
      for (const f of audit.targetless) {
        if (humanOwned(f)) bump(`${String(f.source || 'unknown').toLowerCase()} (left alone — the human's own)`)
        else if (bookHeldFinding(f)) bump('momentum-book (trail only)')
        else if (excluded.has(String(f.positionId))) bump('bot-owned (deferred to target-restore)')
        else if (applied.has(f)) bump('bot-owned (target applied)')
        else if (applyFailed.has(f)) bump('bot-owned (apply refused)')
        else if (noSuggestion.has(f)) bump('bot-owned (no target computable)')
        else if (deferred.has(f)) bump('bot-owned (over this pass’s work cap)')
        else if (typeof applyTarget !== 'function') bump('bot-owned (NO APPLIER WIRED)')
        else bump('bot-owned (apply window not yet due)')
      }
      const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, n]) => `${n} ${k}`)
      console.log(`[protection] ${accountId ?? '?'}: ${audit.targetless.length} targetless — ${parts.join(', ')}`)
    }

    // Separate message, no siren: a stop is in place, so this is a management
    // gap rather than an emergency. Batched into one so a book with several
    // targetless positions produces one line per position, not one alert each.
    if (targetDue.length && typeof sendMessage === 'function') {
      // A null suggestion degrades to the instruction-only line — the alert
      // never waits on structure. Exempt findings are not asked for one: the
      // line already says why they are left alone, and a suggestion there would
      // only mint a button that must never be offered.
      for (const f of targetDue) {
        if (applyEligible(f)) await getSuggestion(f)
      }
      const lines = targetDue.map(f => {
        const s = suggestions.get(f)
        if (applied.has(f)) return `· ${f.symbol} (position ${f.positionId}) — TP SET to ${s.tp} (${s.basis})`
        if (bookHeldFinding(f)) return `· ${f.symbol} (position ${f.positionId}) — stop ${f.brokerSl}, no target · momentum-book row, exits by trail, left alone`
        return `· ${f.symbol} (position ${f.positionId}) — stop ${f.brokerSl}, no target${humanOwned(f) ? ' · opened outside the bot, left alone' : ''}` +
          (s ? `\n  suggested TP ${s.tp} (${s.basis})` : '')
      })
      // One button row per suggested position. callback_data is capped at 64
      // bytes by Telegram — `prottp|<id>|<price>` fits comfortably.
      // No button for a target already set — offering to do what was just done
      // is how an operator learns to distrust the buttons.
      //
      // `suggestions` now memoises MISSES as null too, so the test is the
      // VALUE, not `.has()` — `.has()` would mint a button for a finding whose
      // suggester returned nothing and then read `.tp` off null.
      //
      // The `applyEligible` term is an EQUIVALENT MUTANT today and is stated as
      // one rather than defended as a pinned guard (review: deleting it leaves
      // every test green). It cannot change the output while exempt findings
      // are never asked for a suggestion, so `suggestions.get(f)` is already
      // falsy for all of them. It is kept because a button is the same amend by
      // another door and this is the last line before one, but nothing here
      // claims a test proves it.
      const buttons = targetDue
        .filter(f => suggestions.get(f) && !applied.has(f) && applyEligible(f))
        .map(f => [{ text: `Set TP ${suggestions.get(f).tp} on ${f.symbol}`, callback_data: `prottp|${f.positionId}|${suggestions.get(f).tp}` }])
      try {
        await sendMessage(
          `\u{26A0}\u{FE0F} ${targetDue.length} OPEN POSITION${targetDue.length > 1 ? 'S' : ''} WITH NO TAKE PROFIT${applied.size ? ` — ${applied.size} SET AUTOMATICALLY` : ''}\n${lines.join('\n')}\n\nThese were adopted from the broker, so the entry guard never saw them. The bot now sets a target on its OWN adopted positions where it can compute one; anything opened outside the bot is left for you. Tap a button below, or set your own with POST /actions/position-protect {positionId, tp}.`,
          buttons.length ? { buttons } : undefined,
        )
        for (const f of targetDue) lastTargetAlerts[String(f.positionId)] = nowMs
      } catch { /* a failed alert must not lose the audit */ }
    }

    // Forget positions that are no longer open, so the mute maps cannot grow
    // without bound across a long-running process.
    const prune = (map, findings) => {
      const live = new Set(findings.map(f => String(f.positionId)))
      for (const k of Object.keys(map)) if (!live.has(k)) delete map[k]
    }
    prune(lastAlerts, audit.naked)
    prune(lastTargetAlerts, audit.targetless)

    // ── THE APPLY WINDOW IS PRUNED ONLY BY EVIDENCE (16-09-2026, review) ──
    //
    // The generic prune above drops every stamp whose position is absent from
    // THIS pass's findings. For the alert maps that is right. For the apply
    // window it is a retry storm: a position missing from the broker SNAPSHOT
    // is `unmatched` — checked against nothing, repaired by nobody — and
    // dropping its stamp hands back the whole six-hour window. Measured on one
    // account with 17 targetless positions: a stable snapshot costs 17 fetches
    // and 17 amends an hour; a snapshot flickering every other pass turned that
    // into 510 of each, against a permanently refused amend. `rec?.position ||
    // []` upstream has no completeness check, so an empty snapshot is exactly
    // the shape this has to survive.
    //
    // So a stamp is dropped only when the snapshot PROVES the repair landed:
    // the position is IN the broker snapshot and no longer in `targetless`.
    // Absent from the snapshot proves nothing and keeps its stamp. Expired
    // stamps are swept on age so the map still cannot grow without bound.
    {
      const brokerIds = new Set(
        (brokerPositions || []).map(p => p?.positionId).filter(v => v != null).map(String))
      const stillTargetless = new Set(audit.targetless.map(f => String(f.positionId)))
      const persisted = readMap(applyMuteKey)
      for (const k of Object.keys(persisted)) {
        // Verified repaired — a position that loses its target AGAIN is a fault
        // to act on at once, not one to sit out the rest of an old window.
        if (brokerIds.has(k) && !stillTargetless.has(k)) { delete persisted[k]; continue }
        const t = Number(persisted[k] || 0)
        if (!(t > 0) || (nowMs - t) > applyMuteMs * 4) delete persisted[k]
      }
      try { setState(db, applyMuteKey, JSON.stringify(persisted)) } catch { /* non-fatal */ }
    }
    // Same bound for the log mutes, but keyed `KIND|positionId`, so drop any
    // key whose finding is no longer present in THIS pass — a position that
    // gets its stop back should log immediately if it ever loses it again.
    {
      const live = new Set([...KIND].map(([f, method]) => `${method}|${f.positionId}`))
      for (const k of Object.keys(logMutes)) if (!live.has(k)) delete logMutes[k]
    }
    try {
      setState(db, muteKeyFor(accountId, STATE_KEY), JSON.stringify(lastAlerts))
      setState(db, muteKeyFor(accountId, TARGET_STATE_KEY), JSON.stringify(lastTargetAlerts))
      setState(db, muteKeyFor(accountId, LOG_STATE_KEY), JSON.stringify(logMutes))
    } catch { /* non-fatal */ }

    // ¶D·2 — the audit must never simply go quiet. See recordAuditUnavailable.
    try {
      setState(db, auditKeyFor(accountId), JSON.stringify({
        at: new Date(nowMs).toISOString(),
        ok: true,
        accountId: accountId == null ? null : String(accountId),
        checked: audit.checked,
        unmatched: audit.unmatched,
        naked: audit.naked.length,
        targetless: audit.targetless.length,
        phantom: audit.phantom.length,
        tpDrift: audit.tpDrift.length,
      }))
    } catch { /* non-fatal */ }

    return {
      ...audit,
      alerted: due.length,
      targetAlerted: targetDue.length,
      // How many targets this pass actually put on the broker. The old return
      // said only how many were ALERTED — which is how "the applier is wired"
      // and "the applier ran" stayed indistinguishable from the caller's side
      // for 4.5 days.
      targetsApplied: applied.size,
    }
  } catch (err) {
    return {
      naked: [], targetless: [], phantom: [], tpDrift: [], checked: 0, unmatched: 0,
      alerted: 0, targetAlerted: 0, targetsApplied: 0, error: err.message,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ¶D·2 — "Position protection audit — idle."
//
// That is what the owner saw during the 2026-07-29 broker outage, and it is
// the wrong thing to see. The audit lives inside the reconcile phase and only
// runs once broker truth is in hand; when the broker was unreachable it did
// not run, so it reported nothing — which on screen is indistinguishable from
// "checked everything, all clear". A safety check that goes silent exactly
// when the system is degraded is worse than one that was never built, because
// the silence reads as reassurance.
//
// So: every outcome is recorded, including "could not check", and the reader
// always gets the LAST KNOWN state with its AGE attached. Old news labelled as
// old news is honest. A blank is not.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record that the audit could not run this cycle, and why.
 * Called from the loop when broker truth never arrived.
 */
export function recordAuditUnavailable(db, reason, { nowMs = Date.now(), accountId = null } = {}) {
  const key = auditKeyFor(accountId)
  let prev = {}
  try { prev = JSON.parse(getState(db, key) || '{}') } catch { prev = {} }
  try {
    setState(db, key, JSON.stringify({
      // The last SUCCESSFUL check is preserved verbatim — that is the state
      // the reader needs, and overwriting it with the failure would destroy
      // the only thing worth reporting during an outage.
      ...(prev.ok ? prev : { ...prev, at: prev.at ?? null }),
      ok: prev.ok === true,
      lastAttemptAt: new Date(nowMs).toISOString(),
      lastAttemptOk: false,
      lastAttemptError: String(reason || 'unknown').slice(0, 300),
    }))
  } catch { /* non-fatal */ }
}

/**
 * Sum every per-account audit record into one whole-book view.
 *
 * REWRITTEN 02-09-2026 (consistency audit). The panel read "as of 41,315 min
 * ago — NOT CONFIRMED SINCE 22-08" while the heartbeat beat every 60 s and
 * the action log showed successful audits that morning. Three merge rules
 * produced that, each reasonable alone:
 *   - `at` was the OLDEST record of any age, so one account nobody can audit
 *     any more (a live account while demo credentials are selected) pinned
 *     the whole book at 04-08 for ever;
 *   - counts were summed across fresh and stale records, so a month-old
 *     `targetless: 6` sat beside today's `phantom: 2`;
 *   - the failure surfaced was the FIRST record with lastAttemptOk=false in
 *     rowid order — the GLOBAL key the loop writes on a blocked reconcile,
 *     which no per-account success ever overwrites.
 *
 * Now: records are partitioned by the same freshness the reader applies.
 * `at` is the oldest FRESH record (the stalest-account rule still holds
 * among accounts that are actually being audited); counts are summed over
 * fresh records only; accounts whose record is stale are LISTED, with their
 * own age, so a healthy account cannot mask them — they are named, not
 * averaged in. With nothing fresh the old behaviour stands. A failure counts
 * only while it is newer than the success that would have superseded it:
 * per-account records are overwritten by their own success, so theirs
 * always counts; the global key's counts only if it is newer than every
 * success on the book.
 */
function mergeAccountAudits(db, { nowMs = Date.now(), expectedSec = 900, staleFactor = 3 } = {}) {
  let rows = []
  try {
    rows = db.prepare(
      `SELECT key, value FROM agent_state
        WHERE key = ? OR key LIKE 'acct:%:' || ?`
    ).all(LAST_AUDIT_KEY, LAST_AUDIT_KEY)
  } catch { return {} }

  const parsed = []
  for (const r of rows) {
    try { const v = JSON.parse(r.value || '{}'); if (v && typeof v === 'object') parsed.push(v) } catch { /* skip junk */ }
  }
  if (!parsed.length) return {}
  // The GLOBAL key's success record predates per-account records (M2);
  // once any account has its own, the global one is a fossil — it would
  // otherwise be listed as a stale account called "?" for ever. It still
  // carries failures (the loop writes them there), which are judged below.
  const perAccount = parsed.filter(p => p.ok === true && p.at && p.accountId != null)
  const ran = perAccount.length ? perAccount : parsed.filter(p => p.ok === true && p.at)
  if (!ran.length) {
    // Nothing has completed anywhere — surface the most recent failure so the
    // reason is visible rather than a bare "never run".
    const failed = parsed.filter(p => p.lastAttemptAt).sort((a, b) => String(b.lastAttemptAt).localeCompare(String(a.lastAttemptAt)))
    return failed[0] || parsed[0]
  }
  const maxAgeMs = expectedSec * staleFactor * 1000
  const ageOf = (p) => nowMs - Date.parse(p.at)
  const fresh = ran.filter(p => Number.isFinite(ageOf(p)) && ageOf(p) <= maxAgeMs)
  const use = fresh.length ? fresh : ran
  const staleAccounts = fresh.length
    ? ran.filter(p => !fresh.includes(p)).map(p => ({
      accountId: p.accountId ?? null, at: p.at, ageSec: Math.max(0, Math.round(ageOf(p) / 1000)),
      checked: Number(p.checked) || 0, naked: Number(p.naked) || 0, targetless: Number(p.targetless) || 0, phantom: Number(p.phantom) || 0,
    })).sort((a, b) => b.ageSec - a.ageSec)
    : []
  const sum = (k) => use.reduce((n, p) => n + (Number(p[k]) || 0), 0)
  const oldest = use.map(p => p.at).sort()[0]
  const newestSuccessMs = Math.max(...ran.map(p => Date.parse(p.at)).filter(Number.isFinite))
  const failing = parsed
    .filter(p => p.lastAttemptOk === false && p.lastAttemptAt)
    .filter(p => {
      const t = Date.parse(p.lastAttemptAt)
      if (!Number.isFinite(t)) return false
      // Per-account: its own success would have overwritten it, so still failing.
      if (p.accountId != null) return true
      // Global key: superseded by any later success anywhere on the book.
      return t > newestSuccessMs
    })
    .sort((a, b) => String(b.lastAttemptAt).localeCompare(String(a.lastAttemptAt)))
  const stillFailing = failing[0]
  return {
    at: oldest, ok: true,
    accounts: use.length,
    accountsStale: staleAccounts.length,
    staleAccounts,
    checked: sum('checked'), unmatched: sum('unmatched'),
    naked: sum('naked'), targetless: sum('targetless'), phantom: sum('phantom'),
    ...(stillFailing ? {
      lastAttemptAt: stillFailing.lastAttemptAt,
      lastAttemptOk: false,
      lastAttemptError: stillFailing.lastAttemptError,
    } : {}),
  }
}

/**
 * The last known protection state, with its age and whether it is stale.
 * Never returns an empty/blank answer — see the header above.
 *
 * @param {number} expectedSec  how often the audit is expected to run
 *   (reconcile is every 3rd loop, so the caller passes loopSec × 3)
 */
export function lastProtectionAudit(db, { nowMs = Date.now(), expectedSec = 900, staleFactor = 3, accountId = null } = {}) {
  let last = {}
  if (accountId != null) {
    try { last = JSON.parse(getState(db, auditKeyFor(accountId)) || '{}') } catch { last = {} }
  } else {
    // No account asked for: report the WHOLE book by summing every account's
    // record. Age is taken from the OLDEST of the FRESH ones, because a
    // portfolio is only as freshly verified as its stalest audited account —
    // and accounts whose record has gone stale are named in `staleAccounts`
    // rather than pinning the age, so a healthy account cannot mask them and
    // an unauditable one cannot mask the healthy ones (02-09-2026).
    last = mergeAccountAudits(db, { nowMs, expectedSec, staleFactor })
  }

  const at = Date.parse(last.at || '')
  const hasRun = Number.isFinite(at)
  const ageSec = hasRun ? Math.max(0, Math.round((nowMs - at) / 1000)) : null
  const stale = !hasRun || ageSec > expectedSec * staleFactor

  const attemptFailed = last.lastAttemptOk === false
  const mins = ageSec == null ? null : Math.round(ageSec / 60)

  let summary
  if (!hasRun) {
    // The critical case. NOT "idle" — idle sounds like a resting state, and
    // this one means no position has ever been verified as protected.
    summary = attemptFailed
      ? `never completed — last attempt failed: ${last.lastAttemptError}`
      : 'never run — no open position has been verified as protected'
  } else {
    const found = [
      last.naked ? `${last.naked} with NO stop` : null,
      last.targetless ? `${last.targetless} with no take profit` : null,
      last.phantom ? `${last.phantom} stop disagreement${last.phantom > 1 ? 's' : ''}` : null,
    ].filter(Boolean)

    // UNMATCHED IS NOT "FINE". A row the broker snapshot never mentioned was
    // not verified — it was skipped. Saying "all protected" while every row
    // went unmatched is the precise false reassurance this module exists to
    // prevent, and it is what staging reported on 2026-07-29 03:19:
    // "4 position(s) checked, all protected" when all four were unmatched
    // because the snapshot belonged to a different account.
    const checked = Number(last.checked) || 0
    const unmatched = Number(last.unmatched) || 0
    const verified = Math.max(0, checked - unmatched)

    let body
    if (checked > 0 && verified === 0) {
      body = `${checked} position(s) open but NONE could be checked against broker truth — nothing is verified`
    } else if (found.length) {
      body = `${verified} of ${checked} position(s) verified — ${found.join(', ')}`
    } else {
      body = unmatched > 0
        ? `${verified} of ${checked} position(s) verified, all protected — ${unmatched} could not be matched to broker truth`
        : `${checked} position(s) checked, all protected`
    }
    const age = `${mins} min ago`
    summary = attemptFailed
      // The whole point: say what is known AND that it is no longer being
      // confirmed, in one line, rather than showing nothing.
      ? `${body} (as of ${age}) — NOT CONFIRMED SINCE: ${last.lastAttemptError}`
      : `${body} (${age})`
    // Accounts the audit has not reached within the freshness window are
    // named, not averaged into the age above.
    const staleAccts = Array.isArray(last.staleAccounts) ? last.staleAccounts : []
    if (staleAccts.length) {
      const worst = Math.round(staleAccts[0].ageSec / 60)
      summary += ` — ${staleAccts.length} account(s) NOT audited for up to ${worst} min: ${staleAccts.map(a => a.accountId ?? '?').join(', ')}`
    }
  }

  return {
    hasRun,
    ok: last.ok === true,
    // How many accounts this figure covers, when it is a whole-book read.
    accounts: last.accounts ?? null,
    accountsStale: last.accountsStale ?? null,
    staleAccounts: Array.isArray(last.staleAccounts) ? last.staleAccounts : [],
    at: hasRun ? last.at : null,
    ageSec,
    stale,
    checked: last.checked ?? null,
    naked: last.naked ?? null,
    targetless: last.targetless ?? null,
    phantom: last.phantom ?? null,
    unmatched: last.unmatched ?? null,
    lastAttemptAt: last.lastAttemptAt ?? null,
    lastAttemptOk: last.lastAttemptOk ?? null,
    lastAttemptError: last.lastAttemptError ?? null,
    summary,
  }
}

// ---------------------------------------------------------------------------
// PROTECTION AUDIT ON ITS OWN PATH — every enabled account, off the main loop.
//
// Operating Goal Plan §43, the one Non-Negotiable Rule:
//
//   "A position must never be considered safely managed merely because the
//    main strategy loop is running. Protection, active management, broker
//    reconciliation and emergency authority must each have their own
//    functioning and observable path."
//
// The audit did not have one. It ran inside the loop's per-account reconcile
// block, sharing a heartbeat with order_monitor, and both went stalled at the
// same instant on 2026-08-04 — 961s old against a 314s expectation — because
// the phase that carries them had not completed. §70.7 names this exact
// failure: "Ensure the five-minute strategy loop is never the sole position
// protector."
//
// This is that second path. It runs from the fast monitor, which has its own
// 3-second ticker, its own overlap guard, and no dependency on the loop — it
// is in fact where the loop's OWN watchdog lives, so it keeps running when
// the loop is wedged. Cadence is a wall clock, not a tick count.
//
// The loop-side audit is deliberately LEFT IN PLACE. Two paths asking "is this
// position still protected" is the point; the audit only reads and alerts, so
// a duplicate pass costs a muted alert at worst, and §43 asks for redundancy
// rather than a handover.
//
// Per-account, against that account's OWN broker snapshot. Auditing every
// account's rows against one account's positions marks the rest `unmatched` —
// checked but never verified — which staging showed on 2026-07-29 as
// "all protected" over four unaudited positions.
// Broker refusals that mean "this credential cannot reach that account" —
// never "that account is in trouble". Kept narrow on purpose: anything not
// listed here is treated as a real audit failure, which is the safe default.
const UNAUTHORISED_CODES = [
  'CH_ACCESS_TOKEN_INVALID', 'CH_ACCESS_TOKEN_EXPIRED', 'ACCOUNT_NOT_AUTHORIZED',
  'NOT_AUTHENTICATED', 'CH_CLIENT_AUTH_FAILURE',
  // ADDED 08-08-2026. `CANT_ROUTE_REQUEST` is the broker refusing to route to
  // an account this session was never authorised for — the disabled LIVE
  // account ACCT-LIVE-1, which is still swept because `manage_only` accounts hold
  // open positions and dropping them from the audit would stop checking whether
  // those positions have stops. So it belongs in the same class as the token
  // codes above: a fact about ACCESS, not about exposure. Left out of the list,
  // it counted as a real audit failure and parked protection_audit in `warn` —
  // the "always amber, so nobody reads it" failure this list exists to prevent.
  'CANT_ROUTE_REQUEST',
]
const UNAUDITABLE_RE = new RegExp(UNAUTHORISED_CODES.join('|'))

/**
 * @returns {{accounts:number, naked:number, targetless:number, phantom:number,
 *            targetsRestored:number, targetsSet:number,
 *            errors:string[], unauditable:string[]}}
 */
export async function runProtectionAuditAllAccounts(db, baseCreds, deps = {}) {
  const out = { accounts: 0, naked: 0, targetless: 0, phantom: 0, tpDrift: 0, targetsRestored: 0, targetsSet: 0, stopsAdopted: 0, errors: [], unauditable: [], blind: false }
  if (!baseCreds?.ready) return out

  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const { getEnabledAccounts } = await import('./account-registry.js')

  let roster = []
  try {
    // One credential set reaches one host: a demo token cannot read a live
    // account's positions, so only the same side is swept.
    const isLive = !!baseCreds.isLive
    roster = getEnabledAccounts(db)
      .filter(a => (a.is_live === 1) === isLive)
      .map(a => String(a.account_id))
  } catch { roster = [] }

  const primary = baseCreds.accountId != null ? String(baseCreds.accountId) : null
  const ids = [...new Set([...(primary ? [primary] : []), ...roster])]
  if (!ids.length) return out

  // THE NUMERATOR MUST COUNT THE SAME SET AS THE DENOMINATOR (review, 08-08).
  // `out.accounts` counts any id in `ids` that reconciled, and `ids` prepends
  // `primary` with no enabled test — so one reachable NON-roster account defeats
  // `blind` for the whole obliged set: a disabled-but-selected account
  // reconciles fine (the sidecar authorises it, ctrader-creds.js:45), every
  // ENABLED account is refused, and the sweep beats green having verified
  // nothing it was obliged to verify. One account short of the alarm firing.
  const obliged = new Set(roster)
  let reachedObliged = 0

  const stmt = db.prepare(
    // current_tp / side / entry_price are read by services/target-restore.js:
    // the recorded target it may put back, and the two fields that prove the
    // target is the right side of the entry. Without them the restore plan
    // skips every position for want of data it was never given — a repair
    // out of reach of what it repairs.
    `SELECT mp.id, mp.trade_id, mp.symbol, mp.current_sl, mp.current_tp, mp.side,
            mp.entry_price, mp.account_id, mp.source,
            t.ctrader_position_id
       FROM monitored_positions mp
       LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL
        AND (mp.account_id = ? OR mp.account_id IS NULL)`
  )

  for (const id of ids) {
    try {
      const creds = id === primary ? baseCreds : { ...baseCreds, accountId: id }
      if (!creds?.ready) continue
      const rec = await exec.reconcile(creds)
      const positions = rec?.position || []
      const openRows = stmt.all(String(id))
      // No local rows AND no broker positions is a genuinely clean account —
      // but a broker position with no local row is exactly what the audit is
      // for, so an empty openRows does not skip the pass.
      if (!openRows.length && !positions.length) {
        out.accounts++
        if (obliged.has(String(id))) reachedObliged++
        // RECORD THE CLEAN PASS (02-09-2026). This branch used to skip the
        // per-account record, so an account with nothing open read as "NOT
        // audited for 12h" the moment the whole-book merge started naming
        // stale accounts — a false alarm minted by the fix that removed the
        // false reassurance. Nothing open, verified nothing open, said so.
        try {
          setState(db, auditKeyFor(id), JSON.stringify({
            at: new Date(deps.nowMs ?? Date.now()).toISOString(), ok: true, accountId: String(id),
            checked: 0, unmatched: 0, naked: 0, targetless: 0, phantom: 0,
          }))
        } catch { /* non-fatal */ }
        continue
      }
      const brokerSl = positions.map(p => ({
        positionId: p.positionId,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
      }))
      let sendMessage = null
      if (process.env.TELEGRAM_BOT_TOKEN) {
        sendMessage = (await import('./telegram.js')).sendMessage
      }
      // ── GIVE THIS PATH THE APPLIER (16-09-2026) ──
      //
      // This sweep runs from the fast monitor every ~60s and reaches EVERY
      // enabled account; the loop pass that carried the suggester/applier runs
      // every ~3–5 min and only on accounts the loop reaches. No production
      // caller ever set `deps.auditOpts` — grep found it in tests only — so
      // this, the faster and wider of the two paths, was calling the audit
      // with no way to act on what it found, while still burning the shared
      // mute window. §43: protection must have its own functioning path, and
      // this IS the second path. It had the fact and not the hand.
      //
      // Everything the suggester needs is already here: `creds` is scoped to
      // THIS account (so the bar fetch and the amend can never land on
      // another), and `positions` is the raw broker snapshot with `tradeData`
      // intact, which `brokerSl` above has already flattened away.
      //
      // ONE PASS, ONE AMEND PER POSITION. `restoreMissingTargets` below puts
      // back the target the bot itself RECORDED, which is a more faithful
      // repair than a fresh structural suggestion — so any position it will
      // handle is excluded here rather than amended twice in the same sweep
      // with the second write silently overwriting the first.
      //
      // ASK WHAT RESTORE WILL ACTUALLY DO, NOT WHETHER A NUMBER IS PRESENT
      // (16-09-2026, review). This set was built from `current_tp > 0` alone,
      // which is not the same question. Measured against the real
      // target-restore: with the restore switched off it starved 3 of 3; with
      // a NULL `entry_price`, 1 of 1; with a recorded target on the wrong side
      // of entry, 1 of 1 — and all three are PERMANENT, not a delay, because
      // nothing about them changes on the next sweep. So the exclusion now
      // runs restore's own two exported deciders, `restoreEnabled` and
      // `planTargetRestore`. A position restore will not repair is not deferred
      // to it; the structural applier takes it instead of nobody taking it.
      // A partially-injected `deps.targetRestore` overlays the real module
      // rather than replacing it, so a test that stubs only
      // `restoreMissingTargets` still gets the real deciders — the alternative
      // is a stub silently changing which repair path a position takes.
      const restoreMod = { ...(await import('./target-restore.js')), ...(deps.targetRestore || {}) }
      const slByPosition = new Map(brokerSl.map(p => [String(p.positionId), p.stopLoss]))
      const restoreOn = restoreMod.restoreEnabled(db)
      const restorable = new Set(
        !restoreOn ? [] : openRows
          .filter(r => r.ctrader_position_id != null &&
            restoreMod.planTargetRestore(r, { brokerSl: slByPosition.get(String(r.ctrader_position_id)) ?? null }).action === 'restore')
          .map(r => String(r.ctrader_position_id)),
      )
      const { makeTargetSuggester, makeTargetApplier } = deps.tpSuggest ?? await import('./tp-suggest.js')
      const prot = await runProtectionAudit(db, openRows, brokerSl, {
        sendMessage,
        accountId: id,
        suggestTarget: makeTargetSuggester(db, creds, positions),
        applyTarget: makeTargetApplier(db, creds, {
          // THE STOP IS RE-READ LIVE IMMEDIATELY BEFORE EACH AMEND.
          //
          // NOT THROUGH `exec.reconcile` (17-09-2026, second review). The first
          // version injected exactly that — the same function that produced
          // `positions` above — and in cpp mode, which production runs, it
          // serves the sidecar's `lastReconcileJson`: a string refreshed only
          // by the sidecar's own 30-second loop and never by an amend. So the
          // "fresh" read returned the snapshot it was checking, the "the stop
          // moved" branch could not fire, and a stop ratcheted by the profit
          // keeper earlier in the SAME 60-second band was written back wider.
          // The identity write of a cache is not the identity write of the
          // broker; `lib/fill-anchor.test.js` pins this same rule for fills.
          //
          // `wsReconcile` queries the broker. Injectable for tests, so no test
          // has to reach a real socket — but the production default is the live
          // path on both engines.
          readPosition: async (finding) => {
            const wsReconcile = deps.wsReconcile
              ?? (await import('../lib/ctrader-ws.js')).wsReconcile
            const fresh = await wsReconcile(
              creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
            return (fresh?.position || [])
              .find(p => normPosId(p?.positionId) === normPosId(finding.positionId)) || null
          },
        }),
        applyExcludeIds: restorable,
        ...(deps.auditOpts || {}),
      })
      out.accounts++
      if (obliged.has(String(id))) reachedObliged++
      out.naked += prot.naked.length
      out.targetless += prot.targetless.length
      out.phantom += prot.phantom.length
      out.tpDrift += (prot.tpDrift || []).length
      // Distinct from `targetsRestored`: that is the book's own recorded target
      // put back, this is a fresh structural target on a position that never
      // had one. Counting them together would hide which repair is running.
      out.targetsSet += prot.targetsApplied || 0

      // MAKE THE BOOK STOP LYING. A phantom is our record disagreeing with the
      // broker's, and this module already calls that the more dangerous state
      // — while doing nothing about it. Local write only; nothing is sent to
      // the broker. One-directional on purpose: see services/stop-adopt.js for
      // why adopting a WIDER broker stop would cure the guard by deleting it.
      try {
        const { adoptBrokerStops } = deps.stopAdopt ?? await import('./stop-adopt.js')
        const rowsForStops = new Map(openRows.map(r => [String(r.ctrader_position_id), r]))
        const ad = adoptBrokerStops(db, prot.phantom, rowsForStops)
        out.stopsAdopted += ad.adopted
        if (ad.adopted) console.log(`[protection] ${id}: book corrected to broker truth on ${ad.adopted} stop(s)`)
        for (const sk of ad.skipped) console.log(`[protection] ${id}: stop NOT adopted — ${sk}`)
      } catch (err) {
        out.errors.push(`${id}: stop adopt failed — ${err?.message || err}`)
      }

      // PUT BACK WHAT WAS LOST. #748 stopped targets being deleted; positions
      // stripped before it deployed stay stripped until something acts. The
      // audit is where the fact is already known, so it is where the repair
      // belongs — reporting it forever while holding the position id, the
      // broker's stop and the recorded target would be the shape this repo
      // keeps paying for.
      try {
        const rowsById = new Map(openRows.map(r => [String(r.ctrader_position_id), r]))
        const fix = await restoreMod.restoreMissingTargets(db, creds, prot.targetless, rowsById, {
          ...(deps.restoreOpts || {}),
          notify: sendMessage ? (m) => sendMessage(m).catch(() => {}) : undefined,
        })
        out.targetsRestored += fix.restored
        for (const e of fix.errors) out.errors.push(`${id}: target restore — ${e}`)
        if (fix.restored) console.log(`[protection] ${id}: restored ${fix.restored} take profit(s) from the book`)
        for (const sk of fix.skipped) console.log(`[protection] ${id}: target NOT restored — ${sk}`)
        // CLOSE THE LOOP THE BREAKDOWN OPENED (16-09-2026, review). The audit's
        // stdout line reports N positions "deferred to target-restore" — the
        // routing, which it can know. What it cannot know is the OUTCOME, and
        // the first draft asserted one. This is the other half: how many of
        // the deferred set restore actually repaired, printed after it ran, so
        // the pair of lines is complete and neither one over-claims.
        if (restorable.size) {
          const stillOpen = restorable.size - fix.restored
          console.log(`[protection] ${id}: ${restorable.size} deferred to target-restore — ${fix.restored} restored, ${Math.max(0, stillOpen)} still without a target`)
        }
      } catch (err) {
        // A failed repair must never take down the audit that found the fault.
        out.errors.push(`${id}: target restore failed — ${err?.message || err}`)
      }
    } catch (err) {
      const msg = String(err?.message || err)
      // UNAUDITABLE IS NOT UNPROTECTED, and the difference decides whether
      // this controller is worth reading.
      //
      // Demo LOGIN-4's token does not cover it, so every pass returned
      // CH_ACCESS_TOKEN_INVALID and the first deploy of this path parked
      // protection_audit permanently in `error` — a controller that is always
      // red is a controller nobody reads, which is the same defect fixed in
      // the health panel hours earlier and reintroduced here by me.
      //
      // An account the broker refuses to authorise cannot be audited; that is
      // a fact about ACCESS, not about whether anything is exposed. It is
      // reported by name and separately, and does not on its own mark the
      // sweep failed. A genuine audit failure on a REACHABLE account still
      // does — because there, "we could not check" really does mean positions
      // may be sitting unprotected.
      if (UNAUDITABLE_RE.test(msg)) {
        out.unauditable.push(`${id}: ${msg}`)
        // MAKE THE GAP SURVIVE THE RECLASSIFICATION (review, 08-08). Before
        // this PR a CANT_ROUTE_REQUEST landed in `errors`, so the operator saw
        // amber with the account named. Reclassifying it as an access fact
        // stops it holding the controller red — correctly — but `unauditable`
        // reached only a console.warn, so the PARTIAL case (some accounts
        // reached, one refused) would render as a plain green with the gap
        // named nowhere. `blind` cannot catch that; it only fires when EVERY
        // account is refused.
        //
        // "We could not check this account" is exactly what this per-account
        // record was built to carry (see ¶D·2 above), and it preserves the last
        // successful reading rather than overwriting it. So the beat stays green
        // and the panel still says which account went unverified.
        recordAuditUnavailable(db, msg, { accountId: id, ...(deps.auditOpts?.nowMs ? { nowMs: deps.auditOpts.nowMs } : {}) })
      } else {
        out.errors.push(`${id}: ${msg}`)
        // THE GENUINE FAILURE MUST STAMP THE RECORD TOO (2026-08-22). This
        // branch — the WORSE failure, "a reachable account we could not
        // check" — was the only outcome that never wrote the per-account
        // record. Measured 2026-08-16: the sweep failed on a 502 every ~50s,
        // 20,492 runs, while /state/protection-audit presented a lastAttemptAt
        // six days old as the current state — the panel said the controller
        // had stopped when in fact only its RECORD had. The heartbeat and the
        // record disagreed, and the one that updates every pass is the one to
        // believe; this makes the record that one. Last success is preserved
        // (recordAuditUnavailable never overwrites `at`/`ok`), so this only
        // moves lastAttemptAt/lastAttemptError — which is the truth.
        recordAuditUnavailable(db, msg, { accountId: id, ...(deps.auditOpts?.nowMs ? { nowMs: deps.auditOpts.nowMs } : {}) })
      }
    }
  }
  // AN AUDIT THAT REACHED NOTHING IS NOT A CLEAN AUDIT, and this is the price
  // of every widening of UNAUTHORISED_CODES above. `CANT_ROUTE_REQUEST` is an
  // access fact per account — but if the whole sidecar session goes down, EVERY
  // account returns it, every one lands in `unauditable`, and the controller
  // would read `ok` while not a single position was checked. That is a worse
  // lie than the amber it replaces: green means "your positions are protected".
  //
  // So the honest rule is per-sweep, not per-account: reaching some accounts
  // and being refused by others is a real audit with a named gap; reaching NONE
  // of them means the sweep verified nothing and must say so.
  //
  // MEASURED AGAINST `roster`, NOT AGAINST `ids` (review, 08-08). `ids` prepends
  // `primary` unconditionally — no enabled test, no side test — so with the
  // global flag on `live` and a DISABLED live account selected, `ids` is that
  // one account, its reconcile throws CANT_ROUTE_REQUEST, and `accounts === 0`.
  // Against an implicit `ids` denominator that reads as blind, and the fast
  // monitor would beat failed every 60s for ever: the amber this change removes,
  // returned as permanent red, on the very same account and error. The
  // classification fix above would have been undone by its own counterweight.
  //
  // `roster` is the set we were actually obliged to reach — enabled, same side.
  // Empty roster plus an unreachable selected account is not a blind sweep;
  // there was nothing we were required to audit. The staleness of the work
  // product (checkProtectionFreshness) is what catches a sweep that stops
  // producing readings, and that is the right instrument for it.
  out.blind = reachedObliged === 0 && roster.length > 0 &&
    (out.unauditable.length > 0 || out.errors.length > 0)
  return out
}
