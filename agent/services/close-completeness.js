// ---------------------------------------------------------------------------
// agent/services/close-completeness.js — flag a CLOSED trade that never
// finished being processed: no net_pnl backfill, and/or no postmortem.
//
// Two reactive sweeps already exist and both stay unbounded in time with no
// aging alert:
//   · pnl-backfill.js       — fills net_pnl from broker deal history
//   · loss-postmortem.js    — classifies a closed trade into a lesson
// loss-postmortem.js forces a verdict past 24h old (`stale` → `allowPartial`)
// for any row its own query even reaches — but a trade with BOTH net_pnl AND
// exit_price still NULL never enters that query at all (it's excluded on
// purpose, since there's nothing to classify from). That trade can sit
// forever with no signal that anything is wrong. This sweep is the signal:
// deterministic, no LLM, keyed off closed_at_ms (the millisecond-precision
// column closeTradeRow stamps — agent/db.js) so it only ever looks at trades
// closed after that convergence landed.
//
// A trade closed less than `windowHours` ago is never flagged — that's
// exactly loss-postmortem.js's own 24h staleness cutoff plus headroom, so
// nothing genuinely still "waiting for enough bars" (loss-postmortem.js's
// own `waiting` bucket) can reach this sweep before it would have already
// been force-classified.
// ---------------------------------------------------------------------------

import { CLEAN_BOT_ORIGINS } from '../lib/trade-origin.js'
import { isOurs } from '../lib/trade-labels.js'
import { normPosId } from '../lib/pos-id.js'
import { UNPRICEABLE_VERDICTS, planContractClass, utcMs } from '../lib/record-contracts.js'
import { UNKNOWN_MAX_AGE_MS } from './entry-ledger.js'
import { EVIDENCE_RULES } from './position-lifecycle-evidence.js'
import { HEURISTIC_LINK, heuristicLinks, matchTradeIntent } from './adopted-reasons.js'

const HOUR_MS = 3_600_000

// PR-E (owner principle 4, 11-09-2026): the origin column's first write —
// every entry path stamps `origin` at creation from this date, so a bot
// trade since it with no origin, no strategy, no plan, no approval id or no
// close reason is a trade without a stated reason, not a pre-column row.
export const TRADE_REASONS_CUTOFF_ISO = '2026-08-17'

export const UNREASONED_KINDS = Object.freeze([
  'origin_missing',      // origin NULL on a row opened after the cutoff
  'origin_unknown',      // origin = 'unknown' — written when nothing could be established
  'strategy_missing',    // a clean bot origin with no strategy
  'plan_missing',        // a clean bot origin with no trade_plans row
  'risk_event_missing',  // a clean bot origin with no approval id
  'close_reason_missing', // closed with no close_reason
  'plan_unscored',       // closed, has a plan, the plan was never scored
  'backfilled_after_cutoff', // M3: legacy_unattributed / manual_broker written by the BACKFILL on a post-cutoff row — a write path should have stamped it
  'adopted_ours_unreasoned', // M4: reconciler_adopted with OUR label and no strategy, plan or approval id — a bot fill whose record was lost (B4c: an approval id or plan standing only on the pre-L2a symbol+time link counts as missing)
  'intent_unknown_stale', // an entry_intents UNKNOWN older than UNKNOWN_MAX_AGE_MS
])

/**
 * V3 B4 (P5b-3): the one violation that a DATE can explain. The plan writer
 * (plan-at-entry, #857) began after the trade_reasons cutoff, so a row
 * opened between the two could not carry a plan: its plan_missing — and an
 * adopted row whose ONLY missing piece is the plan — is `pre_contract`.
 * Every other kind is `post_contract`: its writer existed when the row was
 * opened (the cutoff IS the origin column's first write), so the gap is the
 * codebase's. That includes plan_unscored: the row HAS a plan, and
 * scoreClosedPlans (trade-plans.js) scores every closed trade with an
 * unscored plan with no date filter, so an unscored plan is a live scorer
 * gap whatever the open date (principle 3; B4 checker nit 1). The class is
 * shown BESIDE the raw count, never subtracted from it, until the owner
 * answers H-P5b-3.
 */
export function reasonContractClass(kind, openedAt, missing = null) {
  const planOnly = kind === 'plan_missing' ||
    (kind === 'adopted_ours_unreasoned' && Array.isArray(missing) && missing.length === 1 && missing[0] === 'plan')
  if (!planOnly) return 'post_contract'
  return planContractClass(utcMs(openedAt)) === 'pre_contract' ? 'pre_contract' : 'post_contract'
}

/**
 * V3 B4c: the rest of an adopted_ours_unreasoned detail — where a value on
 * the row came from, and what alone may fill each missing piece
 * (services/adopted-reasons.js). Named, never subtracted: the row stays
 * counted.
 *
 * An approval id on a row still `reconciler_adopted` with no B4c evidence
 * row was written by the pre-L2a closed-market sweep, the only writer that
 * stamps an approval without moving the origin (the reconciler's stamp, the
 * evidence-linked sweep and the book link all set a bot origin). That sweep
 * matched "the first trade on this symbol since placement" — a heuristic L2a
 * (#1114) removed as unreliable — so the id is shown as such, not as
 * evidence, and (fix round, checker blocker 1) counted as missing —
 * `approval id (heuristic link)` — as is a closed_market_limit_fill plan the
 * same sweep wrote, until a record confirms the stored id
 * (adopted-reasons.js heuristicLinks).
 */
export const ADOPTED_UNRECOVERED = Object.freeze({
  strategy: "only our label's strategy code or the matched intent's producer may supply it",
  plan: 'none was recorded at adoption, and none is invented after the fact',
  'approval id': 'only an entry intent, the resting order row that placed it or a same-position bot row may supply it — never a time window',
  // B4c fix round (checker blocker 1): the pre-L2a link is not a reason. The
  // row stays counted, post-contract, until an evidence record confirms the
  // stored id or the owner rules on such links.
  [HEURISTIC_LINK.approval]: 'the id on the row stands only on the pre-L2a symbol + time link; only an entry intent, the resting order row that placed it or a same-position bot row may confirm it',
  [HEURISTIC_LINK.plan]: 'written by the same pre-L2a sweep from the resting row it linked by symbol + time; it stands only on that link',
})
function adoptedEvidenceNote(db, r, missingList, ev) {
  const parts = []
  if (ev.strategy) parts.push(`strategy from ${ev.strategy.evidence}`)
  const ra = ev.risk_event_id
  if (ra) parts.push(ra.before != null && String(ra.before) === String(ra.value)
    ? `approval id #${ra.value} confirmed by ${ra.evidence}`
    : `approval id #${ra.value} from ${ra.evidence}`)
  else if (r.risk_event_id != null) parts.push(`approval id #${r.risk_event_id} linked by the pre-L2a closed-market sweep (symbol + time), not by evidence`)
  if (missingList.includes(HEURISTIC_LINK.plan)) parts.push(`plan written by the same sweep (source ${r.plan_source})`)
  // Checker nit 3: the approval the evidence names, not only the key.
  const c = ev.risk_event_id_conflict
  if (c) parts.push(`an evidence record (${c.evidence}) names approval #${c.value}, not the stored #${c.before}; trade_reason_evidence`)
  // Checker nit 4: THIS row's reason no record could supply or confirm the
  // approval — the matcher's own refusal, not only the per-field text.
  if (missingList.includes('approval id') || missingList.includes(HEURISTIC_LINK.approval)) {
    let m = null
    try { m = matchTradeIntent(db, r) } catch { m = null }
    if (m && !m.intent && m.why) parts.push(`no entry intent matched: ${m.why}`)
  }
  const why = missingList.filter(f => ADOPTED_UNRECOVERED[f]).map(f => `${f}: ${ADOPTED_UNRECOVERED[f]}`)
  return (parts.length ? ` — ${parts.join('; ')}` : '') + (why.length ? ` — missing: ${why.join('; ')}` : '')
}

/**
 * The invariant: every trade the bot decided to take since the cutoff has a
 * reason on record, and no send is left UNKNOWN past the resolver's age.
 * Population: `trades` opened at or after `sinceIso` with status open or
 * closed (a refused or cancelled submission never became a trade). External
 * origins (reconciler_adopted, manual_broker, external_system) carry no
 * strategy by design and are outside the population; an origin NULL or
 * 'unknown' since the cutoff is itself the violation.
 *
 * @returns {{ sinceIso: string, trades: number, violations: Array<{tradeId?:number, intentId?:string, kind:string, detail:string}>, counts: { total:number, byKind: Record<string, number> } }}
 */
export function findUnreasonedTrades(db, { sinceIso = TRADE_REASONS_CUTOFF_ISO, now = Date.now(), unknownMaxAgeMs = UNKNOWN_MAX_AGE_MS } = {}) {
  const clean = CLEAN_BOT_ORIGINS.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.status, t.origin, t.origin_source, t.label_raw, t.strategy, t.risk_event_id, t.close_reason, t.opened_at,
           t.account_id, t.intent_id, t.ctrader_position_id,
           p.trade_id AS plan_id, p.scored_at, p.source AS plan_source
      FROM trades t LEFT JOIN trade_plans p ON p.trade_id = t.id
     WHERE t.status IN ('open', 'closed')
       AND t.opened_at IS NOT NULL
       AND REPLACE(t.opened_at, 'T', ' ') >= ?
       AND (t.origin IS NULL OR t.origin = 'unknown' OR t.origin IN (${clean})
            OR (t.origin_source = 'backfill' AND t.origin IN ('legacy_unattributed', 'manual_broker'))
            OR t.origin = 'reconciler_adopted')
     ORDER BY t.id
  `).all(sinceIso, ...CLEAN_BOT_ORIGINS)
  const violations = []
  // V3 B4c: what adopted-reasons.js recovered for a row, and from what. The
  // table is written by that module; absent (a database it never ran on),
  // nothing is named and the detail reads as before.
  let evidenceStmt = null
  try { evidenceStmt = db.prepare('SELECT field, evidence, value, before_value FROM trade_reason_evidence WHERE trade_id = ?') } catch { evidenceStmt = null }
  const evidenceOf = (tradeId) => {
    if (!evidenceStmt) return {}
    try { return Object.fromEntries(evidenceStmt.all(tradeId).map(e => [e.field, { evidence: e.evidence, value: e.value, before: e.before_value }])) } catch { return {} }
  }
  // V3 B4: every trade violation carries its contract class (reasonContractClass).
  const push = (tradeId, kind, detail, openedAt, missing = null) =>
    violations.push({ tradeId, kind, detail, contract: reasonContractClass(kind, openedAt, missing) })
  for (const r of rows) {
    const who = `#${r.id} ${r.symbol} ${r.side}`
    if (r.origin == null) { push(r.id, 'origin_missing', `${who}: origin NULL on a row opened ${r.opened_at}`, r.opened_at); continue }
    if (r.origin === 'unknown') { push(r.id, 'origin_unknown', `${who}: origin 'unknown'`, r.opened_at); continue }
    if (r.origin_source === 'backfill' && (r.origin === 'legacy_unattributed' || r.origin === 'manual_broker')) {
      // M3: the backfill is bounded to pre-cutoff rows (origin-backfill.js);
      // a post-cutoff row carrying its stamp was laundered, not explained.
      push(r.id, 'backfilled_after_cutoff', `${who}: origin '${r.origin}' written by the backfill on a row opened ${r.opened_at} — after the cutoff a write path should have stamped it`, r.opened_at)
      continue
    }
    if (r.origin === 'reconciler_adopted') {
      // M4: an adopted position wearing OUR label is a bot fill whose local
      // record was lost; it needs the same reasons as any bot trade.
      let ours = false
      try { ours = isOurs(r.label_raw || '') } catch { ours = false }
      if (ours) {
        // B4c fix round (checker blocker 1): an approval id or a plan that
        // stands only on the pre-L2a symbol + time link is missing, not a
        // reason — filling the strategy must not let the row leave the count
        // or turn pre_contract on it (heuristicLinks).
        const ev = evidenceOf(r.id)
        const missingList = [
          (r.strategy == null || String(r.strategy).trim() === '') && 'strategy', r.plan_id == null && 'plan', r.risk_event_id == null && 'approval id',
          ...heuristicLinks({ origin: r.origin, riskEventId: r.risk_event_id, planSource: r.plan_source, approvalEvidence: ev.risk_event_id ?? null }),
        ].filter(Boolean)
        if (missingList.length) push(r.id, 'adopted_ours_unreasoned', `${who}: adopted with our label (${String(r.label_raw).slice(0, 40)}) and no ${missingList.join(', ')}${adoptedEvidenceNote(db, r, missingList, ev)}`, r.opened_at, missingList)
      }
      continue
    }
    if (r.strategy == null || String(r.strategy).trim() === '') push(r.id, 'strategy_missing', `${who}: no strategy`, r.opened_at)
    if (r.plan_id == null) push(r.id, 'plan_missing', `${who}: no trade_plans row`, r.opened_at)
    if (r.risk_event_id == null) push(r.id, 'risk_event_missing', `${who}: no risk_event_id`, r.opened_at)
    if (r.status === 'closed') {
      if (r.close_reason == null || String(r.close_reason).trim() === '') push(r.id, 'close_reason_missing', `${who}: closed with no close_reason`, r.opened_at)
      if (r.plan_id != null && r.scored_at == null) push(r.id, 'plan_unscored', `${who}: closed, plan never scored`, r.opened_at)
    }
  }
  let stale = []
  try {
    stale = db.prepare(`SELECT id, account_id, symbol, side, created_at FROM entry_intents WHERE state = 'UNKNOWN' AND created_at <= ? ORDER BY id`)
      .all(new Date(now - unknownMaxAgeMs).toISOString())
  } catch { stale = [] }
  for (const it of stale) {
    const ageH = Math.round((now - Date.parse(it.created_at)) / HOUR_MS)
    violations.push({ intentId: it.id, kind: 'intent_unknown_stale', detail: `${it.id} …${String(it.account_id).slice(-4)} ${it.symbol} ${it.side}: UNKNOWN for ${ageH}h`, contract: 'post_contract' })
  }
  const byKind = {}
  for (const v of violations) byKind[v.kind] = (byKind[v.kind] || 0) + 1
  // V3 B4: the same violations split by contract — a PARTITION of `total`
  // (every violation is in exactly one class), never a replacement for it.
  const byContract = { pre_contract: 0, post_contract: 0 }
  const byContractKind = { pre_contract: {}, post_contract: {} }
  for (const v of violations) {
    byContract[v.contract]++
    byContractKind[v.contract][v.kind] = (byContractKind[v.contract][v.kind] || 0) + 1
  }
  // `trades` = the bot's own rows (clean origins, or NULL/'unknown' since
  // the cutoff); `considered` adds the adopted and backfilled rows read for
  // the M3/M4 kinds, which are not bot trades unless a stamp made them one.
  const bot = rows.filter(r => r.origin == null || r.origin === 'unknown' || CLEAN_BOT_ORIGINS.includes(r.origin)).length
  return { sinceIso, trades: bot, considered: rows.length, violations, counts: { total: violations.length, byKind, byContract, byContractKind } }
}

/**
 * V3 B4 (P5b-3): WHAT EACH INCOMPLETE CLOSE IS WAITING ON — or that it is
 * waiting on nothing that can come. One class per row:
 *
 *   labelled_unrecoverable   no P&L, and a label says it cannot come: the row
 *                            was written off (pnl_unresolvable, with its
 *                            reason and time) or the broker's complete
 *                            position history returned a FINAL verdict under
 *                            which it cannot be priced (UNPRICEABLE_VERDICTS).
 *                            Its postmortem waits on money that will not
 *                            arrive. Excluded from P&L — never counted as 0.
 *   broker_evidence_pending  no P&L and no such label: the backfill and the
 *                            position reader still own it.
 *   postmortem_pending       P&L on record, no postmortem: the postmortem
 *                            sweep owes it.
 *
 * The class NAMES the row; it never removes it. Every row stays counted in
 * close_completeness until the owner answers H-P5b-3.
 */
export const CLOSE_CLASSES = Object.freeze({
  labelled_unrecoverable: 'no P&L, and a write-off or a final broker verdict says it cannot be priced — excluded from P&L, never counted as 0; its postmortem waits on money that will not arrive',
  broker_evidence_pending: 'no P&L yet; the backfill and the position reader still own it',
  postmortem_pending: 'P&L on record; the postmortem sweep has not classified it',
})

/**
 * The latest broker lifecycle verdict for a position on an account (V3 B2),
 * or null. `final` is B2's own rule (position-lifecycle-evidence.js, N3): a
 * stored final verdict is final only under the CURRENT EVIDENCE_RULES — one
 * judged under older rules is due a re-read and labels nothing (B4 checker
 * nit 4); `staleRules` says so in the reason instead of hiding it.
 */
function lifecycleEvidence(db, accountId, positionId) {
  const pid = normPosId(positionId)
  if (accountId == null || pid == null) return null
  try {
    const e = db.prepare(`SELECT verdict, final, rules, reason, read_at FROM position_lifecycle_evidence WHERE account_id = ? AND position_id = ?`).get(String(accountId), pid)
    if (!e) return null
    const storedFinal = Number(e.final) === 1, current = Number(e.rules) === EVIDENCE_RULES
    return { verdict: e.verdict, final: storedFinal && current, staleRules: storedFinal && !current ? Number(e.rules) : null, reason: e.reason ?? null, readAt: e.read_at ?? null }
  } catch { return null } // the evidence table is optional to this reader — its absence labels nothing
}

/** PURE: the class and the stated reason for one incomplete close. */
export function classifyIncompleteClose({ missingPnl, writtenOff, writtenOffReason, writtenOffAt, evidence }) {
  const unpriceable = evidence && evidence.final && UNPRICEABLE_VERDICTS.includes(evidence.verdict)
  const finality = !evidence ? '' : evidence.final ? ' (final)' : evidence.staleRules != null ? ` (final under rules ${evidence.staleRules}, not the current ${EVIDENCE_RULES} — re-read due)` : ''
  const verdictPart = evidence ? `broker verdict ${evidence.verdict}${finality}${evidence.readAt ? ` read ${evidence.readAt}` : ''}${evidence.reason ? `: ${String(evidence.reason).slice(0, 160)}` : ''}` : null
  if (!missingPnl) return { class: 'postmortem_pending', reason: 'P&L on record; no postmortem yet' }
  if (writtenOff) {
    return {
      class: 'labelled_unrecoverable',
      reason: [`written off${writtenOffAt ? ` ${writtenOffAt}` : ''}: ${writtenOffReason ? String(writtenOffReason).slice(0, 240) : '(no reason recorded)'}`, verdictPart].filter(Boolean).join(' · '),
    }
  }
  if (unpriceable) return { class: 'labelled_unrecoverable', reason: `${verdictPart} · not written off in the ledger` }
  return { class: 'broker_evidence_pending', reason: verdictPart ? `no P&L yet · ${verdictPart}` : 'no P&L yet; no broker lifecycle verdict on record' }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ windowHours?: number, now?: number }} [opts]
 * @returns {Array<{id:number, symbol:string, side:string, closedAtMs:number, ageHours:number, missingPnl:boolean, missingPostmortem:boolean, accountId:string|null, positionId:string|null, class:string, reason:string, writtenOff:boolean, evidence:object|null}>}
 */
export function findIncompleteCloses(db, { windowHours = 48, now = Date.now() } = {}) {
  const cutoff = now - windowHours * HOUR_MS
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.closed_at_ms, t.net_pnl, t.account_id, t.ctrader_position_id,
           COALESCE(t.pnl_unresolvable, 0) AS written_off, t.pnl_unresolvable_reason, t.pnl_unresolvable_at,
           (SELECT id FROM trade_postmortems pm WHERE pm.trade_id = t.id) AS pm_id
    FROM trades t
    WHERE t.status = 'closed'
      AND t.closed_at_ms IS NOT NULL
      AND t.closed_at_ms < ?
      AND (t.net_pnl IS NULL OR (pm_id IS NULL AND t.net_pnl != 0)) -- V3 L2b W16: a flat close owes no postmortem (countFlatExemptCloses)
  `).all(cutoff)

  return rows.map(r => {
    const missingPnl = r.net_pnl == null
    const writtenOff = Number(r.written_off) === 1
    // The broker verdict is read only for a row that is missing its money:
    // a postmortem-only row is not waiting on the broker.
    const evidence = missingPnl ? lifecycleEvidence(db, r.account_id, r.ctrader_position_id) : null
    const c = classifyIncompleteClose({ missingPnl, writtenOff, writtenOffReason: r.pnl_unresolvable_reason, writtenOffAt: r.pnl_unresolvable_at, evidence })
    return {
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      closedAtMs: r.closed_at_ms,
      ageHours: Math.round((now - r.closed_at_ms) / HOUR_MS),
      missingPnl,
      missingPostmortem: r.pm_id == null,
      accountId: r.account_id == null ? null : String(r.account_id),
      positionId: normPosId(r.ctrader_position_id),
      writtenOff,
      evidence,
      class: c.class,
      reason: c.reason,
    }
  })
}

/**
 * V3 B4: closed rows with no P&L that are OUTSIDE findIncompleteCloses'
 * population because they carry no closed_at_ms (history from before that
 * column converged). They are not recovered and not counted as recovered:
 * the goal names them beside its count so the count reconciles with
 * /state/unknown-pnl. A written-off row carries its write-off reason and
 * time (B4 checker nit 3); null on a row that was never written off. null
 * when the read fails.
 */
export function findUnpricedClosesWithoutCloseStamp(db) {
  try {
    return db.prepare(`
      SELECT id, symbol, account_id, closed_at, COALESCE(pnl_unresolvable, 0) AS written_off, pnl_unresolvable_reason, pnl_unresolvable_at
        FROM trades WHERE status = 'closed' AND closed_at_ms IS NULL AND net_pnl IS NULL ORDER BY id
    `).all().map(r => ({
      id: r.id, symbol: r.symbol, accountId: r.account_id == null ? null : String(r.account_id), closedAt: r.closed_at ?? null,
      writtenOff: Number(r.written_off) === 1, writtenOffReason: r.pnl_unresolvable_reason ?? null, writtenOffAt: r.pnl_unresolvable_at ?? null,
    }))
  } catch { return null }
}

/** The labelled row's fixed tail on the Telegram line — its reason is on the goal table. */
export const LABELLED_LINE_SUFFIX = ' — labelled unrecoverable (reason on /state/goal-table)'

/**
 * One line per incomplete close: what is missing and, for a labelled row,
 * THAT it cannot come — not why. The reason is 400–560 characters in
 * production (the write-off text plus the broker verdict); twenty of them
 * took the Telegram alert past its 4,096-character limit, which Telegram
 * REJECTS rather than truncates, and the sweep swallows the rejection — an
 * alert that stops arriving with no error (B4 checker blocker 1, failure
 * mode #3). The line points at where the reason is served instead.
 */
export function incompleteCloseLine(t) {
  const gap = [t.missingPnl && 'no P&L', t.missingPostmortem && 'no postmortem'].filter(Boolean).join(', ')
  const why = t.class === 'labelled_unrecoverable' ? LABELLED_LINE_SUFFIX : ''
  return `#${t.id} ${t.symbol} ${t.side} — closed ${t.ageHours}h ago, still ${gap}${why}`
}

/**
 * The alert's character budget. Telegram rejects a message over 4,096
 * characters (telegram-digest.js TG_TEXT_MAX) and sendMessageRaw appends the
 * version footer AFTER this text, so the budget leaves the same margin the
 * daily report does (DAILY_REPORT_MAX_CHARS).
 */
export const CLOSE_ALERT_MAX_CHARS = 3_800
const MORE_TAIL_ROOM = 24 // '\n+N more.' for any N this table can hold

/**
 * PURE: the "never finished processing" alert. At most `maxLines` rows are
 * listed and never past `maxChars`; every row not listed is counted in
 * "+N more.", so listed + more = the whole stuck count. null when nothing is
 * stuck.
 */
export function buildIncompleteCloseAlert(stuck, { maxChars = CLOSE_ALERT_MAX_CHARS, maxLines = 20 } = {}) {
  if (!Array.isArray(stuck) || stuck.length === 0) return null
  const head = `⚠️ ${stuck.length} closed trade(s) never finished processing:`
  const lines = []
  let len = head.length
  for (const t of stuck.slice(0, maxLines)) {
    const line = incompleteCloseLine(t)
    if (len + 1 + line.length + MORE_TAIL_ROOM > maxChars) break
    lines.push(line)
    len += 1 + line.length
  }
  const rest = stuck.length - lines.length
  const text = [head, ...lines, rest > 0 && `+${rest} more.`].filter(Boolean).join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

/**
 * One Telegram line per stuck trade — visible instead of silently pending
 * forever. No-op (and no import of telegram.js) when there's nothing to
 * report or no bot token is configured.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ windowHours?: number, now?: number }} [opts]
 * @returns {Promise<{ flagged: number }>}
 */
export async function runCloseCompletenessSweep(db, opts = {}) {
  const stuck = findIncompleteCloses(db, opts)
  if (stuck.length === 0 || !process.env.TELEGRAM_BOT_TOKEN) return { flagged: stuck.length }

  try {
    const { sendMessage } = await import('./telegram.js')
    await sendMessage(buildIncompleteCloseAlert(stuck))
  } catch { /* alert best-effort — the sweep itself already ran */ }
  return { flagged: stuck.length }
}

/**
 * V3 L2b W16 — THE POSTMORTEM EXEMPTION, COUNTED WHERE IT IS APPLIED.
 *
 * A close whose broker net P&L is exactly 0 has no outcome to classify, and
 * the postmortem sweep has always skipped it (loss-postmortem.js
 * `postmortemExemption`, the one definition). findIncompleteCloses still
 * counted it "missing a postmortem", so every flat close sat in the
 * close_completeness goal and the Telegram "never finished processing" list
 * for ever — a stuck record nothing could ever settle. It is no longer
 * counted as incomplete; it is counted HERE instead, so the goal names how
 * many closes the exemption covers rather than dropping them from view.
 * Same window and grace as findIncompleteCloses. null when the read fails —
 * never a zero that did not come from a count.
 */
export function countFlatExemptCloses(db, { windowHours = 48, now = Date.now() } = {}) {
  try {
    return db.prepare(`
      SELECT COUNT(*) AS n FROM trades t
       WHERE t.status = 'closed' AND t.closed_at_ms IS NOT NULL AND t.closed_at_ms < ?
         AND t.net_pnl IS NOT NULL AND t.net_pnl = 0
         AND NOT EXISTS (SELECT 1 FROM trade_postmortems pm WHERE pm.trade_id = t.id)
    `).get(now - windowHours * HOUR_MS).n
  } catch { return null }
}
