// ---------------------------------------------------------------------------
// agent/services/journal.js — the trading day, written down.
//
// Owner: "what would you be doing, do you journal?" Now yes: once per UTC
// day the agent composes the previous day's journal — trades taken, net
// result, best/worst, win rate, veto pressure, guard activity — sends it to
// Telegram (📒) and persists the JSON in agent_state (`journal_YYYY-MM-DD`)
// so the history is queryable later. Facts only, from the same tables the
// UI reads; no LLM involved.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

/** Compose the journal for one UTC day ('YYYY-MM-DD'). Pure DB read. */
export function buildDailyJournal(db, day) {
  const trades = db.prepare(
    `SELECT symbol, side, net_pnl, COALESCE(label_strategy, strategy) AS strat
     FROM trades WHERE status = 'closed' AND net_pnl IS NOT NULL
       AND substr(closed_at, 1, 10) = ?`
  ).all(day)
  const wins = trades.filter(t => Number(t.net_pnl) > 0)
  const net = Math.round(trades.reduce((s, t) => s + (Number(t.net_pnl) || 0), 0) * 100) / 100
  const best = trades.length ? trades.reduce((a, b) => (Number(b.net_pnl) > Number(a.net_pnl) ? b : a)) : null
  const worst = trades.length ? trades.reduce((a, b) => (Number(b.net_pnl) < Number(a.net_pnl) ? b : a)) : null

  const risk = db.prepare(
    `SELECT SUM(approved) AS ok, COUNT(*) - SUM(approved) AS vetoed FROM risk_events
     WHERE substr(created_at, 1, 10) = ?`
  ).get(day)
  const topVeto = db.prepare(
    `SELECT veto_reason FROM risk_events
     WHERE approved = 0 AND substr(created_at, 1, 10) = ? AND veto_reason IS NOT NULL`
  ).all(day)
  const fam = {}
  for (const r of topVeto) {
    const k = String(r.veto_reason).split(/[:\s]/)[0]
    fam[k] = (fam[k] || 0) + 1
  }
  const topVetoes = Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 3)

  return {
    day,
    trades: trades.length,
    net,
    winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : null,
    best: best ? { symbol: best.symbol, net: Number(best.net_pnl) } : null,
    worst: worst ? { symbol: worst.symbol, net: Number(worst.net_pnl) } : null,
    approved: Number(risk?.ok) || 0,
    vetoed: Number(risk?.vetoed) || 0,
    topVetoes: topVetoes.map(([reason, count]) => ({ reason, count })),
  }
}

export function journalText(j) {
  const money = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
  const lines = [`📒 Journal ${j.day}`]
  lines.push(j.trades === 0
    ? 'No closed trades.'
    : `${j.trades} closed · net ${money(j.net)} · ${j.winRate}% wins` +
      (j.best ? ` · best ${j.best.symbol} ${money(j.best.net)}` : '') +
      (j.worst && j.trades > 1 ? ` · worst ${j.worst.symbol} ${money(j.worst.net)}` : ''))
  lines.push(`Gate: ${j.approved} approved · ${j.vetoed} vetoed${j.topVetoes.length ? ` (top: ${j.topVetoes.map(v => `${v.reason.replace(/_/g, ' ')} ×${v.count}`).join(', ')})` : ''}`)
  return lines.join('\n')
}

/** Once per UTC day: journal YESTERDAY, send + persist. Call from housekeep. */
export async function sendDailyJournal(db) {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
  const doneKey = `journal_sent_${yesterday}`
  if (getState(db, doneKey) === 'y') return { skipped: 'already sent' }
  const j = buildDailyJournal(db, yesterday)
  setState(db, `journal_${yesterday}`, JSON.stringify(j))
  setState(db, doneKey, 'y')
  if (process.env.TELEGRAM_BOT_TOKEN) {
    try {
      const { sendMessage } = await import('./telegram.js')
      await sendMessage(journalText(j))
    } catch { /* non-fatal */ }
  }
  return { sent: true, journal: j }
}
