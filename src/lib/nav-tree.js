// nav-tree — the ONE source of truth for the app's page/section map, used by
// the SectionNavFab table-of-contents navigator (owner 2026-08-01: "make a
// table of content professional style for the Navigation FAB contains both
// the different pages (sub-pages, table/form/card)").
//
// Every section carries its CONTENT KIND so the list says what you will land
// on before you jump (owner's taxonomy):
//   T    data table
//   F    form / controls
//   C    card of stats or prose
//   T+F  table with embedded controls
//
// Section ids are the pages' real scroll anchors (id="sec-…"); Tune's
// entries are TAB KEYS, not anchors — the Tune page passes `onSelect` to the
// FAB and switches tabs instead of scrolling. When a page adds/renames a
// section, THIS file is the place to record it — the per-page arrays the FAB
// used to receive were deleted so the map cannot drift page-by-page.
export const NAV_KIND_LEGEND = 'T table · F form · C card · T+F table with controls'

export const NAV_TREE = [
  {
    group: 'Overview',
    pages: [
      {
        path: '/performance', label: 'Performance', icon: '📊',
        sections: [
          { id: 'sec-accounts', label: 'Accounts', kind: 'T' },
          { id: 'sec-today-open', label: 'Today & open', kind: 'T' },
          { id: 'sec-weekend24', label: 'Weekend 24H', kind: 'T' },
          { id: 'sec-sessions', label: 'Market sessions', kind: 'T' },
          { id: 'sec-ledger', label: 'Timeframe ledger', kind: 'T' },
          { id: 'sec-gradients', label: 'Gradients', kind: 'C' },
          { id: 'sec-fx-bands', label: 'FX bands', kind: 'T' },
          { id: 'sec-strategy-matrix', label: 'Strategy × market', kind: 'T' },
          { id: 'sec-crypto', label: 'Crypto', kind: 'T' },
          { id: 'sec-winlag', label: 'Winners & laggards', kind: 'T' },
          { id: 'sec-regime', label: 'Regime', kind: 'T' },
          { id: 'sec-balance', label: 'Balance in/out', kind: 'T' },
          { id: 'sec-datafeed', label: 'Data feed', kind: 'C' },
          { id: 'sec-tiles', label: 'Tiles & equity', kind: 'C' },
        ],
      },
      {
        path: '/desk', label: 'Desk', icon: '🖥️',
        sections: [
          { id: 'sec-openpnl', label: 'Open trades', kind: 'C' },
          { id: 'sec-chartwall', label: 'Chart wall', kind: 'C' },
          { id: 'sec-broker', label: 'At the broker', kind: 'T+F' },
          { id: 'sec-loss-review', label: 'Trade lessons', kind: 'T+F' },
          { id: 'sec-correlation', label: 'Correlation clusters', kind: 'T' },
          { id: 'sec-order-ledger', label: 'Set-order ledger', kind: 'T+F' },
          { id: 'sec-closed7d', label: 'Closed at the broker', kind: 'T' },
          { id: 'sec-risk', label: 'Risk decisions', kind: 'T' },
          { id: 'sec-acct-engineering', label: 'Account engineering', kind: 'T' },
          { id: 'sec-controllers', label: 'Controllers', kind: 'F' },
          { id: 'sec-llmspend', label: 'LLM spend', kind: 'C' },
          { id: 'sec-alphadecay', label: 'Edge health', kind: 'T+F' },
          { id: 'sec-whynotrades', label: 'Why no trades?', kind: 'C' },
        ],
      },
    ],
  },
  {
    group: 'Trading',
    pages: [
      {
        path: '/trade', label: 'Trade', icon: '📈',
        sections: [
          { id: 'sec-status', label: 'Status', kind: 'C' },
          { id: 'sec-signals', label: 'Signals', kind: 'T' },
          { id: 'sec-positions', label: 'Open positions', kind: 'T' },
          { id: 'sec-broker', label: 'At the broker', kind: 'T+F' },
          { id: 'sec-recent', label: 'Recent trades', kind: 'T+F' },
          { id: 'sec-orderlog', label: 'Order log', kind: 'T+F' },
        ],
      },
      {
        path: '/risk', label: 'Risk', icon: '🛡️',
        sections: [
          { id: 'sec-rerisk', label: 'Reset / Re-Risk', kind: 'T+F' },
          { id: 'sec-account', label: 'Account snapshot', kind: 'C' },
          { id: 'sec-protection', label: 'Position protection', kind: 'F' },
          { id: 'sec-acct-risk', label: 'Account risk config', kind: 'F' },
          { id: 'sec-bot-risk', label: 'Bot Trade risk config', kind: 'F' },
          { id: 'sec-sizing', label: 'Sizing', kind: 'F' },
          { id: 'sec-cpp', label: 'C++ sidecar', kind: 'F' },
          { id: 'sec-emergency', label: 'Emergency', kind: 'F' },
          { id: 'sec-example-live', label: 'Example — live', kind: 'C' },
          { id: 'sec-example-cpp', label: 'Example — cpp', kind: 'C' },
        ],
      },
    ],
  },
  {
    group: 'Setup',
    pages: [
      {
        path: '/tune', label: 'Tune', icon: '⚙️',
        // TAB KEYS, not scroll anchors — Tune switches panels via onSelect.
        sections: [
          { id: 'pipeline', label: 'Pipeline', kind: 'F' },
          { id: 'watchlist', label: 'Watchlist', kind: 'T+F' },
          { id: 'backtest', label: 'Backtest', kind: 'T+F' },
          { id: 'presets', label: 'Presets', kind: 'F' },
        ],
      },
      {
        path: '/accounts', label: 'Accounts', icon: '💼',
        sections: [
          { id: 'sec-switches', label: 'Trading switches', kind: 'F' },
          { id: 'sec-clock', label: 'Market clock', kind: 'C' },
          { id: 'sec-primary', label: 'Bot account', kind: 'T+F' },
          { id: 'sec-others', label: 'Other accounts', kind: 'T+F' },
          { id: 'sec-insights', label: 'Strategy insights', kind: 'T' },
        ],
        children: [
          {
            path: '/accounts/audit', label: 'Workflow audit',
            sections: [
              { id: 'sec-clusters', label: 'Same-symbol clusters', kind: 'T' },
              { id: 'sec-workflow', label: 'Workflow audit', kind: 'T' },
            ],
          },
        ],
      },
      {
        path: '/connect', label: 'Connect', icon: '🔗',
        sections: [
          { id: 'sec-agent', label: 'Agent backend', kind: 'F' },
          { id: 'sec-ctrader', label: 'cTrader account', kind: 'T+F' },
          { id: 'sec-watchlists', label: 'Compare & copy watchlists', kind: 'T+F' },
        ],
      },
    ],
  },
]

/** Flat list of every page node (children included). */
export const NAV_PAGES = NAV_TREE.flatMap(g => g.pages.flatMap(p => [p, ...(p.children || [])]))

/** The page node for a location pathname, longest-prefix match. */
export function pageForPath(pathname) {
  let best = null
  for (const p of NAV_PAGES) {
    if (pathname === p.path || pathname.startsWith(p.path + '/')) {
      if (!best || p.path.length > best.path.length) best = p
    }
  }
  return best
}
