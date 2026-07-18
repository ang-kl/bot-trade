// Risk-veto reasons in TRADER words. The agent stores machine-readable
// codes ("sl_too_tight 0.038%<0.15%"); a Chief Trading Officer reading the
// desk should see "Stop too tight — 0.038% vs 0.15% min". The raw code
// stays available for tooltips/debugging.

const RULES = [
  // Detail groups are OPTIONAL so bare family keys (from the veto-breakdown
  // endpoint) translate too — "sl_too_tight" alone still reads as words.
  { re: /^sl_too_tight(?:\s+([\d.]+%)<([\d.]+%))?/, out: (m) => m[1] ? `Stop too tight — ${m[1]} vs ${m[2]} min` : 'Stop too tight' },
  { re: /^duplicate_symbol(?:\s+existing_side=(\w+))?/, out: (m) => m[1] ? `Already ${m[1]} — one position per symbol` : 'Already in this symbol' },
  { re: /^max_positions(?:=(\d+)\/(\d+))?/, out: (m) => m[1] ? `Position cap reached (${m[1]}/${m[2]})` : 'Position cap reached' },
  { re: /^loss_streak_cooldown(?:\s+streak=(\d+)\s+wait=(\w+))?/, out: (m) => m[1] ? `Cooling off after ${m[1]} straight losses — ${m[2]} left` : 'Loss-streak cooldown' },
  { re: /^symbol_cooldown(?:\s+wait=(\w+))?/, out: (m) => m[1] ? `Re-entry cooldown — ${m[1]} left` : 'Re-entry cooldown' },
  { re: /^below_min_volume/, out: () => 'Sized below the broker minimum lot' },
  { re: /^symbol_blocked/, out: () => 'Symbol blocked by owner' },
  { re: /^missing_entry_or_sl/, out: () => 'Signal missing entry or stop' },
  { re: /^sl_at_entry/, out: () => 'Stop equals entry — no risk distance' },
  { re: /^bad_rr(?:\s+([\d.]+)<([\d.]+))?/, out: (m) => m[1] ? `Reward:risk ${m[1]} below the ${m[2]} floor` : 'Reward:risk below the floor' },
  { re: /^overexposed_(\w+)/, out: (m) => `Currency exposure cap hit (${m[1]})` },
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
