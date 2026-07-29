// UI-5 — worked examples for the risk controls the owner asked about.
//
// WHY THESE ARE COMPUTED, NOT WRITTEN. A hardcoded example ("balance $50,000
// → step $500") is a lie the moment the owner changes a setting or the
// balance moves, and a stale example on a risk control is worse than none:
// it teaches a number that is not the one the system will use. Every figure
// below is derived from the SAME config the engine reads, so the example
// always describes what will actually happen.
//
// WHERE A NUMBER IS NOT AVAILABLE, SAY SO. Each builder returns null rather
// than inventing an input it was not given — the caller renders nothing, not
// a plausible-looking fiction. Where an example needs a HYPOTHETICAL position
// (the engine's arithmetic is per-position and the settings page has no
// position in hand), the hypothetical is stated in the sentence — "say a 1.0
// lot EURUSD long" — never smuggled in as if it were live state.

const money = (n) => `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const money0 = (n) => `$${Math.round(Number(n)).toLocaleString()}`
// null/undefined/'' are MISSING, not zero. Number(null) === 0 and Number('')
// === 0, so a bare Number.isFinite here would turn an absent setting into a
// confident "$0.00" example — the exact fiction this module exists to avoid.
const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v))

/**
 * Profit ratchet (staircase). Mirrors autoStepUsd + computeFloor in
 * agent/services/profit-ratchet.js — step is 1% of balance clamped 25..500
 * when not fixed, and the floor sits ONE step below the highest step reached.
 *
 * Only used when there is NO live staircase state: once the ratchet has run
 * the card shows the real baseline/HWM/floor, which beats any example.
 */
export function ratchetExample({ balance, stepUsd = null } = {}) {
  if (!fin(balance) || Number(balance) <= 0) return null
  const bal = Number(balance)
  const fixed = fin(stepUsd) && Number(stepUsd) > 0
  const step = fixed ? Number(stepUsd) : Math.min(500, Math.max(25, bal * 0.01))
  return [
    `Balance ${money(bal)} → step ${money(step)}${fixed ? ' (fixed)' : ` (auto: 1% of balance, clamped ${money0(25)}–${money0(500)})`}.`,
    `It baselines at ${money(bal)} on the first pass. Nothing is protected until equity reaches ${money(bal + step)} — one full step.`,
    `At ${money(bal + step)} the first step banks and the floor locks at ${money(bal)}: your starting equity is protected.`,
    `Each further ${money(step)} of high-water raises the floor one step — to ${money(bal + step)} at ${money(bal + 2 * step)}, and so on. The floor never moves down.`,
  ]
}

/**
 * Profit Keeper. TWO modes with completely different arithmetic, and
 * 'adaptive' is the default — an example that only described fixed mode
 * would be wrong for most readers.
 *
 * Mirrors decideProfitKeeper in agent/services/profit-keeper.js:
 *   adaptive → arm at max(armAtrMult × ATR-value, armBalancePct% of balance),
 *              then a Chandelier stop trailAtrMult × ATR behind the peak,
 *              tightened to spikeTrailAtrMult while a spike bar holds.
 *   fixed    → arm at armProfitUsd of peak profit, lock (100 − givebackPct)%
 *              of that peak (givebackPct clamped 0..95 by the engine).
 *
 * `balance` is optional: without it the adaptive noise floor cannot be stated,
 * so that clause is omitted rather than guessed.
 */
export function keeperExample(cfg = {}, { balance = null } = {}) {
  if (!cfg || typeof cfg !== 'object') return null

  if (cfg.mode === 'fixed') {
    // The engine refuses to arm unless armProfitUsd > 0 (profit-keeper.js:190),
    // so a zero/negative arm has no example to give.
    if (!fin(cfg.armProfitUsd) || Number(cfg.armProfitUsd) <= 0 || !fin(cfg.givebackPct)) return null
    const arm = Number(cfg.armProfitUsd)
    const give = Math.min(95, Math.max(0, Number(cfg.givebackPct)))
    const keep = (100 - give) / 100
    const peak = arm * 2.4                     // an illustrative run past the arm
    return [
      `Nothing happens until a position peaks at ${money(arm)} of floating profit — below that it is left alone.`,
      `Say it runs to ${money(peak)}. The keeper locks ${100 - give}% of that peak: a broker stop worth ${money(peak * keep)}.`,
      `Give back to ${money(peak * keep)} and it closes at market with that banked.`,
      `The lock only ever rises: a new peak of ${money(peak * 1.5)} moves it to ${money(peak * 1.5 * keep)}. It never loosens.`,
    ]
  }

  // adaptive (the default)
  if (!fin(cfg.armAtrMult) || !fin(cfg.trailAtrMult)) return null
  const armMult = Number(cfg.armAtrMult)
  const trailMult = Number(cfg.trailAtrMult)
  // Hypothetical position, stated as such: 1.0 lot EURUSD = 100,000 units, so
  // one point of ATR is $100,000 per unit of price — 0.0042 ATR → $420.
  const atr = 0.0042
  const units = 100_000
  const armUsdAtr = armMult * atr * units
  const lines = [
    `Say a 1.0 lot EURUSD long, 1h ATR ${atr.toFixed(4)} — so one ATR is worth ${money0(atr * units)} on that position.`,
  ]
  if (fin(balance) && Number(balance) > 0 && fin(cfg.armBalancePct)) {
    const armUsdBal = Number(balance) * (Number(cfg.armBalancePct) / 100)
    lines.push(`It arms at the LARGER of ${armMult}×ATR (${money0(armUsdAtr)}) and ${cfg.armBalancePct}% of balance (${money0(armUsdBal)}) → ${money0(Math.max(armUsdAtr, armUsdBal))} of peak profit.`)
  } else {
    lines.push(`It arms once peak profit passes ${armMult}×ATR — ${money0(armUsdAtr)} here — or the ${fin(cfg.armBalancePct) ? `${cfg.armBalancePct}% of balance` : 'balance-percentage'} noise floor, whichever is larger. (Balance unknown here, so that side is not shown.)`)
  }
  lines.push(`Once armed, a broker stop trails ${trailMult}×ATR behind the PEAK price — ${(trailMult * atr).toFixed(4)}, about ${money0(trailMult * atr * units)} back. Peak rises, stop follows; peak falls, stop stays.`)
  if (cfg.spikeTightenEnabled !== false && fin(cfg.spikeTrailAtrMult) && fin(cfg.spikeRangeAtrMult)) {
    lines.push(`A bar ranging ${cfg.spikeRangeAtrMult}×ATR or more counts as a spike: the trail tightens to ${cfg.spikeTrailAtrMult}×ATR (${money0(Number(cfg.spikeTrailAtrMult) * atr * units)} back) while it holds, because a vertical move usually IS the peak.`)
  }
  if (fin(cfg.scaleOutFrac) && Number(cfg.scaleOutFrac) > 0) {
    lines.push(`${Math.round(Number(cfg.scaleOutFrac) * 100)}% is banked the moment it arms; the rest runs on the trail.`)
  }
  if (fin(cfg.takeProfitUsd) && Number(cfg.takeProfitUsd) > 0) {
    lines.push(`Hard exit: any position reaching ${money(Number(cfg.takeProfitUsd))} of profit is closed outright, armed or not.`)
  }
  return lines
}

/**
 * Loss Guardian. Mirrors decideLossGuardian in agent/services/loss-guardian.js:
 * a NAKED position gets a protective stop maxAtrMult × ATR from entry, or
 * fallbackAdversePct of ENTRY PRICE when ATR is unavailable, and is closed
 * outright when price is already beyond that level.
 */
export function guardianExample({ maxAtrMult, fallbackAdversePct, maxHoldHours = null } = {}) {
  if (!fin(maxAtrMult) || !fin(fallbackAdversePct)) return null
  const mult = Number(maxAtrMult)
  const pct = Number(fallbackAdversePct)
  const entry = 1.0850
  const atr = 0.0042
  const px = (v) => Number(v).toFixed(5)
  const lines = [
    `A position turns up with NO stop at the broker — adopted from the account, or an amend that failed.`,
    `Say a EURUSD long at ${px(entry)}, 1h ATR ${atr.toFixed(4)} → protective stop ${mult}×ATR below entry: ${px(entry - mult * atr)}.`,
    `Wide on purpose — it is a backstop against a runaway loss, not an entry stop, so mean-reversion room survives.`,
    `No ATR available → cap the adverse move at ${(pct * 100).toFixed(2)}% of entry instead: ${px(entry * (1 - pct))}.`,
    `Price already past that level → the position is CLOSED, rather than given a stop it has gone through.`,
  ]
  lines.push(fin(maxHoldHours) && Number(maxHoldHours) > 0
    ? `Time cap on: a position like this still open after ${Number(maxHoldHours)}h is closed regardless of P&L.`
    : `Time cap off — price levels decide, not the clock.`)
  return lines
}

/**
 * Closed-market limit orders. No numeric config beyond on/off, so the example
 * is a sequence rather than arithmetic — and says so by being one.
 */
export function closedMarketExample({ on } = {}) {
  if (on == null) return null
  if (!on) {
    return [
      `Off: a setup firing while its market is closed goes to the internal re-fire queue.`,
      `At open the bot re-scans and sends a MARKET order — the fill is whatever the open prints, gap included.`,
      `Nothing is visible at the broker in the meantime.`,
    ]
  }
  return [
    `A cup-and-handle fires on a stock at 22:00, hours after its exchange closed.`,
    `A real broker LIMIT order rests at the setup's entry with its SL and TP attached — visible on the desk, not hidden in a queue.`,
    `It clears the SAME risk gate as a market order: exposure, daily loss, duplicate symbol. A closed market cannot bypass risk.`,
    `At open it fills at the entry price or better — no chasing the gap. One order per symbol.`,
    `Unfilled by the timeframe's expiry → cancelled, not left resting into a setup that has gone stale.`,
  ]
}
