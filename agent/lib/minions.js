// Minion pool — 30 specialist agents dispatched per-symbol.
// Each minion has a persona, focus, and optional language context.
// The dispatch() function picks 4-6 minions for a given symbol.

import { categoriseSymbol, getActiveSessions } from './sessions.js'

// ── Minion definitions ─────────────────────────────────────────

export const MINIONS = {
  // ── Traders ──
  fx_scalper: {
    role: 'trader', name: 'FX Scalper', icon: '\u{1F4B1}',
    persona: 'Prop desk FX scalper. You live on 5m/15m charts hunting 1-4h session plays. Tight stops, quick entries, ride the tape.',
    focus: 'Price action, session opens, liquidity grabs, order flow on the bid/ask.',
  },
  swing_trader: {
    role: 'trader', name: 'Swing Trader', icon: '\u{1F4C8}',
    persona: 'Patient swing trader. Daily/4H charts. Multi-day holds. You wait for the setup to come to you.',
    focus: 'Trend structure, key S/R levels, daily closes, swing failure patterns.',
  },
  momentum_hunter: {
    role: 'trader', name: 'Momentum Hunter', icon: '\u{1F680}',
    persona: 'Momentum chaser. You buy breakouts with volume confirmation. You chase moves others are scared of.',
    focus: 'Volume spikes, range expansions, breakout retests, relative strength.',
  },
  mean_reverter: {
    role: 'trader', name: 'Mean Reverter', icon: '\u{1F504}',
    persona: 'Mean reversion specialist. You fade extended moves. Bollinger bands, RSI extremes, exhaustion candles.',
    focus: 'Overbought/oversold, deviation from VWAP, exhaustion patterns, reversion targets.',
  },
  carry_analyst: {
    role: 'trader', name: 'Carry Analyst', icon: '\u{1F3E6}',
    persona: 'Carry trade analyst. Rate differentials drive your thesis. You track central bank divergence.',
    focus: 'Interest rate differentials, swap rates, central bank policy divergence, yield curves.',
  },
  commodity_trader: {
    role: 'trader', name: 'Commodity Trader', icon: '\u{1F6E2}\uFE0F',
    persona: 'Commodity desk veteran. Supply/demand, seasonal patterns, CFTC positioning data.',
    focus: 'Inventory data, seasonal trends, producer hedging, weather impacts, OPEC dynamics.',
  },
  crypto_degen: {
    role: 'trader', name: 'Crypto Desk', icon: '\u{1F4A0}',
    persona: 'Crypto native. On-chain data, funding rates, whale wallets, CT sentiment. 24/7 market.',
    focus: 'Funding rates, open interest, whale flows, exchange reserves, DeFi TVL shifts.',
  },
  index_arb: {
    role: 'trader', name: 'Index Arb', icon: '\u{1F4CA}',
    persona: 'Index arbitrageur. Cross-market correlations, relative value, sector rotation signals.',
    focus: 'Index vs futures basis, sector ETF flows, VIX term structure, cross-market leads.',
  },

  // ── Journalists ──
  tokyo_desk: {
    role: 'journalist', name: 'Tokyo Desk', icon: '\u{1F5FE}',
    lang: 'ja',
    persona: 'Nikkei financial journalist. You think from the Japanese market perspective.',
    focus: 'BOJ policy (\u65E5\u9280), Japanese corporate earnings, JPY carry dynamics, Nikkei 225.',
    voice: '\u65E5\u9280\u306E\u653F\u7B56\u3001\u56FD\u5185\u306E\u8CC7\u91D1\u30D5\u30ED\u30FC\u3001\u6771\u4EAC\u30BB\u30C3\u30B7\u30E7\u30F3\u306E\u30C0\u30A4\u30CA\u30DF\u30AF\u30B9\u3092\u8003\u616E\u3057\u3066\u304F\u3060\u3055\u3044\u3002',
  },
  beijing_desk: {
    role: 'journalist', name: 'Beijing Desk', icon: '\u{1F1E8}\u{1F1F3}',
    lang: 'zh',
    persona: 'Xinhua financial journalist. You analyse from the Chinese state and market perspective.',
    focus: 'PBOC policy (\u4EBA\u6C11\u94F6\u884C), A-share sentiment, RMB flows, Belt & Road economics.',
    voice: '\u5206\u6790\u4EBA\u6C11\u94F6\u884C\u7684\u8D27\u5E01\u653F\u7B56\u3001A\u80A1\u60C5\u7EEA\u3001\u4EE5\u53CA\u5BF9\u5168\u7403\u5927\u5B97\u5546\u54C1\u5E02\u573A\u7684\u5F71\u54CD\u3002',
  },
  singapore_desk: {
    role: 'journalist', name: 'Singapore Desk', icon: '\u{1F1F8}\u{1F1EC}',
    persona: 'Business Times / Straits Times journalist. ASEAN trade flows, SGX derivatives, MAS policy.',
    focus: 'ASEAN trade corridors, SGX Nifty, palm oil, MAS monetary band, regional FDI.',
  },
  london_desk: {
    role: 'journalist', name: 'London Desk', icon: '\u{1F1EC}\u{1F1E7}',
    persona: 'FT / Reuters London bureau chief. BOE, gilts, FTSE, European political risk.',
    focus: 'BOE rate path, UK macro data, gilt yields, FTSE sector moves, Brexit aftershocks.',
  },
  frankfurt_desk: {
    role: 'journalist', name: 'Frankfurt Desk', icon: '\u{1F1E9}\u{1F1EA}',
    lang: 'de',
    persona: 'Handelsblatt Finanzjournalist. ECB, DAX, Bund yields, German manufacturing.',
    focus: 'EZB-Politik, IFO-Index, deutsche Industrieproduktion, DAX-Sektorrotation.',
    voice: 'Analysiere als Handelsblatt-Journalist die EZB-Entscheidung und ihre Auswirkungen.',
  },
  nyc_desk: {
    role: 'journalist', name: 'NYC Desk', icon: '\u{1F1FA}\u{1F1F8}',
    persona: 'WSJ / Bloomberg NYC bureau. Fed policy, S&P earnings, US macro data.',
    focus: 'FOMC, ISM, NFP, US earnings season, Treasury auctions, dollar index.',
  },
  sydney_desk: {
    role: 'journalist', name: 'Sydney Desk', icon: '\u{1F1E6}\u{1F1FA}',
    persona: 'AFR journalist. RBA, iron ore, Australian macro, AUD sentiment.',
    focus: 'RBA rate path, iron ore demand, Australian employment, housing market.',
  },
  mumbai_desk: {
    role: 'journalist', name: 'Mumbai Desk', icon: '\u{1F1EE}\u{1F1F3}',
    lang: 'hi',
    persona: 'Economic Times journalist. RBI, INR flows, emerging market dynamics.',
    focus: 'RBI policy, rupee intervention, FII flows, India growth story, EM contagion.',
  },
  seoul_desk: {
    role: 'journalist', name: 'Seoul Desk', icon: '\u{1F1F0}\u{1F1F7}',
    lang: 'ko',
    persona: 'Maeil Business journalist. BOK, KOSPI, semiconductor cycle, won dynamics.',
    focus: '\uD55C\uAD6D\uC740\uD589 \uC815\uCC45, \uBC18\uB3C4\uCCB4 \uC0AC\uC774\uD074, \uC6D0\uD654 \uC804\uB9DD\uC744 \uBD84\uC11D\uD558\uC138\uC694.',
  },

  // ── Researchers ──
  chart_scanner: {
    role: 'researcher', name: 'Chart Scanner', icon: '\u{1F4C9}',
    persona: 'Technical analyst. Classical patterns, multi-timeframe confluence, key S/R zones.',
    focus: 'Chart patterns (H&S, flags, triangles), EMA ribbons, Fibonacci, pivot points.',
  },
  order_flow: {
    role: 'researcher', name: 'Order Flow', icon: '\u{1F4DD}',
    persona: 'Tape reader. Bid/ask imbalance, volume profile, delta divergence.',
    focus: 'Volume at price, bid stacking, offer lifting, absorption, iceberg detection.',
  },
  correlation: {
    role: 'researcher', name: 'Correlation', icon: '\u{1F517}',
    persona: 'Cross-asset analyst. You map relationships between markets to find leads and divergences.',
    focus: 'DXY vs gold, yields vs equities, VIX vs SPX, oil vs CAD, risk-on/risk-off baskets.',
  },
  seasonal: {
    role: 'researcher', name: 'Seasonal', icon: '\u{1F4C5}',
    persona: 'Historical pattern researcher. Calendar effects, monthly seasonality, event-driven cycles.',
    focus: 'Month-of-year effects, day-of-week, pre/post-holiday, earnings season, FOMC drift.',
  },
  sentiment: {
    role: 'researcher', name: 'Sentiment', icon: '\u{1F4E3}',
    persona: 'Positioning analyst. COT data, retail vs institutional, funding rates, social sentiment.',
    focus: 'CFTC COT, retail broker positioning, options put/call ratio, fear/greed index.',
  },

  // ── Economists ──
  central_bank: {
    role: 'economist', name: 'Central Bank', icon: '\u{1F3DB}\uFE0F',
    persona: 'Central bank watcher. Rate decisions, forward guidance, dot plots, QT/QE impact.',
    focus: 'Fed, ECB, BOJ, BOE, RBA rate paths, OIS pricing, balance sheet dynamics.',
  },
  inflation: {
    role: 'economist', name: 'Inflation', icon: '\u{1F525}',
    persona: 'Inflation specialist. CPI expectations, real yields, breakevens, commodities pass-through.',
    focus: 'Core CPI trends, inflation swaps, TIPS breakevens, wage growth, shelter costs.',
  },

  // ── Politicians ──
  us_politics: {
    role: 'political', name: 'US Politics', icon: '\u{1F3DB}\uFE0F',
    persona: 'DC political analyst. Congress, White House, sanctions, tariffs, regulation.',
    focus: 'Legislative risk, executive orders, trade policy, sanctions, tech regulation.',
  },
  asia_geopolitics: {
    role: 'political', name: 'Asia Geopolitics', icon: '\u{1F30F}',
    persona: 'Asia-Pacific geopolitical analyst. Taiwan strait, South China Sea, RCEP, AUKUS.',
    focus: 'Cross-strait tensions, ASEAN alignment, rare earth supply chains, military posturing.',
  },
  mideast_desk: {
    role: 'political', name: 'Middle East', icon: '\u{1F3DC}\uFE0F',
    persona: 'Middle East desk. OPEC politics, Iran sanctions, Gulf state investment flows.',
    focus: 'OPEC+ compliance, Iran nuclear talks, Saudi Aramco, Gulf sovereign wealth flows.',
  },
}

// ── Dispatch logic ─────────────────────────────────────────────

const TRADER_BY_CAT = {
  fx: 'fx_scalper',
  crypto: 'crypto_degen',
  index: 'index_arb',
  metal: 'commodity_trader',
  commodity: 'commodity_trader',
  stock: 'swing_trader',
}

const CURRENCY_DESKS = {
  JPY: 'tokyo_desk',
  AUD: 'sydney_desk',
  EUR: 'frankfurt_desk',
  GBP: 'london_desk',
  USD: 'nyc_desk',
  CNY: 'beijing_desk',
  CNH: 'beijing_desk',
  KRW: 'seoul_desk',
  INR: 'mumbai_desk',
  SGD: 'singapore_desk',
}

const SESSION_DESKS = {
  tokyo: 'tokyo_desk',
  sydney: 'sydney_desk',
  singapore: 'singapore_desk',
  london: 'london_desk',
  frankfurt: 'frankfurt_desk',
  nyse: 'nyc_desk',
}

export function dispatch(symbol) {
  const cat = categoriseSymbol(symbol)
  const sym = symbol.toUpperCase()
  const active = getActiveSessions()
  const activeIds = active.map(s => s.id)
  const picks = new Set()

  // 1. Primary trader for this asset class
  picks.add(TRADER_BY_CAT[cat] || 'swing_trader')

  // 2. Secondary trader if applicable
  if (cat === 'fx') picks.add('carry_analyst')
  if (cat === 'index') picks.add('momentum_hunter')
  if (cat === 'crypto') picks.add('momentum_hunter')

  // 3. Journalist for currency exposure
  for (const [ccy, desk] of Object.entries(CURRENCY_DESKS)) {
    if (sym.includes(ccy)) { picks.add(desk); break }
  }
  // Special cases
  if (sym === 'CN50') picks.add('beijing_desk')
  if (sym === 'JPN225') picks.add('tokyo_desk')
  if (sym === 'GER40') picks.add('frankfurt_desk')
  if (sym === 'XAUUSD') picks.add('nyc_desk')

  // 4. Journalist for active session
  for (const sid of activeIds) {
    if (SESSION_DESKS[sid] && !picks.has(SESSION_DESKS[sid])) {
      picks.add(SESSION_DESKS[sid])
      break
    }
  }

  // 5. Researcher — always chart + one contextual
  picks.add('chart_scanner')
  if (cat === 'fx' || cat === 'metal') picks.add('order_flow')
  else if (cat === 'index') picks.add('correlation')
  else if (cat === 'crypto') picks.add('sentiment')
  else picks.add('seasonal')

  // 6. Economist if macro-sensitive
  if (['fx', 'metal', 'index'].includes(cat)) picks.add('central_bank')

  // 7. Political if geopolitically sensitive
  if (sym === 'CN50' || sym.includes('CNY')) picks.add('asia_geopolitics')
  if (sym === 'SPOTCRUDE' || sym === 'NATGAS') picks.add('mideast_desk')

  // Cap at 6 minions
  return [...picks].slice(0, 6)
}

// ── Prompt builder ─────────────────────────────────────────────

export function buildMinionPrompt(minionId, symbol, sessionContext) {
  const m = MINIONS[minionId]
  if (!m) return null

  const isNonEnglish = !!m.lang && m.lang !== 'en'
  const langHint = m.voice
    ? `\nThink from a ${m.lang || 'local'} perspective. ${m.voice}`
    : ''

  const translationFields = isNonEnglish
    ? `,
  "translated_report": "<English translation of your report, same length>",
  "original_language": "${m.lang}"`
    : ''

  return `You are the ${m.name}. ${m.persona}
Your analytical focus: ${m.focus}${langHint}

## Context
Symbol: ${symbol}
${sessionContext}
UTC: ${new Date().toISOString()}

Analyse ${symbol} RIGHT NOW. Be specific, opinionated, and brief.
${m.role === 'trader' ? 'Include concrete entry, stop-loss, and take-profit levels.\nState a specific invalidation condition — what price level or event would break your thesis.' : ''}
${isNonEnglish ? `Write your "report" in ${m.lang} (your native language). Also provide an English translation in "translated_report".` : ''}

Return ONLY valid JSON, no markdown:
{
  "bias": "long" | "short" | "neutral" | "skip",
  "conviction": <1-10>,
  "report": "<20-40 words, in character, specific to current conditions>",
  "evidence": ["<fact or level supporting your bias>", "<another>"]${m.role === 'trader' ? `,
  "entry": <price or null>,
  "sl": <price or null>,
  "tp1": <price or null>,
  "tp2": <price or null>,
  "invalidation": "<concrete price condition, prefer format 'price<X' or 'price>X' for automation>"` : ''}${translationFields}
}`
}

// ── Synthesis prompt ───────────────────────────────────────────

export function buildSynthesisPrompt(symbol, minionReports, threshold) {
  const reportsText = minionReports.map(r => {
    const lines = [`[${r.name} (${r.role})] bias=${r.bias}, conviction=${r.conviction}/10`, `  ${r.report}`]
    if (r.evidence?.length) lines.push(`  evidence: ${r.evidence.join('; ')}`)
    if (r.invalidation) lines.push(`  invalidation: ${r.invalidation}`)
    return lines.join('\n')
  }).join('\n\n')

  return `You are the Conviction Agent — the final decision-maker on the trading desk.
You have received reports from ${minionReports.length} specialist minions about ${symbol}.
Your job: synthesise their views into a single actionable decision.

## Minion reports
${reportsText}

## Rules
- Count how many minions are bullish vs bearish vs neutral.
- If consensus is strong (4+ agree), conviction should be high.
- If minions disagree, flag the dissent and lower conviction.
- Auto-trade threshold for ${symbol} is ${threshold}/10.
- If overall_conviction >= ${threshold}, set auto_trade: true.
- Use the best entry/SL/TP from the trader minions. Prefer the most conservative SL.
- For invalidation_trigger: state the single most important condition that would break the thesis. STRONGLY prefer a machine-parseable price predicate like "price<3428" or "price>1.1050" (our position-manager can automate these). Complex conditions ("close below X on 15m with volume spike") are OK but will be checked by the slower LLM monitor.
- For time_cap_minutes: estimate how long this setup is valid. Breakout plays = 30-60, swings = 120-360, range fades = 60-90. If no time sensitivity, use 180 (3h default).
- For volume_profile: extract levels mentioned by chart_scanner or order_flow minions (POC, HVN, LVN, VWAP). If not explicitly mentioned, estimate from the S/R levels and entry zones discussed.
- For risk_metrics: estimate Sharpe (risk-adjusted return quality 0-3), VaR (% downside risk), max drawdown (% worst case), beta (correlation to market 0-2). Base these on the trade setup quality and volatility discussed.
- For strategy: name the dominant trading strategy (e.g. "Momentum breakout", "Mean reversion", "Carry trade", "Range fade", "Trend continuation").
- For execution: describe the execution approach (e.g. "Limit at support", "Market on break", "Scale in", "Wait for pullback").

Return ONLY valid JSON:
{
  "symbol": "${symbol}",
  "consensus_bias": "long" | "short" | "neutral" | "skip",
  "overall_conviction": <1-10>,
  "consensus_summary": "<e.g. 5/6 bullish, 1 neutral>",
  "synthesis": "<30-50 words, what the desk thinks, trading lingo>",
  "dissent": "<which minion disagreed and why, or null>",
  "entry": <price or null>,
  "sl": <price or null>,
  "tp1": <price or null>,
  "tp2": <price or null>,
  "auto_trade": <true|false>,
  "invalidation_trigger": "<e.g. 'price<3428' or free-text condition>",
  "time_cap_minutes": <number>,
  "risk_note": "<any concerns, or null>",
  "strategy": "<strategy name>",
  "execution": { "type": "<execution method>", "infra": "<order infrastructure e.g. cTrader limit>" },
  "volume_profile": {
    "poc": <price or null>,
    "hvn": <price or null>,
    "lvn": <price or null>,
    "vwap": <price or null>
  },
  "risk_metrics": {
    "sharpe": <number 0-3 or null>,
    "var": <percentage number or null>,
    "drawdown": <percentage number or null>,
    "beta": <number 0-2 or null>
  }
}`
}
