// ---------------------------------------------------------------------------
// agent/quant/signals.js — Signal tracking and flip detection
// ---------------------------------------------------------------------------

/**
 * Compare current bias against the last recorded signal for a symbol.
 * If the bias changed (e.g. long→short, neutral→long), record a flip.
 * Always inserts a new signal row into the `signals` table.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} symbol
 * @param {string} currentBias   — 'long' | 'short' | 'neutral'
 * @param {number} currentConfidence
 * @param {string} source        — originator label (e.g. 'scanner', 'analyst')
 * @returns {{ flipped: boolean, flipFrom: string|null, flipTo: string|null }}
 */
export function detectFlip(db, symbol, currentBias, currentConfidence, source) {
  const lastSignal = db
    .prepare(
      `SELECT bias FROM signals
       WHERE symbol = ?
       ORDER BY recorded_at DESC
       LIMIT 1`,
    )
    .get(symbol);

  const prevBias = lastSignal ? lastSignal.bias : null;
  const flipped = prevBias !== null && prevBias !== currentBias;

  const insert = db.prepare(
    `INSERT INTO signals (symbol, bias, confidence, prev_bias, flipped, flip_from, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  insert.run(
    symbol,
    currentBias,
    currentConfidence,
    prevBias,
    flipped ? 1 : 0,
    flipped ? prevBias : null,
    source,
  );

  return {
    flipped,
    flipFrom: flipped ? prevBias : null,
    flipTo: flipped ? currentBias : null,
  };
}

/**
 * Return recent signals for a symbol, ordered newest-first,
 * limited to the last `days` calendar days.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} symbol
 * @param {number} days
 * @returns {Array<Object>}
 */
export function getSignalHistory(db, symbol, days) {
  return db
    .prepare(
      `SELECT * FROM signals
       WHERE symbol = ?
         AND recorded_at >= datetime('now', ? || ' days')
       ORDER BY recorded_at DESC`,
    )
    .all(symbol, -Math.abs(days));
}

/**
 * Count the number of signal flips for a symbol in the last N hours.
 * A high flip count indicates noisy / unreliable signals.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} symbol
 * @param {number} hours
 * @returns {number}
 */
export function getFlipCount(db, symbol, hours) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM signals
       WHERE symbol = ?
         AND flipped = 1
         AND recorded_at >= datetime('now', ? || ' hours')`,
    )
    .get(symbol, -Math.abs(hours));

  return row ? row.cnt : 0;
}
