// PerfMacroSections — the last three Page-1 sections of the design_claude
// Performance Dashboard, exact ports: the macro regime matrix (SVG rings +
// asset-group dots + quadrant cards + O-I-A applications), Balance in/out,
// and the Data feed essentials. Markup/inline values/copy are 1:1 from
// Performance Dashboard.dc.html; only data sources change:
//  - dot P&L per asset group = REAL 30D closed trades (group filters are
//    the prototype's own symbol lists — design content);
//  - quadrant cards list REAL open positions via the prototype's QMAP
//    (symbols outside the map are counted honestly, never guessed);
//  - live per-position P&L isn't streamed here → '—', card tint at base;
//  - balance in/out has NO data source yet (deposits/withdrawals aren't
//    tracked in the DB) → exact panel with an honest empty state;
//  - data feed panel: real values where the APIs provide them, '—' else.
import { useState } from 'react'
import SectionTools from './common/SectionTools.jsx'

const ACC = 'var(--color-accent)', UP = 'var(--color-up)', DN = 'var(--color-down)'
const TX = 'var(--color-text)', SB = 'var(--color-text-sub)', MU = 'var(--color-muted)'
const WRN = 'var(--color-warning-text)', EDG = 'var(--glass-edge)'
const GL = 'var(--color-surface)', GBD = 'var(--color-border)', ACS = 'var(--color-accent-soft)'
const panel = {
  background: GL, border: `1px solid ${GBD}`, borderRadius: 16, boxShadow: 'var(--glass-shadow)',
  backdropFilter: 'blur(22px) saturate(160%)', padding: '8px 10px', display: 'flex', flexDirection: 'column',
}
const nf1 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (v) => (v == null || Number.isNaN(Number(v)) ? '—' : `${v > 0 ? '+' : ''}${nf1.format(Number(v))}`)

// The prototype's regime coordinates + group symbol filters (design content).
const RGM = [
  ['Crypto BTC/ETH', (t) => ['BTCUSD', 'ETHUSD'].includes(t.sym), 0.72, 0.55],
  ['Alt crypto SOL/XRP', (t) => ['SOLUSD', 'XRPUSD'].includes(t.sym), 0.88, 0.68],
  ['Gold XAU', (t) => t.sym === 'XAUUSD', -0.45, 0.52],
  ['Silver XAG', (t) => t.sym === 'XAGUSD', -0.6, 0.62],
  ['Energy WTI/Gas', (t) => t.cat === 'energy', 0.3, 0.78],
  ['Grains', (t) => t.cat === 'grain', -0.2, 0.68],
  ['US indices', (t) => ['US500', 'US30', 'NAS100'].includes(t.sym), 0.55, -0.35],
  ['EU indices GER40/UK100', (t) => ['GER40', 'UK100'].includes(t.sym), 0.35, -0.2],
  ['Asia indices JPN/HK/AUS', (t) => ['JPN225', 'HK50', 'AUS200', 'CN50', 'SG30'].includes(t.sym), 0.5, 0.18],
  ['USD majors', (t) => ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'USDCAD'].includes(t.sym), -0.3, -0.25],
  ['JPY crosses', (t) => ['EURJPY', 'GBPJPY', 'AUDJPY', 'NZDJPY', 'CADJPY', 'CHFJPY'].includes(t.sym), -0.55, -0.45],
  ['Comdoll AUD/NZD', (t) => ['AUDUSD', 'NZDUSD', 'AUDNZD', 'AUDCAD', 'AUDCHF', 'NZDCHF', 'NZDCAD'].includes(t.sym), 0.2, 0.4],
  ['Exotics ZAR/TRY/MXN', (t) => ['USDZAR', 'USDTRY', 'USDMXN', 'USDSGD', 'USDHKD', 'USDCNH'].includes(t.sym), -0.75, 0.8],
]
// Prototype QMAP + quadrant copy (design playbook content, verbatim).
const QMAP = { BTCUSD: 'q1', ETHUSD: 'q1', EURUSD: 'q3', USDJPY: 'q2', XAUUSD: 'q2', GER40: 'q4', US500: 'q4', AUS200: 'q1' }
const QTXT = {
  q1: ['Q1 · Overheating', 'high growth · high inflation — USD ↔/↓, gold ↑ hedge · long commodities, energy, value — short long-duration bonds'],
  q2: ['Q2 · Stagflation', 'low growth · high inflation — USD ↑ safe-haven, gold ↑/↔ · long commodities, TIPS, cash — short equities & growth'],
  q3: ['Q3 · Deflation / Recession', 'low growth · low inflation — USD ↑↑ flight to safety, gold ↓/↔ · long Treasuries, defensives — short commodities, AUD & NZD'],
  q4: ['Q4 · Goldilocks / Recovery', 'high growth · low inflation — USD ↓ risk-on, gold ↓ · long tech/growth, crypto, high-yield — short USD, CHF, JPY'],
}
const QPAL = {
  q1: ['rgba(255,196,102,', 'rgba(255,196,102,.55)'],
  q2: ['rgba(255,77,109,', 'rgba(255,77,109,.5)'],
  q3: ['rgba(199,92,60,', 'rgba(199,92,60,.55)'],
  q4: ['rgba(255,140,90,', 'rgba(255,140,90,.5)'],
}
const OIA = [
  ['1 · Live trades — execution & hedging', 'Matrix guards against accidental overexposure. Long gold in Q2 → short a lagging correlated asset or an inverse one (US500) to capture spread. Heavy long USD into a Q3 shock → small long Treasuries as a correlated safe-haven hedge.', false],
  ['2 · Pending orders — cross-asset triggers', "Anchor limits/stops to the quadrant's leading asset. Q1 + oil breaking resistance → confirms buy-limits on gold. Buy orders on AUD/USD betting on Q4 → tight stops below support; gold spiking with USD rallying = market pricing Q2, thesis invalid.", false],
  ['3 · Anticipation — regime shifts', 'Correlations reverse at quadrant transitions. Soft inflation data + gold stubbornly high + USD dropping = front-running Q2 → Q4. Fed signalling cuts on slowing growth (Q2 → Q3) → expect gold-equity correlation to break; short commodities, long defensive bonds.', false],
  ['4 · Intraday — direction filter', 'Lower timeframes are noise — fake breakouts everywhere. The quadrant is the institutional-flow filter: in Q2 the cTrader algos accept only long-USD setups on 5m/15m and ignore every short signal. Trade with the macro tide only.', true],
  ['5 · Intraday — dynamic sizing', 'Volatility explodes on NFP/CPI surprises. Data confirming the quadrant → scale to full size on correlated assets. Data contradicting it (regime shift threat) → halve risk or pause until institutional consensus settles.', true],
  ['6 · Intraday — divergence execution', "Asset classes react to macro shifts milliseconds-to-minutes apart. Yields spike confirming Q1 but gold hasn't moved on the 1m chart → market-order gold to front-run the delayed capital flow that aligns with the curve.", true],
]

function QuadCard({ q }) {
  return (
    <div style={{ flex: 1, border: `1px solid ${q.bd}`, background: q.bg, borderRadius: 14, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 800 }}>{q.title}</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: MU }}>{q.tot}</span>
      </div>
      <span style={{ fontSize: 10, lineHeight: 1.4, color: SB }}>{q.txt}</span>
      {q.rows.map((r, ri) => (
        <div key={ri} style={{ display: 'flex', alignItems: 'baseline', gap: 5, borderTop: `1px solid ${EDG}`, paddingTop: 3, fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ fontSize: 10, fontWeight: 800 }}>{r.sym}</span>
          <span style={{ fontSize: 10, color: SB }}>{r.sd}</span>
          <span style={{ fontSize: 10, color: MU }}>{r.acct}</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: MU }}>{r.pnl}</span>
        </div>
      ))}
      {q.rows.length === 0 && <span style={{ fontSize: 10, color: MU, borderTop: `1px solid ${EDG}`, paddingTop: 3 }}>no open trades in this quadrant</span>}
    </div>
  )
}

/** trades30: [{sym, cat, pnl}] real closed 30D · positions: monitored rows */
export function RegimeMatrix({ trades30, positions, accounts, inModal = false }) {
  const [rAcct, setRAcct] = useState('all')
  const dots = RGM.map(([name, fn, gx, iy]) => {
    const l = trades30.filter(fn)
    const p = l.reduce((s, t) => s + t.pnl, 0)
    const cx = 360 + gx * 300, cy = 205 - iy * 168
    const col = l.length ? (p >= 0 ? UP : DN) : MU
    return {
      name, cx, cy, tx: cx + (gx > 0.6 ? -8 : 8), anc: gx > 0.6 ? 'end' : 'start',
      pnl: l.length ? signed(p) : 'no trades', col, dot: col,
      tip: `${name} · 30D ${l.length ? `${signed(p)} · ${l.length} trades` : 'no trades'}`,
    }
  })
  const scoped = positions.filter(p => rAcct === 'all' || String(p.account_id ?? '') === rAcct)
  const qsum = { q1: [], q2: [], q3: [], q4: [] }
  let unmapped = 0
  for (const p of scoped) {
    const q = QMAP[String(p.symbol || '').toUpperCase()]
    if (q) qsum[q].push(p); else unmapped++
  }
  const quadCards = ['q2', 'q1', 'q3', 'q4'].map(q => ({
    id: q, title: QTXT[q][0], txt: QTXT[q][1],
    rows: qsum[q].map(p => ({
      sym: p.symbol,
      sd: `${String(p.side || '').toUpperCase() === 'BUY' ? 'LONG' : 'SHORT'} ${p.volume ?? '—'}`,
      acct: p.account_id != null ? `·${String(p.account_id).slice(-3)}` : '—',
      pnl: '—', // live P&L not streamed to this page — never simulated
    })),
    tot: '—',
    bg: QPAL[q][0] + '0.10)', bd: QPAL[q][1],
  }))
  const rOpts = [{ id: 'all', label: 'All Accounts' }, ...accounts.map(a => ({ id: a.account_id, label: `${a.is_live ? 'Live' : 'Demo'} ${a.trader_login || a.account_id}` }))]
  return (
    <div style={{ ...panel, gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: ACC }}>Macro regime matrix — where the book sits</span>
        <span style={{ fontSize: 10, color: SB }}>growth × inflation, not static correlations · ring = volatility band · dot color = 30D net for that group · hover a dot</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: WRN }}>quadrant playbooks are the design's reference copy — the bot does not compute a live regime read yet</span>
        {!inModal && (
          <SectionTools id="regime" title="Macro regime matrix — where the book sits" window="30D"
            data={dots.map(d => ({ group: d.name, net30d: d.pnl }))}
            toText={() => ['Macro regime matrix — 30D net per asset group', ...dots.map(d => `${d.name} · ${d.pnl}`)].join('\n')}
            render={() => <RegimeMatrix trades30={trades30} positions={positions} accounts={accounts} inModal />} />
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: MU }}>Account</span>
        {rOpts.map(o => {
          const on = rAcct === o.id
          return (
            <button key={o.id} type="button" onClick={() => setRAcct(o.id)}
              style={{ cursor: 'pointer', fontFamily: 'inherit', fontSize: 10, fontWeight: 700, color: on ? '#fff' : TX, background: on ? ACC : 'transparent', border: `1px solid ${on ? ACC : EDG}`, borderRadius: 999, padding: '3px 11px' }}>
              {o.label}
            </button>
          )
        })}
        <span style={{ fontSize: 10, color: MU }}>filters the four quadrant cards — where this account's open trades sit right now{unmapped ? ` · ${unmapped} open position${unmapped === 1 ? '' : 's'} outside the quadrant map` : ''}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '330px 1fr 330px', gap: 10, alignItems: 'stretch' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <QuadCard q={quadCards[0]} /><QuadCard q={quadCards[2]} />
        </div>
        <svg viewBox="0 0 720 410" style={{ width: '80%', justifySelf: 'center', alignSelf: 'center', overflow: 'visible' }}>
          <g>
            <text x="30" y="52" fontSize="10" fontWeight="700" fill={SB}>Lo Vol</text>
            <rect x="62" y="44" width="16" height="10" rx="2" fill="rgba(79,140,255,.35)" />
            <rect x="78" y="44" width="16" height="10" rx="2" fill="rgba(255,196,102,.4)" />
            <rect x="94" y="44" width="16" height="10" rx="2" fill="rgba(255,140,90,.4)" />
            <rect x="110" y="44" width="16" height="10" rx="2" fill="rgba(255,77,109,.45)" />
            <text x="132" y="52" fontSize="10" fontWeight="700" fill={DN}>Hi Vol</text>
          </g>
          <ellipse cx="360" cy="205" rx="330" ry="188" fill="rgba(255,77,109,.16)" />
          <ellipse cx="360" cy="205" rx="264" ry="150" fill="rgba(255,77,109,.14)" />
          <ellipse cx="360" cy="205" rx="198" ry="113" fill="rgba(255,196,102,.16)" />
          <ellipse cx="360" cy="205" rx="132" ry="75" fill="rgba(255,196,102,.2)" />
          <ellipse cx="360" cy="205" rx="66" ry="38" fill="rgba(79,140,255,.22)" />
          <line x1="360" y1="8" x2="360" y2="402" stroke={EDG} strokeWidth="1.5" />
          <line x1="18" y1="205" x2="702" y2="205" stroke={EDG} strokeWidth="1.5" />
          <text x="360" y="0" textAnchor="middle" fontSize="11" fontWeight="800" fontStyle="italic" fill={TX}>Rising inflation</text>
          <text x="360" y="410" textAnchor="middle" fontSize="11" fontWeight="800" fontStyle="italic" fill={TX}>Slowing inflation</text>
          <text x="14" y="197" textAnchor="start" fontSize="11" fontWeight="800" fontStyle="italic" fill={TX}>Slowing growth</text>
          <text x="706" y="197" textAnchor="end" fontSize="11" fontWeight="800" fontStyle="italic" fill={TX}>Accelerating growth</text>
          <text x="300" y="207" textAnchor="end" fontSize="10" fontWeight="700" fill={SB} dominantBaseline="middle">lo vol</text>
          <text x="668" y="195" textAnchor="end" fontSize="10" fontWeight="700" fill={SB}>hi vol</text>
          <text x="30" y="26" fontSize="10" fontWeight="800" fill={SB}>Q2 STAGFLATION <tspan fontWeight="600" fill={MU}>· USD ↑ safe-haven · gold ↑/↔</tspan></text>
          <text x="30" y="38" fontSize="10" fontWeight="600" fill={MU}>long commodities · TIPS · cash — short equities &amp; growth</text>
          <text x="690" y="26" textAnchor="end" fontSize="10" fontWeight="800" fill={WRN}>Q1 OVERHEATING <tspan fontWeight="600" fill={MU}>· USD ↔/↓ real yields · gold ↑ hedge</tspan></text>
          <text x="690" y="38" textAnchor="end" fontSize="10" fontWeight="600" fill={MU}>long commodities · energy · value — short long-duration bonds</text>
          <text x="30" y="380" fontSize="10" fontWeight="800" fill={SB}>Q3 DEFLATION / RECESSION <tspan fontWeight="600" fill={MU}>· USD ↑↑ flight to safety · gold ↓/↔</tspan></text>
          <text x="30" y="392" fontSize="10" fontWeight="600" fill={MU}>long Treasuries · defensives — short commodities · AUD &amp; NZD</text>
          <text x="690" y="380" textAnchor="end" fontSize="10" fontWeight="800" fill={SB}>Q4 GOLDILOCKS / RECOVERY <tspan fontWeight="600" fill={MU}>· USD ↓ risk-on outflow · gold ↓</tspan></text>
          <text x="690" y="392" textAnchor="end" fontSize="10" fontWeight="600" fill={MU}>long tech/growth · crypto · high-yield — short USD · CHF · JPY</text>
          {dots.map(p => (
            <g key={p.name}>
              <title>{p.tip}</title>
              <circle cx={p.cx} cy={p.cy} r="5" fill={p.dot} stroke="var(--color-bg)" strokeWidth="1.5" />
              <text x={p.tx} y={p.cy} textAnchor={p.anc} dominantBaseline="middle" fontSize="10.5" fontWeight="700" fill={TX}>{p.name} <tspan fontWeight="800" fill={p.col}>{p.pnl}</tspan></text>
            </g>
          ))}
        </svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <QuadCard q={quadCards[1]} /><QuadCard q={quadCards[3]} />
        </div>
      </div>
      <span style={{ fontSize: 10, color: MU }}>positions are the classic growth × inflation playbook for each group the bot trades — center = cash-like calm, outer ring = highest volatility · blue label = group is net positive over 30D, red = net negative</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, borderTop: `1px solid ${EDG}`, paddingTop: 5 }}>
        {OIA.map(([title, txt, topBorder]) => (
          <div key={title} style={{ display: 'flex', flexDirection: 'column', gap: 2, ...(topBorder ? { borderTop: `1px solid ${EDG}`, paddingTop: 4 } : {}) }}>
            <span style={{ fontSize: 10, fontWeight: 800 }}>{title}</span>
            <span style={{ fontSize: 10, lineHeight: 1.45, color: SB }}>{txt}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function BalanceInOut({ inModal = false }) {
  return (
    <div style={{ ...panel, gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: ACC }}>Balance in / out — deposits, withdrawals &amp; transfers</span>
        <span style={{ fontSize: 10, color: SB }}>non-trading cash flows · excluded from P&amp;L, carry-forward adjusts on the transaction date</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: MU }}>net —</span>
        {!inModal && (
          <SectionTools id="balance-in-out" title="Balance in / out" data={[]}
            toText={() => 'Balance in / out — no transfers recorded (cash-flow ingestion not built yet)'}
            render={() => <BalanceInOut inModal />} />
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 150px 110px 130px 1fr 110px 70px', gap: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: MU, borderBottom: `1px solid ${EDG}`, paddingBottom: 2 }}>
        <span>Date</span><span>Time (UTC · AEST)</span><span>Type</span><span>Account</span><span>Counterparty / note</span><span style={{ textAlign: 'right' }}>Amount · ccy</span><span style={{ textAlign: 'right' }}>Status</span>
      </div>
      <span style={{ fontSize: 10, color: MU, padding: '4px 0' }}>
        No transfers recorded — the agent does not ingest broker cash-flow events yet. Rows appear collect-forward once deposit/withdrawal tracking is built; nothing here is ever reconstructed by guesswork.
      </span>
    </div>
  )
}

/** Real values where the APIs provide them; '—' where not collected. */
export function DataFeed({ balance, freeMargin, equity, openCount, dailyLossPct, equityStopArmed, slSet, tpSet, clock, inModal = false }) {
  const box = { border: `1px solid ${EDG}`, borderRadius: 10, padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 3 }
  const chip = { fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: ACS, border: `1px solid ${GBD}` }
  const money = (v) => (v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'))
  return (
    <div style={{ ...panel, gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--color-special-text)' }}>Data feed — core universal essentials</span>
        <span style={{ fontSize: 10, color: SB }}>what the bot ingests before any strategy fires, regardless of asset class</span>
        {!inModal && (
          <SectionTools id="data-feed" title="Data feed — core universal essentials"
            data={[{ balance, freeMargin, equity, openCount, dailyLossPct, equityStopArmed, slSet, tpSet }]}
            render={() => <DataFeed balance={balance} freeMargin={freeMargin} equity={equity} openCount={openCount} dailyLossPct={dailyLossPct} equityStopArmed={equityStopArmed} slSet={slSet} tpSet={tpSet} clock={clock} inModal />} />
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
        <div style={box}>
          <span style={{ fontSize: 10, fontWeight: 800 }}>OHLCV data</span>
          <span style={{ fontSize: 10, color: SB, lineHeight: 1.4 }}>Open · High · Low · Close · Volume across multiple timeframes</span>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {['1m', '15m', '1h', '4h', '1D'].map(tf => <span key={tf} style={chip}>{tf}</span>)}
          </div>
          <span style={{ fontSize: 10, color: MU, fontVariantNumeric: 'tabular-nums' }}>watchlist symbols stream per scan cycle · {clock}</span>
        </div>
        <div style={box}>
          <span style={{ fontSize: 10, fontWeight: 800 }}>Account &amp; portfolio state</span>
          <span style={{ fontSize: 10, color: SB, lineHeight: 1.4 }}>Live cash, available margin, open positions, unrealized P&amp;L</span>
          <span style={{ fontSize: 10, color: MU, fontVariantNumeric: 'tabular-nums' }}>cash {money(balance)} · margin avail {money(freeMargin)}</span>
          <span style={{ fontSize: 10, color: MU, fontVariantNumeric: 'tabular-nums' }}>{openCount} open · unrealized <span style={{ fontWeight: 800, color: equity != null && balance != null ? (equity - balance >= 0 ? UP : DN) : MU }}>{equity != null && balance != null ? signed(equity - balance) : '—'}</span></span>
        </div>
        <div style={box}>
          <span style={{ fontSize: 10, fontWeight: 800 }}>Execution parameters</span>
          <span style={{ fontSize: 10, color: SB, lineHeight: 1.4 }}>Bid-ask spreads, fees, latency, slippage thresholds</span>
          <span style={{ fontSize: 10, color: MU, fontVariantNumeric: 'tabular-nums' }}>spread &amp; fees recorded per trade (forensics columns) — no live feed here</span>
          <span style={{ fontSize: 10, color: MU, fontVariantNumeric: 'tabular-nums' }}>latency <span style={{ fontWeight: 800, color: ACC }}>—</span> · captured at entry per trade</span>
        </div>
        <div style={box}>
          <span style={{ fontSize: 10, fontWeight: 800 }}>Risk controls</span>
          <span style={{ fontSize: 10, color: SB, lineHeight: 1.4 }}>Stop-loss limits, take-profit triggers, max drawdown caps</span>
          <span style={{ fontSize: 10, color: MU, fontVariantNumeric: 'tabular-nums' }}>SL set {slSet}/{openCount} open · TP set {tpSet}/{openCount}</span>
          <span style={{ fontSize: 10, color: MU, fontVariantNumeric: 'tabular-nums' }}>max drawdown {dailyLossPct != null ? `${(dailyLossPct * 100).toFixed(0)}%/day` : '—'} · equity stop <span style={{ fontWeight: 800, color: ACC }}>{equityStopArmed ? 'armed' : 'off'}</span></span>
        </div>
      </div>
    </div>
  )
}
