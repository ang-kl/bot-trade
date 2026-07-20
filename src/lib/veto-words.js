// Risk-veto reasons in TRADER words. The agent stores machine-readable
// codes ("sl_too_tight 0.038%<0.15%"); a Chief Trading Officer reading the
// desk should see "Stop too tight — 0.038% vs 0.15% min". The raw code
// stays available for tooltips/debugging.

// Short-form absolute stamp HH:MM dd/MM (owner: "include reference to
// short-form HH:MM dd/MM") from a stored ISO/SQLite datetime. Falls back to
// null on unparseable input so callers can omit it.
function shortStamp(raw) {
  if (!raw || raw === 'na') return null
  const ms = Date.parse(String(raw).includes('T') ? raw : String(raw).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}`
}

function relAge(raw) {
  const ms = Date.parse(String(raw).includes('T') ? raw : String(raw).replace(' ', 'T') + 'Z')
  if (!Number.isFinite(ms)) return null
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
  return mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.round(mins / 60)}h ago` : `${Math.round(mins / 1440)}d ago`
}

// Strategy code → short label, mirroring the desk's STRAT_SHORT.
const STRAT_LABEL = { fib_618_fade: 'FIB', cup_handle: 'C&H', ema_pullback: 'EMA', donchian_breakout: 'BRK', rsi_meanrev: 'RSI' }

const RULES = [
  // Detail groups are OPTIONAL so bare family keys (from the veto-breakdown
  // endpoint) translate too — "sl_too_tight" alone still reads as words.
  { re: /^sl_too_tight(?:\s+([\d.]+%)<([\d.]+%))?/, out: (m) => m[1] ? `Stop too tight — ${m[1]} vs ${m[2]} min` : 'Stop too tight' },
  {
    re: /^duplicate_symbol(?:\s+existing_side=(\w+))?(?:\s+entry=([\w.]+))?(?:\s+opened=(\S+))?(?:\s+strat=(\w+))?(?:\s+lastcheck=(\S+))?/,
    out: (m) => {
      if (!m[1]) return 'Already in this symbol'
      // Full audit line (owner: "show evidence of your veto"): which
      // strategy opened the blocking position, at what price, when
      // (absolute HH:MM dd/MM + relative), and when it was last monitored.
      const strat = m[4] && m[4] !== 'na' ? (STRAT_LABEL[m[4]] || m[4].toUpperCase()) : null
      const parts = [`Already ${m[1]}${strat ? ` (${strat})` : ''}`]
      if (m[2] && m[2] !== 'na') parts.push(`@ ${m[2]}`)
      const openStamp = shortStamp(m[3])
      if (openStamp) parts.push(`opened ${openStamp} (${relAge(m[3])})`)
      const checkAge = m[5] && m[5] !== 'na' ? relAge(m[5]) : null
      if (checkAge) parts.push(`· last checked ${checkAge}`)
      parts.push('— one position per symbol')
      return parts.join(' ')
    },
  },
  { re: /^max_positions(?:=(\d+)\/(\d+))?/, out: (m) => m[1] ? `Position cap reached (${m[1]}/${m[2]})` : 'Position cap reached' },
  { re: /^loss_streak_cooldown(?:\s+streak=(\d+)\s+wait=(\w+))?/, out: (m) => m[1] ? `Cooling off after ${m[1]} straight losses — ${m[2]} left` : 'Loss-streak cooldown' },
  { re: /^symbol_cooldown(?:\s+wait=(\w+))?/, out: (m) => m[1] ? `Re-entry cooldown — ${m[1]} left` : 'Re-entry cooldown' },
  { re: /^below_min_volume/, out: () => 'Sized below the broker minimum lot' },
  { re: /^symbol_blocked/, out: () => 'Symbol blocked by owner' },
  {
    re: /^regime_block\s+([\w-]+)/,
    out: (m) => {
      const K = {
        'meanrev-in-volatile': 'Skipped — fade strategy in a whipsaw (volatile regime)',
        'fade-vs-trend': 'Skipped — would fade a live trend',
        'trend-in-quiet': 'Skipped — trend strategy with no trend (quiet regime)',
      }
      return K[m[1]] || 'Skipped — wrong market regime for this strategy'
    },
  },
  { re: /^missing_entry_or_sl/, out: () => 'Signal missing entry or stop' },
  { re: /^sl_at_entry/, out: () => 'Stop equals entry — no risk distance' },
  { re: /^bad_rr(?:\s+([\d.]+)<([\d.]+))?/, out: (m) => m[1] ? `Reward:risk ${m[1]} below the ${m[2]} floor` : 'Reward:risk below the floor' },
  { re: /^overexposed_(\w+)/, out: (m) => `Currency exposure cap hit (${m[1]})` },
  {
    // Live-computed matrix: correlated_live=N thr=0.7 with=SYM@0.82|SYM2@0.75
    re: /^correlated_live=(\d+)\s+thr=([\d.]+)(?:\s+with=(\S+))?/,
    out: (m) => {
      const withList = m[3] ? m[3].split('|').map(s => s.replace('@', ' ')).join(', ') : null
      return `Too correlated (live) — already holding ${m[1]} highly-correlated position${m[1] === '1' ? '' : 's'} (≥${m[2]})${withList ? `: ${withList}` : ''}`
    },
  },
  {
    re: /^correlated_(\w+)=(-?\d+)\s+cap=(\d+)(?:\s+with=(\S+))?/,
    out: (m) => {
      const CLUSTER = { usd_strength: 'USD strength', us_equity: 'US equity', crude: 'crude oil', risk_fx: 'risk-on FX' }
      const withList = m[4] && m[4] !== 'none' ? m[4].split('|').join(', ') : null
      return `Too correlated — would stack the ${CLUSTER[m[1]] || m[1]} cluster (net ${m[2]} vs cap ${m[3]})${withList ? `, already holding ${withList}` : ''}`
    },
  },
  { re: /^insufficient_equity/, out: () => 'Sized below the broker minimum lot' },
  { re: /^negative_expectancy/, out: () => 'Negative expectancy — Kelly says no' },
  { re: /^daily_loss_limit_hit/, out: () => 'Daily loss limit hit' },
  { re: /^market_closed/, out: () => 'Market closed' },
  { re: /^no_live_quote/, out: () => 'No live quote from the broker' },
  { re: /^spread/, out: () => 'Spread too wide vs the stop' },
  { re: /^order_failed:?\s*(.*)/, out: (m) => `Broker rejected the order${m[1] ? ` — ${m[1]}` : ''}` },
  { re: /^sizing_failed:?\s*(.*)/, out: (m) => `Sizing failed${m[1] ? ` — ${m[1]}` : ''}` },
  { re: /^pending_invalidated/, out: () => 'Pending setup invalidated by price' },
  { re: /^pending_order_failed:?\s*(.*)/, out: (m) => `Pending order failed${m[1] ? ` — ${m[1]}` : ''}` },
]

/** Machine veto code → trader words. Unknown codes just lose underscores. */
export function humanVeto(reason) {
  const r = String(reason || '').trim()
  if (!r) return ''
  for (const rule of RULES) {
    const m = r.match(rule.re)
    if (m) return rule.out(m)
  }
  return r.replace(/_/g, ' ')
}
