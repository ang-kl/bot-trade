// ---------------------------------------------------------------------------
// agent/lib/premise.js — a strategy's PREMISE as one price the monitor can read.
//
// Claude · № 14,745 15-Oct (owner order § 14,741·A PR-1; choices § 14,744:
// tick-fired, level frozen at entry; claude-builder).
//
// The trader's method (§ 14,740·A): before the stop is ever reached, the one
// question is "is the reason for this trade still true?" Each strategy names
// the level that answers it — the VWAP it pulled back to, the range high it
// broke, the value-area edge it faded — and the monitor closes the position
// when price crosses that level (position-manager.js parsePriceTrigger,
// `price<X` / `price>X`). Until this helper every bot entry carried the text
// `Close beyond swing origin undefined` (fib's wording stamped on every
// strategy), which the monitor could not read, so the check never fired.
//
// Two rules, both deliberate:
//  · The level must sit STRICTLY between the stop and the entry, on the stop
//    side. A level beyond the stop would never fire first (the stop wins);
//    a level on the profit side is a target, not a premise. Either is
//    dropped and the trigger records WHY (`unreadable:outside_stop`), never a
//    silent null.
//  · Five decimals, the precision the parser's `[\d.]+` reads and the fib
//    level already uses (fib-strategy.js roundedLevel). No symbol digits are
//    known at signal time; a tick either side of a rounded level is noise
//    against the strategy's own ATR buffers.
// ---------------------------------------------------------------------------

const round5 = (v) => Math.round(Number(v) * 100000) / 100000

/**
 * The premise as {op, price}, or null when the level is not inside the stop.
 * @param {{bias:'long'|'short', entry:number, sl:number, level:number}} p
 */
export function premiseFor({ bias, entry, sl, level }) {
  const e = Number(entry), s = Number(sl), l = Number(level)
  if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(l)) return null
  if (bias === 'long') return s < l && l < e ? { op: '<', price: round5(l) } : null
  if (bias === 'short') return e < l && l < s ? { op: '>', price: round5(l) } : null
  return null
}

/** `price<X` / `price>X` for the monitor, or null. */
export function premiseTrigger(premise) {
  if (!premise || (premise.op !== '<' && premise.op !== '>')) return null
  const p = Number(premise.price)
  if (!Number.isFinite(p) || p <= 0) return null
  return `price${premise.op}${round5(p)}`
}

/** The recorded reason a premise is absent — never free text, never undefined. */
export const unreadablePremise = (why) => `unreadable:${String(why || 'unknown').replace(/\s+/g, '_')}`
export const noPremise = (source) => `none_${String(source || 'unknown').replace(/\s+/g, '_')}`

/** True for a trigger the monitor acts on. */
export function isReadablePremise(raw) {
  return typeof raw === 'string' && /^price\s*[<>]\s*[\d.]+\s*$/i.test(raw.trim())
}

/**
 * The trigger to stamp on a signal: its own premise when inside the stop,
 * else the reason. `signal.invalidation === null` with a level supplied means
 * the strategy computed one that fell outside the stop.
 */
export function premiseTriggerForSignal(signal) {
  if (!signal) return unreadablePremise('no_signal')
  const t = premiseTrigger(signal.invalidation)
  if (t) return t
  if (signal.invalidation_reason) return unreadablePremise(signal.invalidation_reason)
  return unreadablePremise(signal.strategy || 'unknown')
}

/** The two signal fields every strategy returns: its premise, or why it has none. */
export function premiseFields({ bias, entry, sl, level }) {
  const p = premiseFor({ bias, entry, sl, level })
  return { invalidation: p, invalidation_reason: p ? null : 'outside_stop' }
}

/**
 * Claude · № 14,758 15-Oct (Codex round 2 on #1374, two P1s; owner: fix in
 * the PR). The premise is frozen at the signal, but a market order fills
 * elsewhere and the bracket is re-anchored to the fill. Re-check the band at
 * the fill: the premise stands only while it is still strictly between the
 * fill-anchored stop and the fill. A crossed premise would close the trade on
 * the next tick; a stop past the premise would fire first. Either is recorded
 * as `unreadable:fill_outside_band` — the trade is kept, the broker stop
 * governs — never fired, never silent. An unreadable trigger passes through.
 */
export function premiseAtFill({ trigger, bias, fill, sl }) {
  if (!isReadablePremise(trigger)) return trigger || unreadablePremise('unknown')
  const m = String(trigger).trim().match(/^price\s*([<>])\s*([\d.]+)\s*$/i)
  const level = Number(m[2])
  const side = m[1] === '<' ? 'long' : 'short'
  if (bias && bias !== side) return unreadablePremise('fill_outside_band')
  if (fill == null || fill === '' || sl == null || sl === '') return trigger // no fill known: the frozen premise stands
  const f = Number(fill), s = Number(sl)
  if (!Number.isFinite(f) || !Number.isFinite(s)) return trigger
  return premiseFor({ bias: side, entry: f, sl: s, level }) ? trigger : unreadablePremise('fill_outside_band')
}
