// ---------------------------------------------------------------------------
// agent/lib/order-lots.js — what a pad's Lots box may send.
//
// The lot fix (Claude · № 13,396 12-Oct, owner "Go lot fix") made a BLANK lots
// mean risk-based sizing: no cap is sent, and the gate sizes the order to the
// account's risk budget. A supplied lots that is not a positive number must
// therefore be refused, never read as blank: 0, -1 or 'abc' would otherwise
// send an uncapped order (Codex P1 on #1328 — Claude · № 13,496 12-Oct;
// claude-builder). The route (actions.js manual-order) and its dry run
// (services/preorder.js) share this one reading.
// ---------------------------------------------------------------------------

/** True for a blank lots (omitted, null, empty or spaces) or a positive
 * finite number (a number or a numeric string). Everything else is false. */
export function lotsBlankOrPositive(lots) {
  if (lots == null || (typeof lots === 'string' && lots.trim() === '')) return true
  return (typeof lots === 'number' || typeof lots === 'string') && Number.isFinite(Number(lots)) && Number(lots) > 0
}
