// Suggest a take-profit for a position that has none — the follow-through on
// the targetless alert (owner 01-08: "build the HVN suggestion button").
//
// The suggester proposes a concrete price — HVN volume-structure candidate
// when the profile supports one, otherwise the strategy R:R floor price — and
// the alert carries it with a one-tap Telegram button.
//
// THE HEADER USED TO SAY "the system never ATTACHES a target on its own". That
// stopped being true on 04-08-2026 when makeTargetApplier below shipped, and
// the sentence sat here as a false reassurance about the one file that does
// the attaching. The owner's own policy has required a TP at order time since
// #23; an adopted position is the same position arriving by a different door.
// The owner can still tap, and the button is still offered where nothing was
// applied — but the tap is no longer the only path.
import { hvnTargetPrice } from '../lib/bracket-advice.js'
import { minRrFor } from './strategies.js'
import { normPosId } from '../lib/pos-id.js'
import { protectionFailure } from './protection-repair-state.js'
import { measureAmend } from './protection-latency.js'

const HVN_TIMEFRAME = '15m' // same profile the manual-order advice uses
const HVN_BAR_COUNT = 240   // ~2.5 days of 15m structure
/** Pre-amend read timeout. See the call site for why the 25s default is wrong here. */
const READ_TIMEOUT_MS = Math.max(2_000, Number(process.env.TARGET_APPLY_READ_TIMEOUT_MS) || 10_000)

// ─────────────────────────────────────────────────────────────────────────────
// DIRECTION IS READ, NOT INFERRED (17-09-2026, third review).
//
// Both halves of this module used to derive the trade's direction from the
// geometry — the suggester from `sl < entry`, the applier from `tp > sl`. That
// holds at ORDER time, where the stop is always on the risk side of entry. It
// INVERTS the moment a stop is ratcheted past entry: break-even lock, the
// profit keeper's chandelier, the loss guardian, MOVE_SL.
//
// And that is not an edge case here. It is the normal state of a managed
// winner — and a winner that lost its target to a stop-only amend is precisely
// what the `targetless` population is MADE of. Measured end to end: a long,
// entry 100, market 112, broker stop 110, no target produced
//
//   target SET on XAUUSD (position 700) — TP 85 (1.5R floor from entry)
//   amends: [{"positionId":"700","stopLoss":110,"takeProfit":85}]
//
// a take profit 27 points BELOW the market on a long: either the broker
// refuses it forever or it fills instantly and flattens the position. The same
// inversion turned the never-widen backstop inside out, so on exactly the
// positions this path targets it permitted widening and refused tightening.
//
// Before this change, no production caller wired an applier into the fast
// sweep at all — one `target SET` in 4.5 days. Wiring it puts this in reach
// twelve times a minute, so the guess had to go, not be improved.
//
// The broker's own `tradeData.tradeSide` is the answer, and UNKNOWN IS A
// REFUSAL. The other decoders in this repo (`weekend-bank.js`,
// `manual-position-guards.js`) collapse anything unrecognised to BUY, which is
// fine where the answer only picks a quote side — it is not fine where being
// wrong writes a target on the wrong side of the market.
// ─────────────────────────────────────────────────────────────────────────────

/** true = long, false = short, null = the broker did not say. Never a default. */
export function sideIsLong(tradeData) {
  const v = tradeData?.tradeSide
  if (v === 1 || v === '1' || v === 'BUY' || v === 'buy') return true
  if (v === 2 || v === '2' || v === 'SELL' || v === 'sell') return false
  return null
}

/**
 * Build a suggester bound to one reconcile pass's broker snapshot. Called by
 * runProtectionAudit only for findings whose alert is actually due (≤ once
 * per position per mute window), so the bar fetch is rare, not per-loop.
 *
 * @param {object} db
 * @param {object} creds        getCtraderCreds(db) result
 * @param {Array}  positions    the pass's raw broker positions (tradeData intact)
 * @param {{fetchBars?: Function, symbolMap?: object, rrFloor?: number}} deps
 * @returns {(finding: {positionId, symbol, brokerSl}) => Promise<{tp:number, basis:string}|null>}
 */
export function makeTargetSuggester(db, creds, positions, deps = {}) {
  const byId = new Map()
  for (const p of positions || []) {
    if (p?.positionId != null) byId.set(String(p.positionId), p)
  }
  return async function suggestTarget(finding) {
    try {
      const bp = byId.get(String(finding.positionId))
      if (!bp) return null
      const entry = Number(bp.tradeData?.openPrice ?? bp.price)
      const sl = Number(finding.brokerSl)
      if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry === sl) return null
      // READ, NOT INFERRED — see the header. No side from the broker, no
      // suggestion: a guessed direction here picks the wrong side of the market.
      const long = sideIsLong(bp.tradeData)
      if (long == null) return null

      // Adopted/external positions carry no strategy, so the floor is the
      // default the risk gate would apply to an unlabelled trade.
      const rrFloor = deps.rrFloor ?? minRrFor(null, 1.5)

      // IS THE ORIGINAL RISK STILL MEASURABLE? `|entry - sl|` is one R only
      // while the stop sits on the RISK side of entry. Once it has been
      // ratcheted past entry the position's original risk is gone from the
      // data, and `entry ± 1.5R` computed from the remaining gap lands just
      // past entry — far BEHIND a market that has since run. So on a locked
      // position there is no floor price to offer, and volume structure is the
      // only basis left. No basis, no target: the honest answer, and the one
      // this module has given since it refused to invent a level.
      const stopLocked = long ? sl >= entry : sl <= entry
      const slDistance = Math.abs(entry - sl)
      const floorTp = stopLocked
        ? null
        : (long ? entry + rrFloor * slDistance : entry - rrFloor * slDistance)

      // EVERY CANDIDATE MUST BE BEYOND BOTH ENTRY AND THE CURRENT STOP, in the
      // trade direction. Beyond entry makes it a profit; beyond the stop makes
      // it an exit the stop would not have taken first. A target between them
      // is a target the position has already passed.
      //
      // THE "BEYOND THE STOP" HALF IS AN EQUIVALENT MUTANT TODAY, and is stated
      // as one rather than defended as a pinned guard (deleting it leaves every
      // test green, and that is not an oversight — no input can reach it):
      //   · unlocked, the stop is on the risk side of entry, so beyond-entry
      //     already implies beyond-stop;
      //   · locked, `floorTp` is null, and `hvnTakeProfit` suppresses any
      //     candidate under `rrFloor` — at 1.5R against |entry - sl| that is
      //     always further from entry than the stop is.
      // It is kept because both premises are someone else's code (the rrFloor
      // default, the suppression rule) and this is the last check before a
      // price becomes a broker order. Nothing here claims a test proves it.
      const beyond = (v) => Number.isFinite(v) && (long ? (v > entry && v > sl) : (v < entry && v < sl))

      let bars = []
      try {
        const symbolMap = deps.symbolMap
          ?? (await import('../lib/ctrader-creds.js')).getSymbolMap(db)
        const symbolId = symbolMap?.[finding.symbol]
        if (symbolId) {
          const fetchBars = deps.fetchBars
            ?? (await import('../lib/ctrader-ws.js')).wsGetTrendbarsBatch
          const byTf = await fetchBars(
            creds.host, creds.clientId, creds.clientSecret, creds.accessToken,
            creds.accountId, symbolId, [HVN_TIMEFRAME], HVN_BAR_COUNT,
          )
          bars = byTf?.[HVN_TIMEFRAME] || []
        }
      } catch { bars = [] } // structure unavailable → floor suggestion still stands

      // `long` passed EXPLICITLY: hvnTargetPrice's own default infers it from
      // `sl < entry`, which is the inversion this whole section exists to stop.
      const hvn = hvnTargetPrice({ entry, sl, bars, rrFloor, long })
      if (hvn != null && beyond(hvn)) {
        const rr = slDistance > 0 ? (Math.abs(hvn - entry) / slDistance).toFixed(1) : null
        return { tp: hvn, basis: rr ? `HVN volume node, ${rr}R` : 'HVN volume node' }
      }
      if (floorTp == null || !beyond(floorTp)) return null
      // Round the floor price the way the HVN path would have: to the wider
      // of the entry/stop precisions, so the button never carries float noise.
      const dec = (n) => { const s = String(n), i = s.indexOf('.'); return i === -1 ? 0 : Math.min(s.length - i - 1, 8) }
      const tp = Number(floorTp.toFixed(Math.max(dec(entry), dec(sl))))
      return beyond(tp) ? { tp, basis: `${rrFloor}R floor from entry` } : null
    } catch {
      return null // a failed suggestion must never block the alert itself
    }
  }
}

/**
 * Apply a suggested target at the broker.
 *
 * Owner, 04-08-2026: "SO MANY POSITIONS WITH NO TARGET SET". The suggestion
 * has been computed and printed for days while nothing acted on it; this is the
 * hand that puts it on the position.
 *
 * SAFE BY CONSTRUCTION:
 *  · a take profit can only ever close in profit, so the downside is an early
 *    exit, never a loss the position would not otherwise have taken;
 *  · every application is journalled as a position event, so a target that
 *    appears on a position is always attributable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STOP CLAIM USED TO BE STRONGER THAN THE CODE (16-09-2026, review).
 *
 * This header said "a bug here can widen nothing and cannot move a stop". Under
 * concurrency that was false, and the falseness is the dangerous kind — a
 * comment that stops the next reader looking.
 *
 * `finding.brokerSl` is captured by `reconcile()` at the TOP of the sweep. By
 * the time the amend goes out, the pass has walked the per-account loop and up
 * to N sequential `wsGetTrendbarsBatch` calls at a 15-second timeout each. The
 * profit keeper and the `MOVE_SL` ratchet run on their own band, deliberately
 * independent of this one (fast-monitor.js). If either tightens the stop in
 * that window, and amend REPLACES protection, this writes the stale, WIDER stop
 * back over the tighter one — widening risk on a live position.
 *
 * So the stop is RE-READ immediately before the amend, and:
 *  · a read that fails, cannot find the position, or comes back describing a
 *    DIFFERENT position, REFUSES. A repair that is not certain of the stop does
 *    not go out; skipping only delays a target.
 *  · a stop that has MOVED is carried at its FRESH value, never the snapshot's.
 *  · a fresh value WIDER than the snapshot REFUSES rather than being written,
 *    with "wider" decided by the broker's OWN trade side — never by the
 *    geometry, which inverts on a break-even-locked winner. A read carrying no
 *    side REFUSES. See the direction note at the top of this file.
 *  · a target on the wrong side of the live stop REFUSES.
 *  · a position that already holds a take profit REFUSES — a target is there
 *    and overwriting another controller's is not this module's job.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE READ MUST BE LIVE, AND THE FIRST VERSION OF IT WAS NOT (17-09-2026,
 * second review). This is the same lesson `lib/fill-anchor.test.js` already
 * pins: "LIVE broker read (wsReconcile), never the sidecar's cached snapshot."
 *
 * The first fix injected `exec.reconcile(creds)` as the re-read — the SAME
 * function that produced the snapshot being checked. Under `EXEC_ENGINE=cpp`
 * (what production runs) `reconcile` POSTs `/positions` to the sidecar, which
 * returns `lastReconcileJson` — a CACHED string written only by the sidecar's
 * own 30-second reconcile loop. An amend does not refresh it. So:
 *
 *   T+0s  the profit keeper ratchets the stop 1.05 -> 1.09
 *   T+2s  the audit's reconcile reads the T-25s cache: 1.05, no target
 *   T+5s  the "fresh re-read" reads THE SAME CACHE: 1.05
 *         -> freshSl === sl, the "it moved" branch never fires
 *   T+5s  amend {stopLoss: 1.05, ...}. Amend replaces. 1.09 -> 1.05.
 *
 * The identity write of a cache is not the identity write of the broker. The
 * default read is now `wsReconcile` — the live WS query — on BOTH engines, and
 * `readPosition` is injectable ONLY so tests and the sweep can supply a live
 * reader, never so a caller can hand back the cache it already has.
 *
 * AND A BACKSTOP UNDER IT, because "the read is live" is a property of a
 * caller's injection and this seam is exported. A stop is never widened by this
 * path under any circumstances — not by a stale read, not by a wrong one, not
 * by a broker that answers oddly. A fresh value further from the entry than the
 * snapshot's is refused outright. Direction is taken from the target: a
 * suggestion always sits on the profit side, so `tp > sl` is a long.
 *
 * NOTE WHAT THE BACKSTOP DOES NOT DO. It compares the read against the
 * SNAPSHOT, so when both come from the same stale cache they agree and it
 * passes. It cannot close the cpp case; only the live read does. It closes the
 * case where the snapshot is the fresher of the two.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * @returns {(finding, suggestion) => Promise<{ok:boolean, error?:string}>}
 */
export function makeTargetApplier(db, creds, {
  amendPosition = null, recordEvent = null, readPosition = null,
} = {}) {
  return async function applyTarget(finding, suggestion) {
    const tp = Number(suggestion?.tp)
    let sl = Number(finding?.brokerSl)
    if (!Number.isFinite(tp) || tp <= 0) return { ok: false, error: 'no usable target' }
    // THE STOP MUST SURVIVE THE AMEND, SO IT HAS TO BE KNOWN (16-09-2026).
    // cTrader's amend REPLACES protection. This used to send
    // `stopLoss: undefined` when the finding carried no usable stop, which
    // wsAmendPosition reads as absent — a take-profit amend that would have
    // CLEARED the stop and turned a targetless position into a naked one: this
    // module's own defect, inverted. `targetless` findings are only ever raised
    // on positions that HAVE a broker stop (auditProtection checks the stop
    // first), so this has never fired in production — which is exactly why it
    // must be a refusal and not an assumption. Same rule, same wording, as
    // target-restore.js's planTargetRestore.
    if (!Number.isFinite(sl) || sl <= 0) {
      return { ok: false, error: 'no stop known at the broker — a TP-only amend here would risk the stop' }
    }
    try {
      // ── RE-READ THE STOP LIVE, AS LATE AS POSSIBLE ──
      // `wsReconcile`, NOT `exec.reconcile`: in cpp mode the latter serves the
      // sidecar's 30-second cache, which an amend never refreshes, so it would
      // hand back the very snapshot this check exists to doubt.
      const read = readPosition ?? (async () => {
        const { wsReconcile } = await import('../lib/ctrader-ws.js')
        // AN EXPLICIT, SHORT TIMEOUT. The default is 25s and `wsReconcile`
        // wraps itself in `withRetry(..., 2)` with 2s/4s backoff — 81s worst
        // case for ONE read, on a 60-second band. This runs serially per
        // position, so the default is what turned a hung broker into a parked
        // band. 10s x 3 attempts + 6s backoff is 36s, inside the budget.
        const rec = await wsReconcile(
          creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
          READ_TIMEOUT_MS)
        return (rec?.position || [])
          .find(p => normPosId(p?.positionId) === normPosId(finding.positionId)) || null
      })
      let live
      try { live = await read(finding) } catch (e) {
        // `retryable`: this says nothing about the position, only that the
        // broker could not be reached. The caller shortens its window rather
        // than muting the position for the full six hours.
        return { ok: false, retryable: true, error: `could not re-read the position before amending — ${e?.message || e}` }
      }
      if (!live) {
        return { ok: false, retryable: true, error: 'position not in the fresh broker read — closed or unreachable; refusing to amend' }
      }
      // IS THIS THE POSITION WE ASKED ABOUT? The two production injections both
      // filter by id, so this is latent — but `makeTargetApplier` is an exported
      // seam whose contract is "the stop the broker holds RIGHT NOW for THIS
      // position", and it verified every property of that value except which
      // position it belonged to. Verified before the fix: a reader returning a
      // neighbour's row had that neighbour's stop written onto this position.
      if (live.positionId != null &&
          normPosId(live.positionId) !== normPosId(finding.positionId)) {
        return { ok: false, error: `the fresh read returned position ${live.positionId}, not ${finding.positionId} — refusing to amend` }
      }
      // STRICTLY A NUMBER. `Number(true)` is 1 and `Number([1750])` is 1750;
      // "refuses on any uncertainty" has to be literal on a value that becomes
      // a stop loss at a broker.
      const freshSl = live.stopLoss
      if (typeof freshSl !== 'number' || !Number.isFinite(freshSl) || freshSl <= 0) {
        return { ok: false, error: 'the broker now holds no usable stop on this position — refusing a TP amend that would leave it naked' }
      }
      // ANY existing target refuses, including a corrupt one. A negative or NaN
      // take profit used to read as "no take profit" and get silently
      // overwritten; a value nobody can explain is a reason to stop, not to
      // write over it.
      if (live.takeProfit != null && Number(live.takeProfit) !== 0) {
        return { ok: false, error: `the position already holds a take profit at ${live.takeProfit} — not overwriting it` }
      }
      // DIRECTION FROM THE BROKER, NOT FROM THE GEOMETRY (17-09-2026, third
      // review). This read `const long = tp > sl`, which inverts on exactly the
      // population this path serves — a managed winner whose stop has been
      // ratcheted past entry. With the inverted direction the backstop below
      // refused TIGHTENING and permitted WIDENING: measured, snapshot 110,
      // live read 101, `ok: true`, `stopLoss: 101` written. The one line added
      // to make "this path never widens a stop" true was the line that
      // inverted it. The same live read that gives the stop gives the side.
      const long = sideIsLong(live.tradeData)
      if (long == null) {
        return { ok: false, error: 'the broker read carries no trade side — refusing rather than inferring direction from geometry' }
      }
      // THE TARGET MUST BE AN EXIT IN PROFIT, PAST THE STOP. A long's target
      // below its stop is an order to close at a loss the stop would have taken
      // first — or, below the market, an instant flatten. The suggester already
      // refuses to produce one; this is the independent second opinion, because
      // `suggestion` is an argument and this function is an exported seam.
      if (long ? !(tp > freshSl) : !(tp < freshSl)) {
        return { ok: false, error: `target ${tp} is on the wrong side of the stop ${freshSl} for a ${long ? 'long' : 'short'} — refusing` }
      }
      // THE BACKSTOP: NEVER WIDEN.
      if (long ? freshSl < sl : freshSl > sl) {
        return { ok: false, error: `the fresh read (${freshSl}) is WIDER than the snapshot (${sl}) on a ${long ? 'long' : 'short'} — refusing; this path never widens a stop` }
      }
      // THE FRESH READ WINS. The snapshot value is only ever the older of the
      // two, so preferring it is how a ratcheted stop gets widened back.
      const snapshotSl = sl
      if (freshSl !== sl) sl = freshSl

      const amend = amendPosition
        ?? (await import('../lib/exec-engine.js')).amendPosition
      // V3 M5: timed on the way through; the payload is untouched.
      const res = await measureAmend({ path: 'tp_suggest', source: 'naked_position_guard', accountId: finding.accountId ?? creds?.accountId, positionId: finding.positionId }, () => amend(creds, {
        positionId: finding.positionId,
        // The stop the broker is holding RIGHT NOW, re-sent unchanged. Amend
        // replaces, so this leg is what keeps the stop alive, not decoration.
        stopLoss: sl,
        takeProfit: tp,
      }))
      // A FAILURE THAT CARRIES NO `error` KEY IS STILL A FAILURE (review).
      // `wsAmendPosition` returns `{alreadyClosed, reason, rawError}` for
      // POSITION_NOT_FOUND — no `error` field at all — so testing `res.error`
      // alone reported ok:true, printed `target SET`, and journalled a
      // `tp_moved` event against a CLOSED position. The old test for this used
      // `{error: 'POSITION_NOT_FOUND'}`, a shape the real amend never returns,
      // so it was green for the wrong reason.
      if (!res) return { ok: false, retryable: true, error: 'amend returned nothing' }
      if (res.error) return protectionFailure(res, { retryableUnknown: false })
      if (res.alreadyClosed) {
        return { ok: false, error: `position closed before the amend reached the broker — ${res.reason || res.rawError || 'alreadyClosed'}` }
      }
      if (res.rawError) return protectionFailure(res.rawError, { retryableUnknown: false })
      try {
        const rec = recordEvent
          ?? (await import('./position-events.js')).recordPositionEvent
        rec(db, {
          positionId: finding.positionId,
          accountId: finding.accountId ?? null,
          symbol: finding.symbol,
          // `tp_moved` is the existing vocabulary — a new kind for this would
          // fragment the timeline the P10 journal exists to make readable.
          // from_value null says it had none, which is the whole story.
          kind: 'tp_moved',
          source: 'naked_position_guard',
          fromValue: null,
          toValue: tp,
          reason: 'adopted_no_target',
          detail: `adopted position had no take profit; set to ${tp} (${suggestion.basis}); stop re-sent at ${sl}`,
        })
        // JOURNAL THE STOP THIS AMEND WROTE (17-09-2026, second review). The
        // amend carries BOTH legs — it has to, because amend replaces — so this
        // path writes a stop on every application and journalled none of them.
        // A stop that moved because of this module was unattributable from the
        // timeline, which is the exact gap `tp_moved` was added to close for
        // the other leg. Recorded only when the value actually changed: an
        // identity re-send is not a move and would bury the timeline.
        if (sl !== snapshotSl) {
          rec(db, {
            positionId: finding.positionId,
            accountId: finding.accountId ?? null,
            symbol: finding.symbol,
            kind: 'sl_moved',
            source: 'naked_position_guard',
            fromValue: snapshotSl,
            toValue: sl,
            reason: 'stop_resent_with_target',
            detail: `the snapshot held ${snapshotSl}; the live read held ${sl}, which is what was re-sent alongside the target`,
          })
        }
      } catch { /* the journal must never undo the amend */ }
      return { ok: true }
    } catch (e) {
      return protectionFailure(e)
    }
  }
}
