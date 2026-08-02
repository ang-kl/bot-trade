// Presentation helpers for the strategy-liveness card. Split out of the card
// itself so the component file exports only a component (fast refresh), and so
// the label vocabulary and the copy-to-text form can be tested without
// rendering anything.
//
// The verdict labels are deliberately short and neutral. "Silent" is the
// finding — an armed strategy that produced nothing — and it does not say
// "broken", because the honest reading is that it is either a quiet market or
// a code path that cannot run, and only a backtest over the same window
// separates those two.
export const VERDICT = {
  silent: { label: 'Silent', tone: 'down' },
  signalling_not_trading: { label: 'No orders', tone: 'warning' },
  unknown: { label: 'Too early', tone: 'neutral' },
  trading: { label: 'Trading', tone: 'on' },
  idle_unarmed: { label: 'Not armed', tone: 'off' },
}

export const WINDOWS = [7, 30]

export const ago = (iso) => {
  if (!iso) return 'never'
  const t = Date.parse(String(iso).replace(' ', 'T').endsWith('Z') || String(iso).includes('+')
    ? String(iso).replace(' ', 'T')
    : `${String(iso).replace(' ', 'T')}Z`)
  if (!Number.isFinite(t)) return '—'
  const mins = Math.floor((Date.now() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export const toText = (d) => [
  `Strategy liveness — last ${d.windowDays}d · ${d.totalScans.toLocaleString()} scans${d.verdictable ? '' : ' (too few to judge)'}`,
  ...d.strategies.map(s => `${s.name} · ${s.armed ? 'armed' : 'not armed'} · ${s.signals} signals → ${s.decisions} decisions (${s.vetoes} stopped) → ${s.opened} opened → ${s.closed} closed · ${VERDICT[s.verdict]?.label} — ${s.note}`),
].join('\n')
