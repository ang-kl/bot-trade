// Suggest a take-profit for a position that has none — the follow-through on
// the targetless alert (owner 01-08: "build the HVN suggestion button").
//
// D4's design call stands: the system never ATTACHES a target on its own.
// What changes is the alert's usefulness — instead of only naming the gap, it
// now proposes a concrete price (HVN volume-structure candidate when the
// profile supports one, otherwise the strategy R:R floor price) and carries a
// one-tap Telegram button. The OWNER still makes the decision; the tap is the
// decision.
import { hvnTargetPrice } from '../lib/bracket-advice.js'
import { minRrFor } from './strategies.js'

const HVN_TIMEFRAME = '15m' // same profile the manual-order advice uses
const HVN_BAR_COUNT = 240   // ~2.5 days of 15m structure

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
      const long = sl < entry

      // Adopted/external positions carry no strategy, so the floor is the
      // default the risk gate would apply to an unlabelled trade.
      const rrFloor = deps.rrFloor ?? minRrFor(null, 1.5)
      const slDistance = Math.abs(entry - sl)
      const floorTp = long ? entry + rrFloor * slDistance : entry - rrFloor * slDistance

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

      const hvn = hvnTargetPrice({ entry, sl, bars, rrFloor })
      if (hvn != null) {
        const rr = (Math.abs(hvn - entry) / slDistance).toFixed(1)
        return { tp: hvn, basis: `HVN volume node, ${rr}R` }
      }
      // Round the floor price the way the HVN path would have: to the wider
      // of the entry/stop precisions, so the button never carries float noise.
      const dec = (n) => { const s = String(n), i = s.indexOf('.'); return i === -1 ? 0 : Math.min(s.length - i - 1, 8) }
      const tp = Number(floorTp.toFixed(Math.max(dec(entry), dec(sl))))
      return { tp, basis: `${rrFloor}R floor from entry` }
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
 * SAFE BY CONSTRUCTION IN THREE WAYS:
 *  · it amends the TAKE PROFIT only and passes the existing stop straight
 *    through, so a bug here can widen nothing and cannot move a stop;
 *  · a take profit can only ever close in profit, so the downside is an early
 *    exit, never a loss the position would not otherwise have taken;
 *  · every application is journalled as a position event, so a target that
 *    appears on a position is always attributable.
 *
 * @returns {(finding, suggestion) => Promise<{ok:boolean, error?:string}>}
 */
export function makeTargetApplier(db, creds, { amendPosition = null, recordEvent = null } = {}) {
  return async function applyTarget(finding, suggestion) {
    const tp = Number(suggestion?.tp)
    const sl = Number(finding?.brokerSl)
    if (!Number.isFinite(tp) || tp <= 0) return { ok: false, error: 'no usable target' }
    try {
      const amend = amendPosition
        ?? (await import('../lib/exec-engine.js')).amendPosition
      const res = await amend(creds, {
        positionId: finding.positionId,
        stopLoss: Number.isFinite(sl) ? sl : undefined,
        takeProfit: tp,
      })
      if (res && res.error) return { ok: false, error: String(res.error) }
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
          detail: `adopted position had no take profit; set to ${tp} (${suggestion.basis})`,
        })
      } catch { /* the journal must never undo the amend */ }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e?.message || 'amend failed' }
    }
  }
}
