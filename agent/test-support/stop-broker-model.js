// ---------------------------------------------------------------------------
// agent/test-support/stop-broker-model.js — a STATEFUL model of the cpp-exec
// sidecar's amend path plus the broker behind it, for the integrated stop-loss
// suite (02-10-2026, PR-3). Test support only; nothing in agent/ imports it.
//
// WHY A MODEL AND NOT A STUB. stop-amend-rail.test.js answers one canned body
// per request, which proves Node sends the right fields. It cannot prove the
// SEQUENCE: that a stop moved by the ladder, then trailed by the broker, then
// tightened by the Chandelier, still ends Opposite, still carries its target,
// and never loosens. That needs a broker that remembers, and an amend that
// REPLACES protection the way cTrader's does.
//
// WHAT IS A COPY OF THE CONTRACT, AND WHAT IS INVENTED.
//   * Copied from cpp-exec/src/protection_ratchet.hpp and pinned by
//     tests/test_protection_ratchet.cpp: the policy block shape, the three
//     read-back verdicts, "unchanged" when the broker already holds a stop at
//     least as tight AND the policy, the carried take profit on a ratchet, the
//     policyOnly amend that reads the stop and target from the broker, the
//     refusal that retries without the flags and starts a cooldown.
//   * Copied from the broker's documented behaviour: an amend REPLACES a
//     position's stop, target, trigger method and trailing flag.
//   * INVENTED, and switchable so a test can run both answers (they are the
//     plan's four "not verifiable until live" unknowns):
//       omittedFlags   'preserve' | 'reset'   what an amend that omits the
//                      trigger/trailing fields does to them
//       trailingAnchor 'amend' | 'entry'      what the trailing distance is
//                      measured from
//       trailingReadback 'reliable' | 'absent' whether a position read shows
//                      the trailing flag (Spotware's 2021 bug: it reads absent)
//       refuseFlags    true                   the broker rejects an amend
//                      that carries the trigger/trailing fields
// DETERMINISM. No timers, no wall clock: the model's clock is advanced by the
// test (tick(ms)); a price move is price(symbolId, {bid, ask}).
// ---------------------------------------------------------------------------

import http from 'node:http'

export const COOLDOWN_MS = 6 * 60 * 60 * 1000

const triggerNumber = v => (v === 'TRADE' ? 1 : v === 'OPPOSITE' ? 2 : v === 'DOUBLE_TRADE' ? 3 : v === 'DOUBLE_OPPOSITE' ? 4
  : Number.isInteger(v) && v >= 1 && v <= 4 ? v : 0)

export async function startStopBrokerModel({ account = '4001', omittedFlags = 'preserve', trailingAnchor = 'amend',
  trailingReadback = 'reliable', refuseFlags = false, startMs = 1_800_000_000_000 } = {}) {
  const positions = new Map()
  const quotes = new Map()
  const cooldowns = new Map() // `${account}:${symbolId}` -> until ms
  const state = { nowMs: startMs, requests: [], amends: [], refuseFlags, omittedFlags, trailingAnchor, trailingReadback }
  let nextId = 7000

  const dirOf = p => (p.tradeSide === 'SELL' ? -1 : 1)

  function open({ symbolId = 7, tradeSide = 'BUY', entry, stopLoss, takeProfit = null, trigger = 1, trailing = false }) {
    const pos = { positionId: nextId++, symbolId, tradeSide, entry, stopLoss, takeProfit, trigger, trailing, trailDist: null,
      price: entry }
    positions.set(pos.positionId, pos)
    quotes.set(String(symbolId), { bid: entry, ask: entry })
    return pos
  }

  /** The position as the broker lists it (ProtoOAPosition). */
  function listed(p) {
    return {
      positionId: p.positionId, ctidTraderAccountId: Number(account),
      tradeData: { symbolId: p.symbolId, tradeSide: p.tradeSide, volume: 1000 },
      price: p.entry,
      ...(p.stopLoss > 0 ? { stopLoss: p.stopLoss } : {}),
      ...(p.takeProfit > 0 ? { takeProfit: p.takeProfit } : {}),
      stopLossTriggerMethod: p.trigger,
      ...(state.trailingReadback === 'reliable' ? { trailingStopLoss: p.trailing } : {}),
    }
  }

  const tighter = (dir, a, b) => (dir === 1 ? Math.max(a, b) : Math.min(a, b))
  const atLeastAsTight = (dir, actual, requested) => actual > 0 && (dir === 1 ? actual >= requested : actual <= requested)

  function readbackVerdict(req, p) {
    const listedPos = listed(p)
    const counted = req.trigger > 0 || req.trailing === true
    if (!counted) return 'none'
    let mismatch = false, unreadable = false
    if (req.trigger > 0) { if (!listedPos.stopLossTriggerMethod) unreadable = true; else if (listedPos.stopLossTriggerMethod !== req.trigger) mismatch = true }
    if (req.trailing === true) { if (typeof listedPos.trailingStopLoss !== 'boolean') unreadable = true; else if (!listedPos.trailingStopLoss) mismatch = true }
    return mismatch ? 'mismatch' : unreadable ? 'unreadable' : 'confirmed'
  }

  function applyOnBroker(p, { sl, tp, trigger, trailing }) {
    p.stopLoss = sl
    p.takeProfit = tp > 0 ? tp : null // an amend REPLACES the target: no value, no target
    if (trigger > 0) p.trigger = trigger
    else if (state.omittedFlags === 'reset') p.trigger = 1
    if (trailing === true) {
      p.trailing = true
      const q = quotes.get(String(p.symbolId)) || { bid: p.entry, ask: p.entry }
      const ref = state.trailingAnchor === 'entry' ? p.entry : (dirOf(p) === 1 ? q.bid : q.ask)
      p.trailDist = Math.abs(ref - sl)
    } else if (state.omittedFlags === 'reset') { p.trailing = false; p.trailDist = null }
    state.amends.push({ positionId: p.positionId, stopLoss: p.stopLoss, takeProfit: p.takeProfit, trigger: p.trigger, trailing: p.trailing })
  }

  function amend(body) {
    const p = positions.get(Number(body.positionId))
    if (!p) return { status: 404, body: `POSITION_NOT_FOUND: position ${body.positionId} unknown` }
    const dir = dirOf(p)
    const req = { trigger: triggerNumber(body.stopLossTriggerMethod), trailing: typeof body.trailingStopLoss === 'boolean' ? body.trailingStopLoss : null }
    const guarded = body.ratchetOnly === true || body.policyOnly === true
    if (guarded && body.expectedDirection !== undefined && body.expectedDirection !== dir) {
      return { status: 422, body: JSON.stringify({ errorCode: 'guard_ratchet_identity', description: 'expected direction does not match the position' }) }
    }
    let sl, tp
    if (body.policyOnly === true) {
      if (!(p.stopLoss > 0)) return { status: 422, body: JSON.stringify({ errorCode: 'GUARD_NO_STOP', description: 'no stop to carry' }) }
      sl = p.stopLoss; tp = p.takeProfit ?? 0
    } else {
      sl = Number(body.stopLoss) || 0
      tp = body.takeProfit !== undefined ? Number(body.takeProfit) || 0 : (body.ratchetOnly === true ? (p.takeProfit ?? 0) : 0)
      if (body.ratchetOnly === true && p.stopLoss > 0) sl = tighter(dir, p.stopLoss, sl)
    }
    const heldAlready = guarded && p.stopLoss > 0 && atLeastAsTight(dir, p.stopLoss, sl)
    const policyDone = (req.trigger === 0 || p.trigger === req.trigger) && (req.trailing !== true || p.trailing === true)
    const withProtection = (extra = {}) => {
      const l = listed(p)
      return { ok: true, executionType: 'ORDER_AMENDED', positionId: p.positionId, ...extra, protection: {
        verified: true, source: 'broker_reconcile', stopLoss: l.stopLoss ?? null, takeProfit: l.takeProfit ?? null,
        stopLossTriggerMethod: l.stopLossTriggerMethod ?? null, trailingStopLoss: l.trailingStopLoss ?? null } }
    }
    const block = (applied, readback, refused, skipped) => ({ requested: { stopLossTriggerMethod: req.trigger > 0 ? req.trigger : null,
      trailingStopLoss: req.trailing }, applied, readback, refused, skipped })
    if (heldAlready && policyDone) {
      return { status: 200, body: JSON.stringify(withProtection({ unchanged: true,
        ...(req.trigger > 0 || req.trailing !== null ? { policy: block(false, readbackVerdict(req, p), null, null) } : {}) })) }
    }
    const key = `${account}:${p.symbolId}`
    const hasFlags = req.trigger > 0 || req.trailing !== null
    const cooling = hasFlags && (cooldowns.get(key) ?? 0) > state.nowMs
    let refused = null
    let applyFlags = hasFlags && !cooling
    if (applyFlags && state.refuseFlags) {
      refused = { errorCode: 'INVALID_REQUEST', description: 'policy not supported' }
      cooldowns.set(key, state.nowMs + COOLDOWN_MS)
      applyFlags = false
    }
    applyOnBroker(p, { sl, tp, trigger: applyFlags ? req.trigger : 0, trailing: applyFlags ? req.trailing : null })
    const out = withProtection(heldAlready ? { unchanged: false } : {})
    if (hasFlags) {
      out.policy = block(applyFlags, refused ? 'unreadable' : applyFlags ? readbackVerdict(req, p) : 'none', refused, cooling ? 'cooldown' : null)
    }
    return { status: 200, body: JSON.stringify(out) }
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined
      state.requests.push({ method: req.method, url: req.url, body })
      let out = { status: 200, body: '{}' }
      if (req.url === '/amend') out = amend(body)
      else if (req.url === '/positions') out = { status: 200, body: JSON.stringify({ ctidTraderAccountId: Number(account), position: [...positions.values()].map(listed) }) }
      else if (req.url === '/health') out = { status: 200, body: JSON.stringify({ ok: true, connected: true, hasCredentials: true, lastReconcileAt: state.nowMs, accounts: [Number(account)] }) }
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(out.body)
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    account,
    get requests() { return state.requests },
    /** Every amend the broker APPLIED, in order (what it holds after each). */
    get amends() { return state.amends },
    amendRequests() { return state.requests.filter(r => r.url === '/amend').map(r => r.body) },
    set: opts => Object.assign(state, opts),
    open,
    position: id => positions.get(Number(id)),
    listed: id => listed(positions.get(Number(id))),
    tick(ms) { state.nowMs += ms },
    get nowMs() { return state.nowMs },
    /** The market moves. A broker-trailed stop follows it, server-side, tighten-only. */
    price(symbolId, { bid, ask }) {
      quotes.set(String(symbolId), { bid, ask })
      for (const p of positions.values()) {
        if (p.symbolId !== symbolId) continue
        p.price = dirOf(p) === 1 ? bid : ask
        if (p.trailing && p.trailDist != null && p.stopLoss > 0) {
          const dir = dirOf(p)
          const level = dir === 1 ? bid - p.trailDist : ask + p.trailDist
          const next = tighter(dir, p.stopLoss, level)
          if (next !== p.stopLoss) p.stopLoss = next
        }
      }
    },
    close: () => new Promise(r => server.close(r)),
  }
}
