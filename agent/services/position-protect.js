// Set/replace the broker-native SL and/or TP on ONE open position — the one
// piece of logic behind both POST /actions/position-protect and the Telegram
// "Set TP" inline button (owner 01-08: the targetless alert should carry a
// one-tap fix, not just instructions to go run a curl).
//
// Extracted from routes/actions.js verbatim so the two entry points cannot
// drift: same amend call, same book update, same position_events trail.
import { recordPositionEvent } from './position-events.js'
import { normPosId } from '../lib/pos-id.js'
import { protectionPositionId } from './protection-account.js'

/** Pre-amend read timeout. See readLiveProtection for why the 25s default is wrong here. */
const PROTECT_READ_TIMEOUT_MS = Math.max(2_000, Number(process.env.PROTECT_READ_TIMEOUT_MS) || 8_000)

// ─────────────────────────────────────────────────────────────────────────────
// BOTH LEGS, ALWAYS — AND THIS FUNCTION SENT ONE (17-09-2026, second review).
//
// cTrader's amend REPLACES protection: the position ends up with exactly what
// the payload carries. This built `{positionId, takeProfit}` from a `tp`-only
// request and sent it. Verified: `BUTTON AMEND ARGS: {"positionId":700,
// "takeProfit":1950}`. The targetless alert's one-tap "Set TP" button routes
// here, and that alert's whole premise is that these positions DO have a stop —
// so one tap on a button offered because the position was protected would have
// taken it NAKED. The defect the applier was fixed for, live on the sibling
// door, in the more dangerous direction: a lost target is upside forgone, a
// lost stop is unbounded downside.
//
// The mirror case was already broken, silently: an `sl`-only request built
// `{positionId, stopLoss}`, which `assertAmendIntent` has thrown on since the
// 22-08 audit. Tests never saw it because they inject `deps.amend` and bypass
// exec-engine entirely.
//
// So the missing leg is fetched from the broker and carried. LIVE, via
// `wsReconcile` — not `exec.reconcile`, which in cpp mode serves the sidecar's
// 30-second cache and would hand back a stop that may already have moved. Same
// rule as `tp-suggest.js`'s re-read and `lib/fill-anchor.test.js`'s fill
// confirmation.
//
// A read that fails REFUSES rather than guessing. The local book has
// `current_sl`, and using it would be the tempting shortcut — but our record is
// what this module exists to correct against broker truth, and writing a
// believed stop that the broker never held is how a phantom becomes real.
// ─────────────────────────────────────────────────────────────────────────────

/** The broker's current protection on one position, live. Null if not found. */
async function readLiveProtection(creds, positionId, deps) {
  const read = deps.readPosition ?? (async () => {
    const { wsReconcile } = await import('../lib/ctrader-ws.js')
    // A SHORT TIMEOUT, BECAUSE THIS SITS IN A REQUEST HANDLER (17-09-2026,
    // third review). Both callers — the HTTP route and the Telegram callback —
    // now wait on this read where they used to return immediately, and
    // `wsReconcile`'s 25s default inside `withRetry(..., 2)` is 81s worst case.
    // 8s x 3 attempts + 6s backoff is 30s: still slow, but a bounded slow, and
    // the alternative is the amend clearing a leg. The refusal is what protects
    // the position; the timeout is what keeps the refusal from being a hang.
    const rec = await wsReconcile(
      creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
      PROTECT_READ_TIMEOUT_MS)
    return (rec?.position || [])
      .find(p => normPosId(p?.positionId) === normPosId(positionId)) || null
  })
  return read(positionId)
}

/**
 * @param {object} db     better-sqlite3 handle
 * @param {object} creds  getCtraderCreds(db) result (caller checks .ready)
 * @param {{positionId: string|number, sl?: number, tp?: number, source?: string}} args
 * @param {{amend?: Function, readPosition?: Function}} deps  injectable for tests
 * @returns {{ok: true, positionId, sl: number|null, tp: number|null}}
 * @throws on broker refusal — callers translate to their own surface
 */
export async function protectPosition(db, creds, { positionId, sl, tp, source = 'manual' }, deps = {}) {
  positionId = protectionPositionId(positionId)
  const accountId = String(creds?.accountId ?? '').trim()
  if (!accountId || accountId === 'all' || accountId === '_all') throw new Error('one accountId is required for protection')
  const amend = deps.amend ?? (await import('../lib/exec-engine.js')).amendPosition
  const args = { positionId: parseInt(positionId) }
  // What the CALLER asked for, kept apart from what gets carried through, so
  // the journal can tell a decision from a re-send.
  const requestedSl = Number(sl) > 0
  const requestedTp = Number(tp) > 0
  if (requestedSl) args.stopLoss = Number(sl)
  if (requestedTp) args.takeProfit = Number(tp)
  if (args.stopLoss == null && args.takeProfit == null) {
    throw new Error('sl or tp (absolute price) is required')
  }

  // CARRY THE LEG THE CALLER DID NOT SET. See the header above.
  if (args.stopLoss == null || args.takeProfit == null) {
    let live
    try { live = await readLiveProtection(creds, positionId, deps) } catch (e) {
      throw new Error(`could not read the position's current protection before amending (amend REPLACES both legs) — ${e?.message || e}`)
    }
    if (!live) {
      throw new Error(`position ${positionId} is not in a live broker read — refusing to amend, because amend REPLACES both legs`)
    }
    if (normPosId(live.positionId) !== positionId) throw new Error('protection read position identity mismatch')
    if (args.stopLoss == null) {
      const keep = live.stopLoss
      if (typeof keep === 'number' && Number.isFinite(keep) && keep > 0) args.stopLoss = keep
      // The broker really holds none: say so out loud rather than by omission.
      else args.clearStopLoss = true
    }
    if (args.takeProfit == null) {
      const keep = live.takeProfit
      if (typeof keep === 'number' && Number.isFinite(keep) && keep > 0) args.takeProfit = keep
      else args.clearTakeProfit = true
    }
  }
  const sent = await amend(creds, args)
  if (sent?.error || sent?.rawError || sent?.alreadyClosed || sent?.ok === false) {
    throw new Error(`protection amendment not accepted: ${sent.error || sent.rawError || 'position unavailable'}`)
  }
  // Re-read local attribution AFTER the broker await. A reconcile can close,
  // replace or duplicate a row while the request is in flight. Never rewrite
  // another account or pick one of several active lifecycle claims.
  const ledger = db.transaction(() => {
    const candidates = db.prepare(
      `SELECT mp.id, mp.trade_id, mp.account_id, mp.symbol, mp.current_sl, mp.current_tp
         FROM monitored_positions mp JOIN trades t ON t.id = mp.trade_id
        WHERE t.ctrader_position_id = ? AND t.account_id = ? AND t.status = 'open' AND mp.status = 'active'
        LIMIT 2`
    ).all(positionId, accountId)
    if (candidates.length !== 1 || String(candidates[0].account_id ?? '') !== accountId) {
      return { ledgerUpdated: false, ledgerReason: candidates.length > 1 ? 'ambiguous active lifecycle' : 'no matching account-owned active lifecycle' }
    }
    const before = candidates[0]
    db.prepare(
      "UPDATE monitored_positions SET current_sl = COALESCE(?, current_sl), current_tp = COALESCE(?, current_tp) WHERE id = ? AND account_id = ? AND status = 'active'"
    ).run(args.stopLoss ?? null, args.takeProfit ?? null, before.id, accountId)
    // A LEG THE CALLER DID NOT ASK FOR IS NOT A MOVE. It is carried through so
    // the amend does not delete it, and journalling every re-send as `sl_moved`
    // would bury the timeline the journal exists to make readable — so a carried
    // leg is recorded only when it actually differs from the book's record, which
    // is a correction worth having.
    const slIsNews = requestedSl || (before && Number(before.current_sl) !== args.stopLoss)
    const tpIsNews = requestedTp || (before && Number(before.current_tp) !== args.takeProfit)
    if (before && args.stopLoss != null && slIsNews) {
      recordPositionEvent(db, {
        accountId: before.account_id, positionId, tradeId: before.trade_id, symbol: before.symbol,
        kind: 'sl_moved', fromValue: before.current_sl, toValue: args.stopLoss, source,
      })
    }
    if (before && args.takeProfit != null && tpIsNews) {
      recordPositionEvent(db, {
        accountId: before.account_id, positionId, tradeId: before.trade_id, symbol: before.symbol,
        kind: 'tp_moved', fromValue: before.current_tp, toValue: args.takeProfit, source,
      })
    }
    return { ledgerUpdated: true, ledgerReason: null }
  })()
  return { ok: true, positionId, sl: args.stopLoss ?? null, tp: args.takeProfit ?? null, ...ledger }
}
