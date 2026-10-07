// Codex · №11,740 · 2026-10-07; codex-footprint: performance-live-cards-2026-10-07.
import Card from './common/Card.jsx'

export default function LiveMarketCard({ market, mobile = false }) {
  const grid = { display: 'grid', gridTemplateColumns: 'minmax(86px,1fr) 100px 76px minmax(110px,1fr) minmax(240px,2fr)', gap: 8, alignItems: 'center' }
  const text = rows => [market.title, market.feedNote, ...rows.map(r => `${r.sym} · ${r.price ?? '—'} · 7D ${r.pnl} · ${r.meta}`)].join('\n')
  return <Card id={`${mobile ? 'perf-mobile' : 'sec'}-live-${market.key}`} copyTitle={`${market.title} live quotes`} data={market.rows} toText={text}
    style={{ minWidth: 0 }} bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="t-h3">{market.title} — live quotes</h3>
      <div className="ml-auto flex flex-wrap gap-2">
        {market.k.map(k => <span key={k.k} title={k.note} className="rounded-full border border-(--color-border) px-2 py-1 text-(length:--fs-body)">
          {k.k} <span style={{ color: k.col }}>{k.v}</span>
        </span>)}
      </div>
    </div>
    <p className="text-(length:--fs-body) text-(--color-text-sub)">{market.feedNote}</p>
    {market.rows.length === 0 ? <p className="text-(length:--fs-body)">{market.emptyNote}</p> :
      <div style={{ overflowX: 'auto', maxWidth: '100%' }}>
        <div style={{ minWidth: 680, fontSize: 'var(--fs-body)', fontVariantNumeric: 'tabular-nums' }}>
          <div className="t-gridhead" style={grid}><span>Symbol</span><span>Live price</span><span>Δ now</span><span>7D P&amp;L</span><span>Closes · Win · PF</span></div>
          {market.rows.map(row => <div key={row.sym} style={{ ...grid, borderBottom: '1px solid var(--color-border)', padding: '5px 0' }}>
            <span>{row.sym}</span><span title={row.quoteNote}>{row.price == null ? '—' : row.price.toLocaleString(undefined, { maximumFractionDigits: 5 })}</span>
            <span title={row.quoteNote}>{row.delta == null ? '—' : `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(2)}%`}</span>
            <span style={{ color: row.col }}>{row.pnl}</span><span className="text-(--color-text-sub)">{row.meta}</span>
          </div>)}
        </div>
      </div>}
    {market.total > 10 && <div className="flex items-center gap-3 text-(length:--fs-body)">
      <button type="button" className="min-h-11 px-2" disabled={market.page === 0} onClick={() => market.changePage(market.page - 1)}>Previous symbols</button>
      <span>Page {market.page + 1} of {market.pages} · {market.total} symbols</span>
      <button type="button" className="min-h-11 px-2" disabled={market.page + 1 >= market.pages} onClick={() => market.changePage(market.page + 1)}>Next symbols</button>
    </div>}
  </Card>
}
