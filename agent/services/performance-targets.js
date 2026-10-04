// Owner definitions confirmed 4 October 2026. Reporting only: no entry gate,
// risk setting, broker request or data repair is performed by this reader.
import { closedAtMs } from '../shared/formulas.js'
import { utcMs } from '../lib/record-contracts.js'
import { normPosId } from '../lib/pos-id.js'
import { accountMoney } from './account-money.js'
import { EVIDENCE_RULES } from './position-lifecycle-evidence.js'

const DAY = 86_400_000, SGT = 8 * 3_600_000
export const PERFORMANCE_TARGETS = Object.freeze({
  effectiveAt: '2026-10-03T23:35:00.000Z', timezone: 'Asia/Singapore',
  scope: 'per_account', cohort: 'closed_after_effective_time', sample: 'latest_20_whole_positions',
  trades: 20, winRatePct: 75, profitFactor: 1.68, winRateDays: 3, profitFactorDays: 8,
  minDailyCloses: 1, emptyDayBreaksStreak: true, completedDaysOnly: true, effect: 'reporting_only',
  moneyConvention: 'broker native gross + signed commission + signed swap; conversion fee reported separately, as in the existing ledger',
})
const START = Date.parse(PERFORMANCE_TARGETS.effectiveAt)
const WHOLE = new Set(['agrees', 'filled', 'fragment_resolved', 'money_disagrees', 'money_bearing_fragment', 'unpriced', 'ledger_row_open', 'no_ledger_row'])
const dayOf = ms => new Date(ms + SGT).toISOString().slice(0, 10)
const dayStart = ms => Math.floor((ms + SGT) / DAY) * DAY - SGT
const finite = v => typeof v === 'number' && Number.isFinite(v)

function metrics(rows) {
  const eligible = rows.filter(r => r.complete && finite(r.netPnl))
  const complete = eligible.length === rows.length
  if (!complete || !rows.length) return { n: rows.length, eligible: eligible.length, pending: rows.length - eligible.length,
    wins: null, losses: null, winRatePct: null, profitFactor: null, grossWin: null, grossLoss: null }
  const wins = rows.filter(r => r.netPnl > 0).length
  const grossWin = rows.reduce((sum, r) => sum + Math.max(0, r.netPnl), 0)
  const grossLoss = -rows.reduce((sum, r) => sum + Math.min(0, r.netPnl), 0)
  return { n: rows.length, eligible: rows.length, pending: 0, wins, losses: rows.length - wins,
    winRatePct: wins / rows.length * 100, profitFactor: grossLoss > 0 ? grossWin / grossLoss : null, grossWin, grossLoss }
}

function status(m, key, target, minimum) {
  if (m.pending) return 'unmeasurable'
  if (m.n < minimum) return 'insufficient_sample'
  if (m[key] == null) return 'undefined'
  return m[key] >= target ? 'met' : 'below_target'
}

/** Pure assessment. Records are one canonical whole-position candidate each. */
export function assessPerformanceTargets(records, { now = Date.now(), unavailable = null } = {}) {
  const rows = records.filter(r => finite(r.closedAtMs) && r.closedAtMs > START && r.closedAtMs <= now)
    .sort((a, b) => b.closedAtMs - a.closedAtMs || String(a.positionId).localeCompare(String(b.positionId)))
  const latest = rows.slice(0, PERFORMANCE_TARGETS.trades)
  const latest20 = { ...metrics(latest), positionIds: latest.map(r => r.positionId),
    oldestAt: latest.length ? new Date(latest.at(-1).closedAtMs).toISOString() : null }
  const todayStart = dayStart(now)
  const days = Array.from({ length: PERFORMANCE_TARGETS.profitFactorDays }, (_, i) => {
    const from = todayStart - (i + 1) * DAY
    const m = metrics(rows.filter(r => r.closedAtMs >= from && r.closedAtMs < from + DAY))
    return { day: dayOf(from), ...m,
      winRateStatus: status(m, 'winRatePct', PERFORMANCE_TARGETS.winRatePct, PERFORMANCE_TARGETS.minDailyCloses),
      profitFactorStatus: status(m, 'profitFactor', PERFORMANCE_TARGETS.profitFactor, PERFORMANCE_TARGETS.minDailyCloses) }
  })
  const streak = key => { let n = 0; for (const d of days) { if (d[key] !== 'met') break; n++ } return n }
  const result = (key, target, requiredDays, dayKey) => {
    const sampleStatus = status(latest20, key, target, PERFORMANCE_TARGETS.trades)
    const consecutiveDays = streak(dayKey)
    const dayStatus = days.slice(0, requiredDays).every(d => ['met', 'below_target'].includes(d[dayKey]))
      ? consecutiveDays >= requiredDays ? 'met' : 'below_target' : 'insufficient_days'
    const qualified = sampleStatus === 'met' || consecutiveDays >= requiredDays
    return { target, latest20Status: unavailable ? 'unmeasurable' : sampleStatus,
      dayStatus: unavailable ? 'unmeasurable' : dayStatus,
      consecutiveDays: unavailable ? 0 : consecutiveDays, requiredDays,
      status: unavailable ? 'unmeasurable' : qualified ? 'met'
        : sampleStatus === 'below_target' || dayStatus === 'below_target' ? 'below_target' : 'not_assessed',
      qualified: unavailable ? null : qualified }
  }
  return { at: new Date(now).toISOString(), forwardCloses: rows.length, latest20, days,
    currentDay: { day: dayOf(now), provisional: true, ...metrics(rows.filter(r => r.closedAtMs >= todayStart)) },
    winRate: result('winRatePct', PERFORMANCE_TARGETS.winRatePct, PERFORMANCE_TARGETS.winRateDays, 'winRateStatus'),
    profitFactor: result('profitFactor', PERFORMANCE_TARGETS.profitFactor, PERFORMANCE_TARGETS.profitFactorDays, 'profitFactorStatus'),
    unavailable, note: 'One position counts once after its broker lifecycle closes. Completed SGT days only; today is provisional. Missing known close evidence cannot be skipped to qualify.' }
}

/** Read existing local receipts; never fetch, renew, overwrite or repair them. */
export function performanceTargets(db, { accountIds = [], now = Date.now() } = {}) {
  try {
    const trades = db.prepare(`SELECT id, account_id, ctrader_position_id, closed_at_ms, closed_at
      FROM trades WHERE status = 'closed' AND (closed_at_ms > ? OR closed_at >= ? OR (closed_at_ms IS NULL AND closed_at IS NULL))`).all(START, PERFORMANCE_TARGETS.effectiveAt.slice(0, 10))
    const receipts = db.prepare('SELECT * FROM position_lifecycle_evidence WHERE final_close_ms > ?').all(START)
    const deals = db.prepare('SELECT account_id, position_id, closed_at FROM broker_deals WHERE closed_at >= ?').all(PERFORMANCE_TARGETS.effectiveAt.slice(0, 10))
    const allEvidence = new Map(db.prepare('SELECT * FROM position_lifecycle_evidence').all().map(r => [`${r.account_id}:${normPosId(r.position_id)}`, r]))
    const byAccount = new Map(accountIds.map(id => [String(id), new Map()]))
    let unattributed = 0, unknownCloseTime = 0
    const candidate = (accountId, positionId, time, fallback) => {
      if (!finite(time) || time <= 0) { unknownCloseTime++; return }
      if (!(time > START && time <= now)) return
      const id = accountId == null ? null : String(accountId)
      if (!id) { unattributed++; return }
      const bucket = byAccount.get(id)
      if (!bucket) return
      const pid = normPosId(positionId) || fallback
      const old = bucket.get(pid)
      if (!old || time > old.closedAtMs) bucket.set(pid, { accountId: id, positionId: pid, closedAtMs: time, complete: false, netPnl: null })
    }
    for (const t of trades) candidate(t.account_id, t.ctrader_position_id, closedAtMs(t), `trade:${t.id}`)
    for (const d of deals) candidate(d.account_id, d.position_id, utcMs(d.closed_at), 'deal-without-position')
    for (const r of receipts) candidate(r.account_id, r.position_id, r.final_close_ms, null)
    const accounts = accountIds.map(accountId => {
      const id = String(accountId), bucket = byAccount.get(id)
      const money = accountMoney(db, id, { now, maxAgeMs: 365 * DAY })
      const currency = money.observation?.currency ?? null
      let excludedOpen = 0, excludedBeforeStart = 0
      for (const [pid, row] of bucket) {
        const r = allEvidence.get(`${id}:${pid}`)
        if (r?.verdict === 'open_at_broker' && r.rules === EVIDENCE_RULES && utcMs(r.read_at) >= row.closedAtMs) { bucket.delete(pid); excludedOpen++; continue }
        if (r && WHOLE.has(r.verdict) && r.rules === EVIDENCE_RULES && finite(r.final_close_ms) && r.final_close_ms <= START && utcMs(r.read_at) >= row.closedAtMs) { bucket.delete(pid); excludedBeforeStart++; continue }
        if (r && WHOLE.has(r.verdict) && r.rules === EVIDENCE_RULES && r.host === money.observation?.host
          && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
          && [r.broker_net, r.broker_gross, r.broker_commission, r.broker_swap, r.conversion_fee].every(finite)
          && Math.abs(r.broker_net - (r.broker_gross + r.broker_commission + r.broker_swap)) <= 0.011
          && finite(r.final_close_ms) && r.final_close_ms <= now && utcMs(r.read_at) >= Math.max(r.final_close_ms, row.closedAtMs) && utcMs(r.read_at) <= now) {
          row.complete = true; row.netPnl = r.broker_net; row.closedAtMs = r.final_close_ms
          row.conversionFee = r.conversion_fee
        }
      }
      const unavailable = unattributed || unknownCloseTime ? `${unattributed} unattributed forward close rows; ${unknownCloseTime} undated closed rows require cohort/account reconciliation.` : null
      return { accountId: id, currency, excludedOpen, excludedBeforeStart,
        scope: { account: id, coverage: unavailable ? null : { pct: 100, total: bucket.size, attributable: bucket.size } },
        conversionFee: [...bucket.values()].filter(r => r.complete).reduce((s, r) => s + r.conversionFee, 0),
        ...assessPerformanceTargets([...bucket.values()], { now, unavailable }) }
    })
    return { definition: PERFORMANCE_TARGETS, at: new Date(now).toISOString(), accounts, unattributed, unknownCloseTime,
      source: 'position_lifecycle_evidence: validated balanced broker history; candidates also include recorded closes and closing deals',
      coverageNote: 'Assessment covers observed account/position identities. Missing or unrecorded broker history is not certified as complete coverage.' }
  } catch (err) {
    return { definition: PERFORMANCE_TARGETS, at: new Date(now).toISOString(), accounts: [], unavailable: `target evidence reader failed: ${err.message}` }
  }
}
