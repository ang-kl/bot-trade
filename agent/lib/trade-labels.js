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
