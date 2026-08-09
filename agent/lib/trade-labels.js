// ---------------------------------------------------------------------------
// agent/lib/trade-labels.js — structured cTrader label encoder/parser
// ---------------------------------------------------------------------------
// cTrader's `label` field is a free-form string (~100 chars) visible in the
// native cTrader desktop/web/mobile client and returned in RECONCILE_RES.
// We pack attribution metadata into a pipe-delimited format so every trade
// carries its own provenance tag at the broker level.
//
// Format: SOURCE|VERSION|STRATEGY|CONVICTION|SESSION|TF|REGIME
//
// Example: AP|v1|TREND|HI|LDN|H1|REGT
//   → autopilot v1, trend strategy, high conviction, London session, 1h
//     timeframe, trending regime at open.
//
// Unknown / missing components are encoded as "-". Parsing is forgiving:
// anything that doesn't match the vocabulary maps to null (not an error),
// so legacy labels like "abot-auto" still round-trip cleanly.
// ---------------------------------------------------------------------------

export const LABEL_VERSION = 'v1'
export const MAX_LABEL_LEN = 90 // cTrader accepts up to 100 — stay safe.

export const SOURCES = {
  autopilot: 'AP',
  copilot:   'CP',
  manual:    'MAN', // placed directly in cTrader native, imported via reconcile
  // A RESTING LIMIT PLACED BEFORE THE OPEN IS NOT AN INTRADAY ENTRY, and until
  // 09-08-2026 the ledger could not tell them apart: closed-market-limits.js
  // stamped `autopilot` on its label, so once the order filled the reconciler
  // adopted it as an ordinary autopilot trade and its P&L blended into the
  // intraday numbers.
  //
  // They are different bets. An intraday entry is computed on live structure;
  // a pre-open limit is computed on the PREVIOUS session's close — loop.js's
  // own "Friday's stale close dressed up as a signal". Blending them means the
  // profit factor the go-live gate reads is an average of two strategies, and
  // neither one can be judged. Separating the label is what makes the pre-open
  // window (added the same day) measurable instead of merely enabled.
  preopen:   'PRE',
}

export const STRATEGIES = {
  trend:      'TREND',
  meanrev:    'MR',
  breakout:   'BRKO',
  scalp:      'SCALP',
  swing:      'SWING',
  news:       'NEWS',
  reversal:   'REV',
  fib_618_fade: 'FIB',
  cup_handle: 'CUP',
  inv_cup_handle: 'ICUP',
  ema_pullback: 'EMA',
  donchian_breakout: 'DON',
  rsi_meanrev: 'RSIM',
  // Newer registry strategies — without these, encodeLabel wrote '-' for the
  // strategy segment, so their trades carried NO attribution at the broker and
  // any position rebuilt from the broker (adoption/reconcile) showed a blank
  // Strategy column (owner: "why missing Strategy column"). vp_value and
  // rsi2_reversion are the armed edge strategies, so this hit them hardest.
  vwap_trend: 'VWAP',
  vp_value: 'VP',
  rsi2_reversion: 'RSI2',
  fib_confluence: 'FIBC',
  other:      'OTH',
}

export const CONVICTION = {
  high:   'HI',
  medium: 'MD',
  low:    'LO',
}

export const REGIMES = {
  trending:  'REGT',
  ranging:   'REGR',
  volatile:  'REGV',
  quiet:     'REGQ',
}

export const SESSIONS = {
  Tokyo:     'TKY',
  Sydney:    'SYD',
  Singapore: 'SGP',
  London:    'LDN',
  Frankfurt: 'FRA',
  'New York': 'NYC',
  Asia:      'ASI',
  Europe:    'EUR',
  Off:       'OFF',
}

// Reverse lookups — case-insensitive via uppercase keys.
const REV_SOURCES    = invertUpper(SOURCES)
const REV_STRATEGIES = invertUpper(STRATEGIES)
const REV_CONVICTION = invertUpper(CONVICTION)
const REV_REGIMES    = invertUpper(REGIMES)
const REV_SESSIONS   = invertUpper(SESSIONS)

function invertUpper(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[String(v).toUpperCase()] = k
  return out
}

/**
 * Encode a structured label.
 *
 * @param {object} parts
 * @param {'autopilot'|'copilot'|'manual'} parts.source
 * @param {string} [parts.version]       — e.g. 'v1', 'v2'
 * @param {string} [parts.strategy]      — key of STRATEGIES
 * @param {string} [parts.conviction]    — key of CONVICTION
 * @param {string} [parts.session]       — human session name, key of SESSIONS
 * @param {string} [parts.timeframe]     — e.g. 'H1', 'H4', 'D1'
 * @param {string} [parts.regime]        — key of REGIMES
 * @returns {string} pipe-delimited label, never longer than MAX_LABEL_LEN
 */
export function encodeLabel(parts = {}) {
  const src = SOURCES[parts.source] || SOURCES.manual
  const ver = compact(parts.version || LABEL_VERSION)
  // Owner: "every trade must have a purpose for the edge" — an unrecognised
  // strategy key (a free-text LLM value that doesn't match the STRATEGIES
  // vocabulary, or a future registry key not yet added here) used to fall
  // all the way to '-', baking a PERMANENT blank into the broker label (the
  // exact bug that hit vp_value/rsi2_reversion before their keys existed).
  // Falling back to 'other' instead means every trade keeps at least SOME
  // real attribution — worst case it lands in the "other" bucket, not an
  // unrecoverable blank.
  const strat = STRATEGIES[parts.strategy] || (parts.strategy ? STRATEGIES.other : '-')
  const conv = CONVICTION[parts.conviction] || '-'
  const sess = SESSIONS[parts.session] || '-'
  const tf = compact(parts.timeframe || '-')
  const reg = REGIMES[parts.regime] || '-'
  const label = [src, ver, strat, conv, sess, tf, reg].join('|')
  return label.length > MAX_LABEL_LEN ? label.slice(0, MAX_LABEL_LEN) : label
}

/**
 * Parse a structured label back into its components.
 * Returns null for every unknown component — never throws.
 */
export function parseLabel(label) {
  const empty = {
    source: null, version: null, strategy: null, conviction: null,
    session: null, timeframe: null, regime: null, raw: label || null,
  }
  if (!label || typeof label !== 'string') return empty
  const parts = label.split('|').map(s => s.trim())
  const [src, ver, strat, conv, sess, tf, reg] = parts
  return {
    source:     REV_SOURCES[String(src || '').toUpperCase()] || null,
    version:    ver && ver !== '-' ? ver : null,
    strategy:   REV_STRATEGIES[String(strat || '').toUpperCase()] || null,
    conviction: REV_CONVICTION[String(conv || '').toUpperCase()] || null,
    session:    REV_SESSIONS[String(sess || '').toUpperCase()] || null,
    timeframe:  tf && tf !== '-' ? tf : null,
    regime:     REV_REGIMES[String(reg || '').toUpperCase()] || null,
    raw:        label,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ¶D·3 — HUMAN-READABLE DECODE
//
// The owner, on a NAS100 short that lost $1,013.08: "I don't know was strategy
// used." The trade carried a complete, correct label — AP|v1|FIB|HI|SYD|10m —
// which says autopilot v1, Fibonacci 61.8% Fade, high conviction, Sydney session,
// 10-minute timeframe. Every fact needed to answer the question was recorded
// and then shown as a code nobody can read at a glance.
//
// Attribution that requires decoding by hand is not attribution. parseLabel
// already returns the keys; this turns them into words, and — importantly —
// names what is MISSING rather than dropping it, so "regime not recorded" is
// visible instead of silently absent.
//
// Display names for registry strategies MIRROR STRATEGY_REGISTRY. This module
// cannot import strategies.js (that module pulls in every strategy
// implementation and this one is a leaf used by the browser too), so a test
// asserts the two agree and fails if either drifts.
// ─────────────────────────────────────────────────────────────────────────────

export const STRATEGY_DISPLAY = {
  // Mirrors of STRATEGY_REGISTRY names (agent/services/strategies.js).
  fib_618_fade: 'Fibonacci 61.8% Fade',
  cup_handle: 'Cup & Handle',
  inv_cup_handle: 'Inverted Cup & Handle',
  ema_pullback: 'EMA Trend-Pullback',
  donchian_breakout: 'Range Breakout',
  rsi_meanrev: 'RSI Mean-Reversion',
  vwap_trend: 'VWAP Trend',
  vp_value: 'Vol. Profile Value',
  rsi2_reversion: 'RSI 2 Reversion',
  fib_confluence: 'Fibonacci Confluence',
  // Free-text buckets that predate the registry — no registry entry to mirror.
  trend: 'Trend',
  meanrev: 'Mean reversion',
  breakout: 'Breakout',
  scalp: 'Scalp',
  swing: 'Swing',
  news: 'News',
  reversal: 'Reversal',
  other: 'Other (unrecognised strategy key)',
}

const SOURCE_DISPLAY = {
  autopilot: 'Autopilot',
  copilot: 'Copilot',
  manual: 'Placed by hand in cTrader',
}

const CONVICTION_DISPLAY = { high: 'high conviction', medium: 'medium conviction', low: 'low conviction' }
const REGIME_DISPLAY = {
  trending: 'trending market', ranging: 'ranging market',
  volatile: 'volatile market', quiet: 'quiet market',
}

/**
 * Turn a stored label into something a person can read.
 *
 * @returns {{raw:string|null, structured:boolean, text:string, fields:Array}}
 *   structured — true when the label is one of ours (pipe-delimited, source
 *                recognised). Free-text broker labels are reported as-is
 *                rather than being forced into a shape they never had.
 *   text       — one line, e.g. "Autopilot v1 · Fibonacci 61.8% Fade · high
 *                conviction · Sydney session · 10m timeframe · regime not
 *                recorded"
 *   fields     — [{ key, code, label, value, missing }] for table rendering
 */
export function describeLabel(label) {
  const raw = label == null || label === '' ? null : String(label)
  if (!raw) {
    return { raw: null, structured: false, text: 'no label recorded — this trade carries no attribution', fields: [] }
  }

  const p = parseLabel(raw)
  const codes = raw.split('|').map(s => s.trim())
  const code = (i) => (codes[i] && codes[i] !== '-' ? codes[i] : null)

  // Not one of ours: a hand-placed cTrader label, a legacy "abot-auto", a
  // "vpo:" tag. Say what it is instead of pretending to decode it.
  if (!p.source) {
    return {
      raw, structured: false,
      text: `unstructured label "${raw}" — not written by this bot's encoder`,
      fields: [{ key: 'raw', code: raw, label: 'Label', value: raw, missing: false }],
    }
  }

  const fields = [
    { key: 'source', code: code(0), label: 'Placed by', value: SOURCE_DISPLAY[p.source] || p.source },
    { key: 'version', code: code(1), label: 'Encoder', value: p.version },
    { key: 'strategy', code: code(2), label: 'Strategy', value: p.strategy ? (STRATEGY_DISPLAY[p.strategy] || p.strategy) : null },
    { key: 'conviction', code: code(3), label: 'Conviction', value: p.conviction ? CONVICTION_DISPLAY[p.conviction] : null },
    { key: 'session', code: code(4), label: 'Session', value: p.session },
    { key: 'timeframe', code: code(5), label: 'Timeframe', value: p.timeframe },
    { key: 'regime', code: code(6), label: 'Regime at entry', value: p.regime ? REGIME_DISPLAY[p.regime] : null },
  ].map(f => ({ ...f, missing: f.value == null }))

  // A code that is present but unrecognised is NOT the same as an absent one —
  // it means the vocabulary is out of date, which is a real defect to see.
  const say = (f, present, absent) => (f.value != null ? present(f.value) : (f.code ? `${f.label.toLowerCase()} "${f.code}" not recognised` : absent))
  const by = fields[0], ver = fields[1], strat = fields[2]
  const conv = fields[3], sess = fields[4], tf = fields[5], reg = fields[6]

  const text = [
    ver.value ? `${by.value} ${ver.value}` : by.value,
    say(strat, v => v, 'strategy not recorded'),
    say(conv, v => v, 'conviction not recorded'),
    say(sess, v => `${v} session`, 'session not recorded'),
    say(tf, v => `${v} timeframe`, 'timeframe not recorded'),
    say(reg, v => v, 'regime not recorded'),
  ].join(' · ')

  return { raw, structured: true, text, fields }
}

/**
 * Is this label one of ours (i.e. placed via autopilot or copilot)?
 * Returns true when the source field parses to a known value.
 */
export function isOurs(label) {
  const p = parseLabel(label)
  return p.source === 'autopilot' || p.source === 'copilot'
}

/**
 * Convenience — derive conviction bucket (HI/MD/LO) from a numeric score.
 * Analyst typically outputs 0-10; split by thirds. null/undefined → medium.
 */
export function convictionBucket(score) {
  if (score == null) return 'medium'
  const s = Number(score)
  if (!Number.isFinite(s)) return 'medium'
  if (s >= 7) return 'high'
  if (s >= 4) return 'medium'
  return 'low'
}

// Compact a free-form field — strip pipes and other delimiters, preserve case.
function compact(s) {
  return String(s).replace(/[^A-Za-z0-9.-]/g, '') || '-'
}
