// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
//
// WHICH DESK ROUTES BELONG TO ONE COLLAPSIBLE SECTION, and the gate that lets
// a section fetch them only while it is on screen.
//
// Measured 10-10: Desk polls every 5 s while a position is live and it fetched
// every route on every cycle, including the routes of sections that sat
// collapsed (a collapsed Card hides its body with display:none — the data was
// fetched, rendered and never seen). ~270 requests a minute from one phone tab.
//
// The map is read from Desk.jsx, route by route, against the state each one
// sets and every place that state is read:
//
//   route                          state                  read only by
//   /state/risk-events?limit=200   events                 Risk decisions
//   /state/alpha-decay             alphaDecay             Edge health
//   /state/orders                  orders                 Set-order ledger
//   /state/postmortems             postmortems            Trade lessons
//   /state/correlation             correlation            Correlation clusters
//   /state/market-pulse            pulse                  Market pulse
//   POST /actions/broker-history   brokerHistory          Closed at the broker
//   /state/heartbeats              heartbeats, runtime    Controllers
//
// NOT here, because something always on screen reads them: /state/positions
// (gauges, broker integrity column, charts, "why no trades"), the broker
// snapshot and its cache (At the broker, gauges), /state/health and
// /state/autotrade-timeframes and /state/config (the status strip),
// /state/scans and /state/prices (the broker table's money conversion),
// /state/market-hours (broker and closed tables), /state/duplicate-trades and
// /state/weekend-loss-flags (the warnings). The broker-history CACHE
// (/state/broker-cache) still paints "Closed at the broker" instantly when it
// is opened, and its collapsed summary when one was cached.

// One fetcher per section. `ctx` carries the page's own agentGet, its
// broker-history POST, the "Closed at the broker" window and the viewing
// session (view.single: the broker read needs exactly one account).
const SECTION_FETCH = Object.freeze({
  risk: ({ get }) => get('/state/risk-events?limit=200'),
  alphadecay: ({ get }) => get('/state/alpha-decay'),
  'order-ledger': ({ get }) => get('/state/orders'),
  'loss-review': ({ get }) => get('/state/postmortems'),
  correlation: ({ get }) => get('/state/correlation'),
  pulse: ({ get }) => get('/state/market-pulse'),
  // The page hands the broker-history POST in (`historyPost`), so the reply is
  // consumed where it is read — Desk's own `.then` — as before.
  closed7d: ({ historyPost, historyDays, view }) => (view?.single ? historyPost({ days: historyDays, accountId: view.id }) : null),
  controllers: ({ get }) => get('/state/heartbeats'),
})

/** The section ids that own routes, in fetch order. */
export const DESK_GATED_SECTIONS = Object.freeze(Object.keys(SECTION_FETCH))

/**
 * Tracks which sections are on screen. `set(id, shown)` is called by each
 * section on mount, on every expand/collapse and (false) on unmount;
 * `onOpen(id)` runs on a closed -> open transition so the section fetches AT
 * ONCE instead of waiting out the poll interval. From then on the page's own
 * cycle includes it (`isOpen`), until it closes again.
 */
export function createSectionGate({ onOpen = () => {} } = {}) {
  const shown = new Map()
  return {
    isOpen: id => shown.get(id) === true,
    set(id, value) {
      const was = shown.get(id) === true
      const now = value === true
      shown.set(id, now)
      if (now && !was) onOpen(id)
    },
  }
}

/**
 * Start the fetches of every OPEN gated section (or only of `only`, the
 * at-once fetch on open). Returns [[sectionId, promise]]; a closed section
 * starts nothing. A section with nothing to read for this view (broker
 * history without one account) is left out.
 */
export function fetchOpenSections(gate, ctx, only = null) {
  return DESK_GATED_SECTIONS
    .filter(id => gate.isOpen(id) && (only == null || only.includes(id)))
    .map(id => [id, SECTION_FETCH[id](ctx)])
    .filter(([, pending]) => pending != null)
}
