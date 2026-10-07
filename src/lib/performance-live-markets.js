// Codex · №11,740 · 2026-10-07; codex-footprint: performance-live-cards-2026-10-07.
import { useEffect, useState } from 'react'
import { agentConfigured, agentGet, pageAsleep } from './agent-api.js'
import { useLiveTicks } from './useLiveTicks.js'
import { displayQuote } from './display-quote.js'
import { quoteReceiptNote } from './data-feed.js'
import { categorize } from '../../agent/shared/formulas.js'
import { reportStats } from '../../agent/shared/performance-populations.js'

export const LIVE_MARKETS = [
  { key: 'stock', title: 'Stocks', markets: ['stock'] },
  { key: 'index', title: 'Indices', markets: ['index'] },
  { key: 'commodity', title: 'Commodities', markets: ['metal', 'energy', 'grain'] },
  { key: 'other', title: 'Other', markets: ['other'] },
]

export function reportFreshness(report, now, error = null) {
  const t = report?.status === 'complete' ? report.asOfMs : null
  if (!Number.isFinite(t) || t <= 0 || t > now + 5000) return { state: 'unavailable', text: 'Performance report unavailable', ageMs: null }
  const ageMs = Math.max(0, now - t)
  const state = error ? 'refresh-failed' : ageMs > 120000 ? 'stale' : 'current'
  const age = ageMs < 60000 ? `${Math.floor(ageMs / 1000)}s` : `${Math.floor(ageMs / 60000)}m`
  return { state, ageMs, text: `Report ${age} old${state === 'stale' ? ' · STALE' : error ? ' · refresh failed; showing last successful report' : ''}` }
}

export function liveMarketSymbols(panel, config, account, positions = []) {
  if (!account) return []
  const watch = String(config?.watchlist_account ?? '') === String(account)
    ? config.watchlist ?? config.symbols ?? [] : []
  const held = positions.filter(p => String(p.account_id ?? '') === String(account)).map(p => p.symbol)
  return [...new Set([...(Array.isArray(watch) ? watch : []), ...held]
    .filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().toUpperCase()))]
    .filter(s => panel.markets.includes(categorize(s))).sort()
}

// A cheap account-owned read; no profile registration or scanner activation.
// Desktop and phone share this state and each market's ONE bounded SSE stream.
export function useMarketWatchlist(account) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    let alive = true, busy = false
    const read = async () => {
      if (!account || !alive || busy || pageAsleep() || !agentConfigured()) return
      busy = true
      try {
        const config = await agentGet(`/state/config?account=${encodeURIComponent(account)}`)
        if (String(config?.watchlist_account ?? '') !== String(account) || config.error) throw Error('Account watchlist receipt unavailable')
        if (alive) setResult({ account, config, error: null })
      } catch (e) { if (alive) setResult({ account, config: null, error: e.message }) }
      finally { busy = false }
    }
    read()
    const timer = setInterval(read, 60000)
    window.addEventListener('agent-wake', read)
    document.addEventListener('visibilitychange', read)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('agent-wake', read); document.removeEventListener('visibilitychange', read) }
  }, [account])
  return result?.account === account ? result : null
}

export function marketPage(symbols, requested = 0) {
  const pages = Math.max(1, Math.ceil(symbols.length / 10))
  const page = Math.max(0, Math.min(Number.isSafeInteger(requested) ? requested : 0, pages - 1))
  return { page, pages, total: symbols.length, symbols: symbols.slice(page * 10, page * 10 + 10) }
}

export function useLiveMarketPage(symbols, account) {
  const [requested, setRequested] = useState({ account: null, page: 0 })
  const page = marketPage(symbols, requested.account === account ? requested.page : 0)
  const ticks = useLiveTicks(account ? page.symbols : [], account)
  return { ...page, ticks, changePage: p => setRequested({ account, page: p }) }
}

const signed = value => value == null || !Number.isFinite(value) ? '—'
  : `${value > 0 ? '+' : ''}${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const tone = value => value == null ? 'var(--color-text-sub)' : value >= 0 ? 'var(--color-up)' : 'var(--color-down)'
const moneyText = a => `${signed(a.pnl)}${a.pnl != null && a.currency ? ` ${a.currency}` : ''}${a.moneyState === 'unverified_cross_account_units' ? ' · not pooled' : ''}`

export function liveMarketView(panel, page, { report, acct, quoteAccount, now, watchlist }) {
  return {
    ...page, key: panel.key, title: panel.title,
    feedNote: `Quotes: account ${quoteAccount || 'not selected'} · midpoint · Δ since this page’s first quote · expire after 15s. ${acct === 'all' ? 'P&L: all accounts; quotes: this account only.' : 'P&L: selected account.'} Trading hours vary by instrument.`,
    emptyNote: watchlist?.config ? 'No matching symbols in this account’s watchlist or open positions.' : `Account watchlist unavailable${watchlist?.error ? `: ${watchlist.error}` : ''}; only owned position symbols can be shown.`,
    k: [['24h', '24H'], ['1w', '7D'], ['30d', '30D']].map(([key, label]) => {
      const a = reportStats(report, key, acct, g => panel.markets.includes(g.market))
      return { k: label, v: moneyText(a), col: tone(a.pnl), note: `${a.pricedN ?? '—'} of ${a.n ?? '—'} priced · ${a.moneyState}` }
    }),
    rows: page.symbols.map(sym => {
      const a = reportStats(report, '1w', acct, g => g.sym === sym)
      const tick = page.ticks[sym]
      const { price, delta } = displayQuote(tick?.accountId === String(quoteAccount) ? tick : null, now)
      return { sym, price, delta, spread: price == null ? null : tick.ask - tick.bid,
        quoteNote: quoteReceiptNote(tick), pnl: moneyText(a), col: tone(a.pnl),
        meta: `${a.n ?? '—'} closes · ${a.pricedN ?? '—'} priced · ${a.wr == null ? '—' : a.wr.toFixed(1)}% win · PF ${a.pf == null ? '—' : a.pf.toFixed(2)}` }
    }),
  }
}
