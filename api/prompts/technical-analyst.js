// Technical analyst sub-agent prompt.
// Ported verbatim from v1 api/advisor.js L313-445.
// Every LLM call = its own file per HANDOVER-V2.md.

export default function technicalPrompt({ snapshots, globalSlice, perSymbolSlice, commoditySlice }) {
  // Macro regime line prepended to every technical prompt so every
  // signal is evaluated in the correct macro context.
  let macroLine = ''
  if (globalSlice?.macro?.regime) {
    const r = globalSlice.macro.regime
    const parts = [`regime=${r.regime}`]
    if (r.vix != null) parts.push(`VIX ${r.vix.toFixed(1)}`)
    if (r.dxy != null) parts.push(`DXY ${r.dxy.toFixed(1)}`)
    if (r.yieldCurve != null) parts.push(`2s10s ${r.yieldCurve.toFixed(2)}`)
    if (r.creditSpread != null) parts.push(`HY spread ${r.creditSpread.toFixed(2)}`)
    macroLine = `\nMacro regime (server-computed, every symbol trades in this context):\n  ${parts.join(' | ')}\n`
  }
  // Upcoming economic calendar events in the next 14 days that touch
  // high-importance categories. Inlined so the analyst can suggest
  // "wait for CPI" or "avoid FOMC week" in the thesis field.
  let calendarLine = ''
  if (globalSlice?.calendar?.events?.length) {
    const important = globalSlice.calendar.events
      .filter(e => (e.impact || '').toLowerCase() === 'high' || e.importance >= 2)
      .slice(0, 8)
    if (important.length > 0) {
      const items = important.map(e => `${e.time || e.date || ''} ${e.country || ''} ${e.event || ''}`).join('; ')
      calendarLine = `\nHigh-impact economic events next 14d: ${items}\n`
    }
  }

  const lines = (snapshots || []).map(s => {
    const ema = s.h1Ema
      ? `EMA9=${s.h1Ema.ema9} EMA20=${s.h1Ema.ema20} EMA43=${s.h1Ema.ema43} EMA89=${s.h1Ema.ema89} EMA120=${s.h1Ema.ema120}`
      : 'EMA=(insufficient h1 bars)'
    const vwap = s.h1Vwap != null ? `VWAP=${s.h1Vwap} (${s.priceVsVwap})` : 'VWAP=n/a'
    const stack = s.emaStack ? `stack=${s.emaStack}` : ''
    const vp = s.volumeProfile
      ? `POC=${s.volumeProfile.poc} VAL=${s.volumeProfile.valueAreaLow} VAH=${s.volumeProfile.valueAreaHigh} HVN=[${s.volumeProfile.hvn.join(',')}] LVN=[${s.volumeProfile.lvn.join(',')}]`
      : 'VP=n/a'
    const cvd = s.cvd ? `CVD=${s.cvd.latest} slope=${s.cvd.slopePerBar}` : 'CVD=n/a'
    const hist = s.historical
      ? `2Q: return=${s.historical.returnPct}% dd=${s.historical.maxDrawdownPct}% regime=${s.historical.regime} hi=${s.historical.high} lo=${s.historical.low}`
      : '2Q=(insufficient d1 bars)'

    // Per-symbol enrichment from the data-layers cache. Adds earnings /
    // sentiment / recs for stocks; energy / weather / crops context
    // for commodities; nothing for fx or crypto.
    const slice = (perSymbolSlice || {})[s.symbol]
    const enrichLines = []
    if (slice?.earnings) {
      const e = slice.earnings
      const dt = e.nextEarningsDate || '-'
      const dUntil = e.daysUntilEarnings != null ? `${e.daysUntilEarnings}d` : '-'
      const surp = e.avgAbsSurprisePct != null ? `${e.avgAbsSurprisePct.toFixed(1)}%` : '-'
      enrichLines.push(`earnings: next ${dt} (${dUntil}), avg abs surprise ${surp}`)
    }
    if (slice?.sentiment?.avgScore != null) {
      enrichLines.push(`sentiment: ${slice.sentiment.label} (${slice.sentiment.avgScore.toFixed(2)}) from ${slice.sentiment.articleCount} articles`)
    }
    if (slice?.recs) {
      const r = slice.recs
      const total = (r.strongBuy || 0) + (r.buy || 0) + (r.hold || 0) + (r.sell || 0) + (r.strongSell || 0)
      if (total > 0) enrichLines.push(`analyst recs: SB${r.strongBuy || 0} B${r.buy || 0} H${r.hold || 0} S${r.sell || 0} SS${r.strongSell || 0}`)
    }
    const enrichBlock = enrichLines.length > 0 ? `\n  ${enrichLines.join('\n  ')}` : ''

    return `${s.symbol} @ ${s.currentPrice}
  ${ema} ${stack}
  ${vwap}
  ${vp}
  ${cvd}
  ${hist}${enrichBlock}`
  }).join('\n\n') || '(no snapshots supplied)'

  // Commodity-wide context block: EIA energy inventories, NOAA/open-meteo
  // weather events, USDA crop conditions. Inlined once so the analyst can
  // cite them across multiple commodity symbols in a single pass.
  let commodityBlock = ''
  if (commoditySlice) {
    const sections = []
    const energySeries = commoditySlice.energy?.series || []
    if (energySeries.length > 0) {
      const items = energySeries.map(e => {
        const wow = e.wowChange != null ? ` (${e.wowChange > 0 ? '+' : ''}${e.wowChange.toFixed(0)} wow)` : ''
        return `${e.key}=${e.value}${wow}`
      }).join(', ')
      sections.push(`EIA: ${items}`)
    }
    const regions = commoditySlice.weather?.regions || []
    if (regions.length > 0) {
      for (const r of regions) {
        if (r.count === 0 && (!r.flags || r.flags.length === 0)) continue
        const flagStr = (r.flags || []).length > 0 ? ` flags:${r.flags.join(',')}` : ''
        const alertStr = r.count > 0 ? ` ${r.count} alerts (${r.highestSeverity})` : ''
        sections.push(`weather ${r.region || r.key}:${alertStr}${flagStr}`)
      }
    }
    const crops = commoditySlice.crops?.commodities || []
    if (crops.length > 0) {
      const items = crops.map(c => `${c.commodity} ${c.latest?.value}% ${c.rating}`).join(', ')
      sections.push(`USDA crops: ${items}`)
    }
    if (sections.length > 0) commodityBlock = `\nCommodity-wide context:\n  ${sections.join('\n  ')}\n`
  }

  return `You are a technical analyst sub-agent in a wealth advisor team. Your indicators have been pre-computed server-side. Your job is to rank setups, NOT to re-derive values from raw prices.${macroLine}${calendarLine}${commodityBlock}

Snapshots (one block per symbol):

${lines}

Pick the 3-6 strongest swing setups for the coming 3-10 trading days. Use the computed indicators to justify each choice. Set SL roughly 1.5-2.5% away from entry and TP roughly 3-5% away for a 2:1 R:R minimum.

Return ONLY valid JSON:
{
  "signals": [
    {
      "symbol": "AAPL",
      "direction": "BUY" | "SELL",
      "entry": <number — must equal the snapshot's currentPrice within 0.5%>,
      "stopLoss": <number>,
      "takeProfit": <number>,
      "confidence": <integer 1-10>,
      "thesis": "<<=18 words, reference at least one computed indicator>",
      "indicatorNotes": "<<=20 words, e.g. 'EMA stack bullish + price above VWAP + CVD rising'>"
    }
  ],
  "summary": "<1 sentence <=25 words>"
}

Rules:
- Only emit signals with confidence >= 5.
- SL must be on the loss side of entry, TP on the win side. Hard rule.
- Prefer symbols with aligned EMA stack, confirming CVD slope, and price near a POC or HVN.
- JSON only, no markdown fences.`
}
