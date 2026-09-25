// ---------------------------------------------------------------------------
// agent/services/daily-report.js — the daily Telegram report, read from the
// DB and posted on the loop's daily cursor. Wave 5 of
// docs/first-principles-audit-2026-09-19.md §K (item 16): "services/
// daily-report.js reading the DB and posting to Telegram on the loop's daily
// cursor."
//
// WHAT IT SAYS, in the order the owner reads it (which is also the order
// sections are KEPT when the text must be cut to Telegram's limit):
//   1. the goal table's summary and every off_track row (id + current);
//   2. the momentum book: week-to-date per account and the checkpoint row;
//   3. the equity curve's last two nights per account, with the change;
//   4. family edge per family over 90 d (PF, tail share, max DD, closes);
//   5. the veto rate (the goal table's veto_rate row);
//   6. arming changes in the last 24 h;
//   7. open positions.
// Plain text, no markdown (Telegram rejects the whole message on one
// unmatched `_`), ≤ DAILY_REPORT_MAX_CHARS: the footer is under 4096 with
// the version footer telegram.js appends.
//
// CADENCE. One pass every 24 h on `daily_report_last_at` with the
// housekeeping-due rule (equity-snapshot.js has the same shape), stamped
// BEFORE the work: a report that throws half-way is retried tomorrow, not
// on every cycle for a day.
//
// DELIVERY. Through the Telegram outbox (telegram-digest.js queueMessage) so
// quiet hours and the digest mode apply; when the outbox write fails the
// text goes straight to telegram.js sendMessage. Both are injectable for
// tests. The last text is kept under `daily_report_last_json` for
// GET /state/daily-report.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { housekeepingDue } from './housekeeping-due.js'
import { invalidateStateCache } from '../lib/state-cache.js'

export const DAILY_REPORT_LAST_KEY = 'daily_report_last_at'
export const DAILY_REPORT_TEXT_KEY = 'daily_report_last_json'
export const DAILY_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Telegram rejects > 4096; the version footer and a margin come off that. */
export const DAILY_REPORT_MAX_CHARS = 3_800
export const TRUNCATED_MARK = '…truncated'

/** Is the daily report due? Same rule as housekeeping, 24 h interval. */
export function dailyReportDue(db, nowMs = Date.now(), intervalMs = DAILY_REPORT_INTERVAL_MS) {
  return housekeepingDue(getState(db, DAILY_REPORT_LAST_KEY), nowMs, intervalMs)
}

const short = (id) => `…${String(id).slice(-4)}`
const money = (n) => (Number.isFinite(Number(n)) ? (Number(n) >= 0 ? '+' : '') + Number(n).toFixed(2) : 'n/a')
const num = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? 'n/a' : Number(n).toFixed(d))

// Each reader returns a list of lines and never throws: a section that
// cannot be read says so in one line, and the other sections still go out.
async function goalsSection(db, now) {
  const { goalTable } = await import('./goal-table.js')
  const t = await goalTable(db, { now })
  const s = t.summary
  const lines = [`Goals: ${s.on_track} on track, ${s.off_track} off track, ${s.not_measurable} not measurable (of ${t.goals.length})`]
  for (const g of t.goals.filter(g => g.verdict === 'off_track')) lines.push(`  off track: ${g.id} — ${g.current ?? 'n/a'} (target ${g.target ?? 'n/a'})`)
  return { lines, table: t }
}

async function momentumSection(db, table) {
  const lines = []
  const { momentumAccountReport } = await import('./momentum-account.js')
  const report = momentumAccountReport(db)
  const accts = Object.values(report?.accounts || {})
  if (!accts.length) lines.push('Momentum: no account configured')
  for (const a of accts) {
    const w = a.weekToDate || {}
    lines.push(`Momentum ${a.account}: week to date ${w.closes ?? 0} close(s), ${w.wins ?? 0} win(s), net ${money(w.net ?? 0)}; ${(a.open || []).length} open`)
  }
  const cp = table?.goals?.find(g => g.id === 'momentum_checkpoint')
  if (cp) lines.push(`Checkpoint ${cp.checkpointDate ?? '(date unset)'}: ${cp.verdict} — ${cp.note}`)
  return lines
}

async function equitySection(db, now) {
  const { equityCurve } = await import('./equity-snapshot.js')
  const curve = equityCurve(db, { days: 3, now })
  const lines = []
  if (!curve.accounts.length) return ['Equity: no nightly snapshot yet']
  for (const a of curve.accounts) {
    const pts = a.points.filter(p => p.equity != null).slice(-2)
    if (!pts.length) { lines.push(`Equity ${short(a.accountId)}: no reading (${a.points[a.points.length - 1]?.error ?? 'unread'})`); continue }
    const last = pts[pts.length - 1], prev = pts.length > 1 ? pts[0] : null
    lines.push(`Equity ${short(a.accountId)}: ${num(last.equity)} ${last.currency || '(currency unrecorded)'} on ${String(last.at).slice(0, 10)}` + (prev && prev.currency && prev.currency === last.currency ? ` (${num(last.equity - prev.equity)} equity change vs ${String(prev.at).slice(0, 10)}; cashflows unadjusted)` : ' (comparison unavailable without matching currency)'))
  }
  return lines
}

async function familySection(db, now) {
  const { familyEdgeReport } = await import('./family-edge.js')
  const r = familyEdgeReport(db, { days: 90, now })
  const lines = []
  for (const [fam, f] of Object.entries(r.families || {})) {
    if (!f || !f.closes) { lines.push(`Family ${fam}: no closes in 90 d`); continue }
    lines.push(`Family ${fam}: ${f.closes} close(s), PF ${num(f.profitFactor)}, tail ${f.tailSharePct == null ? 'n/a' : f.tailSharePct + '%'}, max DD ${num(f.maxDrawdownR, 1)}R, net ${money(f.netUsd)}`)
  }
  if (!lines.length) lines.push('Family edge: no families reported')
  // Plan P1: a tick close is counted by its basis (family-edge.js byBasis.tick),
  // in no family and not in `unattributed` — without this line the first
  // tick closes would vanish from the daily report.
  const tick = r.byBasis?.tick
  if (tick && tick.closes > 0) lines.push(`Tick basis: ${tick.closes} close(s), PF ${num(tick.profitFactor)}, tail ${tick.tailSharePct == null ? 'n/a' : tick.tailSharePct + '%'}, max DD ${num(tick.maxDrawdownR, 1)}R, net ${money(tick.netUsd)}`)
  if (r.unattributed) lines.push(`  ${r.unattributed} close(s) unattributed to a family`)
  return lines
}

function vetoSection(table) {
  const v = table?.goals?.find(g => g.id === 'veto_rate')
  if (!v) return ['Vetoes: row missing']
  return [`Vetoes: ${v.current ?? 'n/a'} (${v.verdict}) — ${v.note}`]
}

async function armingSection(db, now) {
  const { armingLogView } = await import('./arming-log.js')
  const view = armingLogView(db, { limit: 50 })
  const since = now - DAILY_REPORT_INTERVAL_MS
  const recent = (view.recent || []).filter(r => { const t = Date.parse(String(r.at || '').replace(' ', 'T') + (String(r.at || '').endsWith('Z') ? '' : 'Z')); return Number.isFinite(t) ? t >= since : true })
  if (!recent.length) return ['Arming: no changes in 24 h']
  const lines = [`Arming: ${recent.length} change(s) in 24 h`]
  for (const r of recent.slice(0, 12)) lines.push(`  ${String(r.at).slice(0, 16)} ${r.kind}:${r.key} ${r.stage} ${r.from ?? '?'}→${r.to ?? '?'} by ${r.actor}${r.scope ? ` on ${short(r.scope)}` : ''}`)
  if (recent.length > 12) lines.push(`  …and ${recent.length - 12} more`)
  return lines
}

function positionsSection(db) {
  let open = 0, byAccount = []
  try {
    open = Number(db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE status = 'open'`).get()?.n || 0)
    byAccount = db.prepare(`SELECT account_id, COUNT(*) AS n FROM trades WHERE status = 'open' GROUP BY account_id ORDER BY n DESC`).all()
  } catch (err) { return [`Open positions: unreadable — ${err?.message || err}`] }
  const parts = byAccount.map(r => `${short(r.account_id ?? '?')} ${r.n}`).join(', ')
  return [`Open positions: ${open}${parts ? ` (${parts})` : ''}`]
}

/**
 * Cut `sections` (in priority order, first kept longest) to `max` chars.
 * Sections are trimmed from the LAST one back; a trimmed section keeps its
 * first line and ends with TRUNCATED_MARK. Pure.
 */
export function fitSections(sections, max = DAILY_REPORT_MAX_CHARS) {
  const render = (secs) => secs.map(s => s.lines.join('\n')).join('\n\n')
  const out = sections.map(s => ({ ...s, lines: [...s.lines] }))
  let truncated = false
  const dropped = []
  for (let i = out.length - 1; i >= 0 && render(out).length > max; i--) {
    const s = out[i]
    truncated = true
    // Drop lines from the tail until it fits or only the head line is left.
    while (render(out).length > max && s.lines.length > 1) s.lines.pop()
    if (render(out).length <= max) {
      if (s.lines[s.lines.length - 1] !== TRUNCATED_MARK) s.lines.push(TRUNCATED_MARK)
      if (render(out).length <= max) break
      s.lines.pop()
      if (render(out).length <= max) break
    }
    // Even the head line does not fit: the section goes, whole — a one-word
    // stub of it is not a report of it (checker note, 19-09-2026).
    out.splice(i, 1)
    dropped.unshift(s.id)
  }
  if (dropped.length && out.length) {
    const note = `${TRUNCATED_MARK} (${dropped.join(', ')} dropped)`
    out[out.length - 1].lines.push(note)
    if (render(out).length > max) out[out.length - 1].lines.pop()
  }
  let text = render(out)
  if (text.length > max) { text = text.slice(0, max - TRUNCATED_MARK.length - 1) + '\n' + TRUNCATED_MARK; truncated = true }
  return { text, truncated, dropped }
}

/**
 * Build the report. Every section is attempted; a reader that throws is one
 * line in its section, never a missing report. Returns { text, sections,
 * truncated, chars }.
 */
export async function buildDailyReport(db, { now = Date.now() } = {}) {
  const at = new Date(now).toISOString()
  const sections = []
  const attempt = async (id, fn) => {
    try { return await fn() } catch (err) { return [`${id}: unreadable — ${err?.message || err}`] }
  }
  let table = null
  sections.push({ id: 'header', lines: [`Daily report — ${at.slice(0, 16).replace('T', ' ')} UTC`] })
  sections.push({ id: 'goals', lines: await attempt('Goals', async () => { const g = await goalsSection(db, now); table = g.table; return g.lines }) })
  sections.push({ id: 'momentum', lines: await attempt('Momentum', () => momentumSection(db, table)) })
  sections.push({ id: 'equity', lines: await attempt('Equity', () => equitySection(db, now)) })
  sections.push({ id: 'family', lines: await attempt('Family edge', () => familySection(db, now)) })
  sections.push({ id: 'vetoes', lines: await attempt('Vetoes', async () => vetoSection(table)) })
  sections.push({ id: 'arming', lines: await attempt('Arming', () => armingSection(db, now)) })
  sections.push({ id: 'positions', lines: await attempt('Open positions', async () => positionsSection(db)) })
  const { text, truncated } = fitSections(sections)
  return { at, text, sections, truncated, chars: text.length }
}

/**
 * Stamp the cursor, build, deliver, record. `queue` defaults to the outbox;
 * `send` (direct) is used when the outbox write returns false. Never throws
 * past the stamp: the result carries ok/error.
 */
export async function postDailyReport(db, { now = Date.now(), send = null, queue = null } = {}) {
  // STAMP BEFORE THE WORK: a report that fails is tomorrow's problem, not
  // every cycle's for the next 24 h.
  setState(db, DAILY_REPORT_LAST_KEY, new Date(now).toISOString())
  const out = { ok: false, at: new Date(now).toISOString(), chars: 0, truncated: false, delivery: null, error: null }
  try {
    const r = await buildDailyReport(db, { now })
    out.chars = r.chars; out.truncated = r.truncated
    const q = queue ?? (await import('./telegram-digest.js')).queueMessage
    let queued = false
    try { queued = q(db, { text: r.text, kind: 'daily_report', priority: 'normal', reason: 'daily report' }) === true } catch { queued = false }
    if (queued) out.delivery = 'queued'
    else {
      const s = send ?? (await import('./telegram.js')).sendMessage
      await s(r.text, { plain: true })
      out.delivery = 'sent_direct'
    }
    setState(db, DAILY_REPORT_TEXT_KEY, JSON.stringify({ at: out.at, text: r.text, chars: r.chars, truncated: r.truncated, delivery: out.delivery }))
    // The loop writes this out-of-band from any route, and /state's response
    // cache only clears on a write it saw — say so, or the page serves the
    // previous report for STATE_CACHE_MS after a post.
    invalidateStateCache()
    out.ok = true
  } catch (err) {
    out.error = String(err?.message || err)
    // A failure must not READ AS A FRESH RECORD: heartbeat.js dates the
    // effect by `.at`, so the last SUCCESSFUL record keeps its `at` and
    // text, and the failure is stamped beside it as failedAt + error
    // (checker should-fix, 19-09-2026; failure mode #3).
    try {
      let prev = null
      try { prev = JSON.parse(getState(db, DAILY_REPORT_TEXT_KEY) || 'null') } catch { prev = null }
      const keep = prev && prev.at ? { at: prev.at, text: prev.text ?? null, chars: prev.chars ?? 0, truncated: prev.truncated ?? false, delivery: prev.delivery ?? null } : {}
      setState(db, DAILY_REPORT_TEXT_KEY, JSON.stringify({ ...keep, failedAt: out.at, error: out.error }))
    } catch { /* the error is already in the result */ }
  }
  return out
}

/** GET /state/daily-report: the last report plus whether the next is due. */
export function dailyReportView(db, nowMs = Date.now()) {
  let last = null
  try { last = JSON.parse(getState(db, DAILY_REPORT_TEXT_KEY) || 'null') } catch { last = null }
  return {
    last,
    lastAt: getState(db, DAILY_REPORT_LAST_KEY),
    due: dailyReportDue(db, nowMs),
    intervalHours: DAILY_REPORT_INTERVAL_MS / 3600_000,
    maxChars: DAILY_REPORT_MAX_CHARS,
  }
}
