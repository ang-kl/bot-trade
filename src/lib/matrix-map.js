// matrix-map.js — Maps each minion ID to a row and column in the
// Blueshift-style quant trading matrix (3 rows x 5 columns).

// ── Matrix row/column constants ───────────────────────────────────

export const ROWS = ['QUANT', 'TECHNICAL', 'FUNDAMENTAL']
export const COLS = ['TRENDING', 'MEAN_REV', 'BREAKOUT', 'CARRY', 'EVENT']
export const COL_LABELS = {
  TRENDING: 'Trending',
  MEAN_REV: 'Mean-Rev',
  BREAKOUT: 'Breakout',
  CARRY: 'Carry',
  EVENT: 'Event',
}

// ── Row mapping (minionId -> row) ─────────────────────────────────
// QUANT:        researchers + economists
// TECHNICAL:    traders
// FUNDAMENTAL:  journalists + political

export const MINION_ROW = {
  // Researchers -> QUANT
  chart_scanner:    'QUANT',
  order_flow:       'QUANT',
  correlation:      'QUANT',
  seasonal:         'QUANT',
  sentiment:        'QUANT',
  // Economists -> QUANT
  central_bank:     'QUANT',
  inflation:        'QUANT',

  // Traders -> TECHNICAL
  fx_scalper:       'TECHNICAL',
  swing_trader:     'TECHNICAL',
  momentum_hunter:  'TECHNICAL',
  mean_reverter:    'TECHNICAL',
  carry_analyst:    'TECHNICAL',
  commodity_trader: 'TECHNICAL',
  crypto_degen:     'TECHNICAL',
  index_arb:        'TECHNICAL',

  // Journalists -> FUNDAMENTAL
  tokyo_desk:       'FUNDAMENTAL',
  beijing_desk:     'FUNDAMENTAL',
  singapore_desk:   'FUNDAMENTAL',
  london_desk:      'FUNDAMENTAL',
  frankfurt_desk:   'FUNDAMENTAL',
  nyc_desk:         'FUNDAMENTAL',
  sydney_desk:      'FUNDAMENTAL',
  mumbai_desk:      'FUNDAMENTAL',
  seoul_desk:       'FUNDAMENTAL',
  // Political -> FUNDAMENTAL
  us_politics:      'FUNDAMENTAL',
  asia_geopolitics: 'FUNDAMENTAL',
  mideast_desk:     'FUNDAMENTAL',
}

// ── Column mapping (minionId -> columns[]) ────────────────────────
// A minion can appear in more than one column.

export const MINION_COLS = {
  // Researchers
  chart_scanner:    ['TRENDING', 'BREAKOUT'],
  order_flow:       ['MEAN_REV'],
  correlation:      ['TRENDING'],
  seasonal:         ['MEAN_REV'],
  sentiment:        ['EVENT'],

  // Economists
  central_bank:     ['CARRY'],
  inflation:        ['CARRY'],

  // Traders
  fx_scalper:       ['BREAKOUT'],
  swing_trader:     ['TRENDING'],
  momentum_hunter:  ['TRENDING', 'BREAKOUT'],
  mean_reverter:    ['MEAN_REV'],
  carry_analyst:    ['CARRY'],
  commodity_trader: ['TRENDING'],
  crypto_degen:     ['BREAKOUT'],
  index_arb:        ['MEAN_REV'],

  // Journalists (all -> EVENT)
  tokyo_desk:       ['EVENT'],
  beijing_desk:     ['EVENT'],
  singapore_desk:   ['EVENT'],
  london_desk:      ['EVENT'],
  frankfurt_desk:   ['EVENT'],
  nyc_desk:         ['EVENT'],
  sydney_desk:      ['EVENT'],
  mumbai_desk:      ['EVENT'],
  seoul_desk:       ['EVENT'],

  // Political (all -> EVENT)
  us_politics:      ['EVENT'],
  asia_geopolitics: ['EVENT'],
  mideast_desk:     ['EVENT'],
}

// ── classifyVotes ─────────────────────────────────────────────────
// Takes an array of minion report objects and returns a 3x5 matrix
// with vote counts per cell.
//
// Input:  [{ minionId, bias, conviction, ... }, ...]
// Output: { QUANT: { TRENDING: { long, short, neutral, skip, avgConv }, ... }, ... }

export function classifyVotes(minionReports) {
  // Initialise empty matrix
  const matrix = {}
  for (const row of ROWS) {
    matrix[row] = {}
    for (const col of COLS) {
      matrix[row][col] = { long: 0, short: 0, neutral: 0, skip: 0, avgConv: 0 }
    }
  }

  // Track conviction sums and counts for averaging
  const convSums = {}
  const convCounts = {}
  for (const row of ROWS) {
    convSums[row] = {}
    convCounts[row] = {}
    for (const col of COLS) {
      convSums[row][col] = 0
      convCounts[row][col] = 0
    }
  }

  for (const report of minionReports) {
    const { minionId, bias, conviction } = report
    const row = MINION_ROW[minionId]
    const cols = MINION_COLS[minionId]
    if (!row || !cols) continue

    const normBias = (bias || 'skip').toLowerCase()
    const bucket = ['long', 'short', 'neutral'].includes(normBias) ? normBias : 'skip'
    const conv = typeof conviction === 'number' ? conviction : 0

    for (const col of cols) {
      matrix[row][col][bucket] += 1
      convSums[row][col] += conv
      convCounts[row][col] += 1
    }
  }

  // Compute average conviction per cell
  for (const row of ROWS) {
    for (const col of COLS) {
      const count = convCounts[row][col]
      matrix[row][col].avgConv = count > 0
        ? Math.round((convSums[row][col] / count) * 10) / 10
        : 0
    }
  }

  return matrix
}
