// ---------------------------------------------------------------------------
// agent/lib/order-protection.js — broker-side spike protection helpers.
//
// Sub-second spikes can only be answered by broker-resident order semantics —
// no polling tier reacts in 3 seconds. First lever: the STOP TRIGGER METHOD.
// cTrader's default (TRADE) triggers a stop the instant the default quote
// side TOUCHES the level, so a 2-second spread blowout or a single wick
// sweeps the SL even when the market never really traded there. OPPOSITE
// triggers on the other side of the spread; the DOUBLE_* variants require a
// confirming second quote — the broker's built-in remedy for spike sweeps
// (owner 2026-07-24: "my concern is the spike lost which move less than 3
// seconds").
//
// Config-gated: risk config `stopTriggerMethod` unset/null → no field is
// sent and broker behaviour is EXACTLY as before. Values may be the enum
// name (case-insensitive) or the numeric wire value.
// ---------------------------------------------------------------------------

export const STOP_TRIGGER_METHODS = {
  TRADE: 1,           // default: touch on the quote side (spike-sensitive)
  OPPOSITE: 2,        // other side of the spread must reach the level
  DOUBLE_TRADE: 3,    // two consecutive quotes beyond the level
  DOUBLE_OPPOSITE: 4, // two consecutive opposite-side quotes beyond it
}

/**
 * Order-payload fragment for the configured stop trigger method. Empty
 * object when unset or unrecognized — never a guess.
 */
export function stopTriggerField(config) {
  const m = config?.stopTriggerMethod
  if (m == null || m === '') return {}
  const v = typeof m === 'number' ? m : STOP_TRIGGER_METHODS[String(m).toUpperCase()]
  return Object.values(STOP_TRIGGER_METHODS).includes(v) ? { stopTriggerMethod: v } : {}
}
