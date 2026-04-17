// News tab — Polygon.io real-time news feed for watchlist symbols,
// plus Structure (Prompt 1) for daily briefing outline.

import { useState, useEffect, useCallback } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import Badge from '../common/Badge.jsx'
import { useStrategy } from '../../lib/strategy-store.js'

async function callRundown(action, body = {}) {
  const res = await fetch('/api/rundown', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `rundown ${action} ${res.status}`)
  return data
}

async function fetchPolygonNews(apiKey, tickers = [], limit = 30) {
  const params = new URLSearchParams({ apiKey, limit: String(limit), order: 'desc', sort: 'published_utc' })
  if (tickers.length > 0) params.set('ticker.in', tickers.join(','))
  const res = await fetch(`https://api.polygon.io/v2/reference/news?${params}`)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || data.message || `News API ${res.status}`)
  return data.results || []
}

export default function NewsTab() {
  const { state, dispatch } = useStrategy()
  const { structure } = state.news

  // Structure (Prompt 1)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  // News feed
  const [articles, setArticles] = useState([])
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsError, setNewsError] = useState(null)
  const [tickerFilter, setTickerFilter] = useState('all') // 'all' or specific ticker

  const stockSymbols = state.watchlist
    .filter(w => w.category === 'Stocks')
    .map(w => w.symbol)

  // Auto-fetch news on mount
  useEffect(() => {
    if (!state.massive.apiKey || stockSymbols.length === 0) return
    let cancelled = false
    setNewsLoading(true)
    setNewsError(null)
    fetchPolygonNews(state.massive.apiKey, stockSymbols, 50)
      .then(results => { if (!cancelled) setArticles(results) })
      .catch(e => { if (!cancelled) setNewsError(e.message) })
      .finally(() => { if (!cancelled) setNewsLoading(false) })
    return () => { cancelled = true }
  }, [state.massive.apiKey, stockSymbols.join(',')])

  const onRefreshNews = useCallback(async () => {
    if (!state.massive.apiKey) return
    setNewsLoading(true)
    setNewsError(null)
    try {
      const tickers = tickerFilter === 'all' ? stockSymbols : [tickerFilter]
      const results = await fetchPolygonNews(state.massive.apiKey, tickers, 50)
      setArticles(results)
    } catch (e) {
      setNewsError(e.message)
    } finally {
      setNewsLoading(false)
    }
  }, [state.massive.apiKey, stockSymbols, tickerFilter])

  const onBuildStructure = async () => {
    setBusy('structure'); setError(null)
    try {
      const data = await callRundown('structure')
      dispatch({ type: 'NEWS_SET_STRUCTURE', structure: data.markdown ?? null })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  // Filter articles by ticker
  const filtered = tickerFilter === 'all'
    ? articles
    : articles.filter(a => (a.tickers || []).includes(tickerFilter))

  const fmtTime = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleString('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  }

  return (
    <div className="space-y-4">
      {/* News Feed */}
      <Card>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <h2 className="t-label">Market News</h2>
            <Badge tone="info" pill>{filtered.length} articles</Badge>
          </div>
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={onRefreshNews} disabled={newsLoading}>
              {newsLoading ? 'Loading...' : '\u21BB Refresh'}
            </Button>
          </div>
        </div>

        {/* Ticker filter */}
        {stockSymbols.length > 0 && (
          <div className="flex gap-1 flex-wrap mb-3">
            <button
              type="button"
              onClick={() => setTickerFilter('all')}
              className={`px-1.5 py-0.5 text-[9px] sm:text-[10px] rounded-[4px] font-bold cursor-pointer transition-colors ${
                tickerFilter === 'all'
                  ? 'bg-[var(--color-accent)] text-white'
                  : 'bg-[var(--color-bg)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]'
              }`}
            >
              All
            </button>
            {stockSymbols.map(sym => (
              <button
                key={sym}
                type="button"
                onClick={() => setTickerFilter(sym)}
                className={`px-1.5 py-0.5 text-[9px] sm:text-[10px] rounded-[4px] font-bold cursor-pointer transition-colors ${
                  tickerFilter === sym
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'bg-[var(--color-bg)] text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]'
                }`}
              >
                {sym}
              </button>
            ))}
          </div>
        )}

        {!state.massive.apiKey && (
          <p className="t-meta text-[var(--color-down)] mb-2">
            Massive API key required. Set it in Admin to fetch real market news.
          </p>
        )}

        {newsError && <p className="t-meta text-[var(--color-down)] mb-2">{newsError}</p>}

        {filtered.length === 0 && !newsLoading && (
          <p className="t-sub text-[var(--color-muted)] py-4 text-center">
            {stockSymbols.length === 0
              ? 'Add stock symbols to your watchlist to see news.'
              : 'No articles found. Click refresh to fetch latest news.'}
          </p>
        )}

        {filtered.length > 0 && (
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {filtered.map((a, i) => (
              <a
                key={a.id || i}
                href={a.article_url}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-2 py-1.5 rounded-[5px] hover:bg-[var(--color-accent-soft)]/30 transition-colors group"
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-semibold text-[var(--color-text)] group-hover:text-[var(--color-accent)] leading-tight">
                      {a.title}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] font-bold text-[var(--color-accent)]">
                        {a.publisher?.name || 'Unknown'}
                      </span>
                      <span className="text-[10px] text-[var(--color-muted)]">
                        {fmtTime(a.published_utc)}
                      </span>
                      {(a.tickers || []).slice(0, 4).map(t => (
                        <span key={t} className="text-[9px] font-mono px-1 py-0 rounded bg-[var(--color-bg)] text-[var(--color-text-sub)] border border-[var(--color-border)]">
                          {t}
                        </span>
                      ))}
                    </div>
                    {a.description && (
                      <p className="text-[10px] text-[var(--color-text-sub)] mt-0.5 line-clamp-2">
                        {a.description}
                      </p>
                    )}
                  </div>
                  {a.image_url && (
                    <img
                      src={a.image_url}
                      alt=""
                      className="w-16 h-12 object-cover rounded-[4px] shrink-0 hidden sm:block"
                      loading="lazy"
                    />
                  )}
                </div>
              </a>
            ))}
          </div>
        )}
      </Card>

      {/* Structure (Prompt 1) — keep */}
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="t-label flex-1">Structure (Prompt 1)</h2>
          <Button size="sm" variant="ghost" onClick={onBuildStructure} disabled={busy === 'structure'}>
            {busy === 'structure' ? 'Building...' : 'Rebuild'}
          </Button>
        </div>
        {error && <p className="t-sub text-[var(--color-down)] mb-2">{error}</p>}
        {structure ? (
          <pre className="t-meta whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded-[7px] border border-[var(--color-border)]">{structure}</pre>
        ) : (
          <p className="t-sub text-[var(--color-text-sub)]">No structure cached. Click Rebuild to generate the markdown outline that every daily rundown will follow.</p>
        )}
      </Card>
    </div>
  )
}
