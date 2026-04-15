// Client-side cTrader types + helpers — Phase 4 wires this up.
// The backend lives in api/ctrader.js (ported verbatim from v1).
// This module is the small, typed surface the React tree consumes.
export const POSITION_STATES = ['WATCHING', 'PENDING', 'LIVE', 'WON', 'LOST', 'CANCELLED']
