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
import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { exitKind } from './trade-plans.js'
import { findUnreasonedTrades } from './close-completeness.js'

/** Compose the journal for one UTC day ('YYYY-MM-DD'). Pure DB read. */
export function buildDailyJournal(db, day) {
  const trades = db.prepare(
    `SELECT symbol, side, net_pnl, ${strategyAttrSql()} AS strat
     FROM trades WHERE status = 'closed' AND net_pnl IS NOT NULL
       AND substr(closed_at, 1, 10) = ?`
  ).all(day)
  const wins = trades.filter(t => Number(t.net_pnl) > 0)
  const net = Math.round(trades.reduce((s, t) => s + (Number(t.net_pnl) || 0), 0) * 100) / 100
  const best = trades.length ? trades.reduce((a, b) => (Number(b.net_pnl) > Number(a.net_pnl) ? b : a)) : null
  const worst = trades.length ? trades.reduce((a, b) => (Number(b.net_pnl) < Number(a.net_pnl) ? b : a)) : null

  // PR-C: a repeated veto is one row with repeat_count n. `vetoed` sums the
  // repeats (the number of refusals, comparable with the un-merged history);
  // `vetoedDistinct` counts rows (distinct refusals).
  const risk = db.prepare(
    `SELECT SUM(approved) AS ok,
            SUM(CASE WHEN approved = 1 THEN 0 ELSE COALESCE(repeat_count, 1) END) AS vetoed,
            COUNT(*) - SUM(approved) AS vetoed_distinct
       FROM risk_events
      WHERE substr(created_at, 1, 10) = ?`
  ).get(day)
  const topVeto = db.prepare(
    `SELECT veto_reason, COALESCE(repeat_count, 1) AS reps FROM risk_events
     WHERE approved = 0 AND substr(created_at, 1, 10) = ? AND veto_reason IS NOT NULL`
  ).all(day)
  const fam = {}
  for (const r of topVeto) {
    const k = String(r.veto_reason).split(/[:\s]/)[0]
    fam[k] = (fam[k] || 0) + Math.max(1, Number(r.reps) || 1)
  }
  const topVetoes = Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 3)

  // PR-E (owner principle 4): the day's closes the BOT did not make — the
  // reconciler's "closed at the broker …" and the monitor's already_closed
  // — counted apart from the attributed exits; and the standing invariant
  // (every bot trade since the origin cutoff has a reason, no stale UNKNOWN)
  // read at composition time, so the report says how many are unexplained
  // rather than leaving it to a page nobody opens.
  const closedByBroker = db.prepare(
    `SELECT close_reason FROM trades WHERE status = 'closed' AND substr(closed_at, 1, 10) = ?`
  ).all(day).filter(r => exitKind(r.close_reason) === 'broker_closed').length
  let reasonViolations = null
  try { reasonViolations = findUnreasonedTrades(db).counts.total } catch { reasonViolations = null }

  return {
    day,
    trades: trades.length,
    net,
    winRate: trades.length ? Math.round((wins.length / trades.length) * 100) : null,
    best: best ? { symbol: best.symbol, net: Number(best.net_pnl) } : null,
    worst: worst ? { symbol: worst.symbol, net: Number(worst.net_pnl) } : null,
    approved: Number(risk?.ok) || 0,
    vetoed: Number(risk?.vetoed) || 0,
    vetoedDistinct: Number(risk?.vetoed_distinct) || 0,
    vetoRate: vetoRate(Number(risk?.ok) || 0, Number(risk?.vetoed) || 0),
    topVetoes: topVetoes.map(([reason, count]) => ({ reason, count })),
    closedByBroker,
    reasonViolations,
  }
}

/** vetoed / (approved + vetoed), as a percentage to one decimal; null when nothing reached the gate. */
export function vetoRate(approved, vetoed) {
  const n = approved + vetoed
  return n > 0 ? Math.round((vetoed / n) * 1000) / 10 : null
}

/** `vetoes: N (M distinct, rate R%)` — the PR-C line on the daily report. */
export function vetoLine(j) {
  const distinct = j.vetoedDistinct ?? j.vetoed
  const rate = j.vetoRate ?? vetoRate(j.approved || 0, j.vetoed || 0)
  return `vetoes: ${j.vetoed} (${distinct} distinct${rate == null ? '' : `, rate ${rate}%`})`
}

export function journalText(j) {
  const money = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
  const lines = [`📒 Journal ${j.day}`]
  lines.push(j.trades === 0
    ? 'No closed trades.'
    : `${j.trades} closed · net ${money(j.net)} · ${j.winRate}% wins` +
      (j.best ? ` · best ${j.best.symbol} ${money(j.best.net)}` : '') +
      (j.worst && j.trades > 1 ? ` · worst ${j.worst.symbol} ${money(j.worst.net)}` : ''))
  lines.push(`Gate: ${j.approved} approved · ${vetoLine(j)}${j.topVetoes.length ? ` (top: ${j.topVetoes.map(v => `${v.reason.replace(/_/g, ' ')} ×${v.count}`).join(', ')})` : ''}`)
  lines.push(`reasons: ${j.reasonViolations == null ? 'unavailable' : `${j.reasonViolations} violation(s)`} · closedByBroker: ${j.closedByBroker ?? 0}`)
  return lines.join('\n')
}

/**
 * The journal as a self-contained HTML page (Telegram attachment) with
 * links into the webapp where each fact can be ACTED on (owner spec).
 * Blue = up, red = down — no green (owner is colourblind).
 */
export function journalHtml(j, base = 'https://bot-trade-five.vercel.app') {
  const money = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`
  const tone = (v) => (v >= 0 ? '#2563eb' : '#dc2626')
  const row = (k, v) => `<tr><td style="padding:6px 14px 6px 0;color:#64748b">${k}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Journal ${j.day} — bot-trade</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:20px;background:#f4f6fb;color:#0f172a">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:22px;box-shadow:0 2px 10px rgba(15,23,42,.08)">
<h1 style="font-size:18px;margin:0 0 4px">📒 Journal — ${j.day}</h1>
<p style="margin:0 0 14px;color:#64748b;font-size:13px">bot-trade daily record · facts from the broker-truth ledger</p>
<table style="border-collapse:collapse;font-size:14px;width:100%">
${row('Closed trades', j.trades)}
${row('Net result', `<span style="color:${tone(j.net)}">${money(j.net)}</span>`)}
${row('Win rate', j.winRate != null ? `${j.winRate}%` : '—')}
${j.best ? row('Best', `${j.best.symbol} <span style="color:${tone(j.best.net)}">${money(j.best.net)}</span>`) : ''}
${j.worst && j.trades > 1 ? row('Worst', `${j.worst.symbol} <span style="color:${tone(j.worst.net)}">${money(j.worst.net)}</span>`) : ''}
${row('Risk gate', `${j.approved} approved · ${vetoLine(j)}`)}
${j.topVetoes.length ? row('Top vetoes', j.topVetoes.map(v => `${v.reason.replace(/_/g, ' ')} ×${v.count}`).join(' · ')) : ''}
${row('Reasons', `${j.reasonViolations == null ? 'unavailable' : `${j.reasonViolations} violation(s)`} · closed by broker ${j.closedByBroker ?? 0}`)}
</table>
<h2 style="font-size:14px;margin:18px 0 6px">Act on it</h2>
<ul style="font-size:14px;line-height:1.9;margin:0;padding-left:18px">
<li><a href="${base}/" style="color:#2563eb">Desk</a> — live positions, edge health, heartbeats</li>
<li><a href="${base}/trade" style="color:#2563eb">Trade</a> — order log with every veto explained</li>
<li><a href="${base}/tune" style="color:#2563eb">Tune</a> — risk limits, strategy × stage matrix, watchlist, backtest</li>
<li><a href="${base}/accounts" style="color:#2563eb">Accounts</a> — broker truth for every account</li>
</ul>
<p style="margin:16px 0 0;color:#94a3b8;font-size:12px">Generated by the agent at UTC day close. No LLM involved — same tables the app reads.</p>
</div></body></html>`
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
      const { sendMessage, sendDocument } = await import('./telegram.js')
      await sendMessage(journalText(j))
      // Rich version: HTML attachment with links into the webapp (owner
      // spec). Base URL overridable via agent_state `webapp_url`.
      const base = getState(db, 'webapp_url') || 'https://bot-trade-five.vercel.app'
      await sendDocument(`journal-${yesterday}.html`, journalHtml(j, base), `📒 ${yesterday} — open for the full journal with links into the app`)
    } catch { /* non-fatal */ }
  }
  return { sent: true, journal: j }
}
