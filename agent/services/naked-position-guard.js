// Is every open position actually protected RIGHT NOW?
//
// WHY THIS EXISTS (owner report, 2026-07-29). An ETHUSD short closed carrying
// the reason "stopped beyond the SL — gap/slippage through the stop". It had
// no stop loss at all: `sl_price` was NULL, and reconciler.js's classifier
// read `Number(null)` as 0 rather than "absent", so `exit > 0` was true for
// every short and stamped a stop that never existed. That bug is fixed at its
// source. This module addresses the larger gap the owner actually pointed at.
//
// The system had guards for the MOMENT of action and none for the STATE:
//
//   · risk.js refuses to open without a bracket
//   · manual-position-guards.js refuses to ADD to a naked position
//   · /actions/position-protect can attach a bracket on demand
//
// but nothing ever asked, of the positions already open, "is this one still
// protected?" A bracket can go missing after entry — an amend that failed, a
// broker-side cancellation, a position adopted from the broker that never had
// one, a partial close that dropped the remainder's stop. Every one of those
// leaves capital exposed silently, and the ledger's own close reason was
// actively reassuring about it.
//
// BROKER TRUTH, NOT OUR BOOKKEEPING. Reading `monitored_positions.current_sl`
// alone would only prove we THINK there is a stop. What protects money is the
// stop the broker is holding, so `brokerPositions` (already fetched every
// reconcile pass) is the authority, and a disagreement between the two is
// itself reportable — arguably the more dangerous state, because the UI shows
// a stop that will not fire.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TAKE-PROFIT REQUIREMENT, APPLIED TO POSITIONS WE DID NOT OPEN
//
// exec-engine.js refuses a market order with no take profit attached
// (`guard_no_target`, owner-approved 2026-07-22: SL-only was never enough to
// call a trade managed). But that guard fires at SUBMISSION, and an ADOPTED
// position never passes through it — the reconciler takes it from broker
// truth, brackets and all, or brackets and none. So the one rule the owner
// asked for most explicitly was the one rule adopted positions were exempt
// from. The 0003.HK pair found on 2026-07-29 had stops and no targets.
//
// It cannot be enforced retroactively — a position is already open — so the
// equivalent is to detect it and say so. What this deliberately does NOT do:
//
//   · attach a target itself. Choosing a take-profit price is a strategy
//     judgement (structure, R-multiple, session). A guessed one closes trades
//     at a level nothing supports, which is worse than none at all.
//   · report a take-profit DISAGREEMENT the way it reports a stop
//     disagreement. Targets are amended constantly in normal operation — the
//     profit keeper ratchets them, partial ladders move them — so a mismatch
//     check would fire during ordinary work. A check that cries wolf during
//     normal operation trains the owner to ignore it, which is the same
//     outcome as not having it. MISSING is unambiguous; different is not.
// ─────────────────────────────────────────────────────────────────────────────
import { getState, setState } from '../db.js'

/** Alert at most this often per position, so a persistent gap does not spam. */
const MUTE_MS = Math.max(60_000, Number(process.env.NAKED_ALERT_MUTE_MS) || 3600_000)

// A missing target is a management gap, not live unbounded risk — the stop
// still caps the loss. So it alerts on a slower cadence than a naked position,
// and never with the siren.
const TARGET_MUTE_MS = Math.max(60_000, Number(process.env.TARGETLESS_ALERT_MUTE_MS) || 6 * 3600_000)

const num = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null))

/**
 * Compare our open book against broker truth.
 *
 * @param {Array} openRows   rows with { id, symbol, trade_id, ctrader_position_id, current_sl, account_id, source }
 * @param {Array} brokerPositions  [{ positionId, stopLoss, takeProfit }]
 * @returns {{naked:Array, targetless:Array, phantom:Array, checked:number, unmatched:number}}
 *   naked      — no stop at the broker: real, live, unprotected exposure
 *   targetless — stop present, no take profit: the order-time rule, unmet
 *   phantom    — we show a stop the broker is not holding: the UI is lying
 */
export function auditProtection(openRows = [], brokerPositions = []) {
  const byId = new Map()
  for (const p of brokerPositions || []) {
    if (p?.positionId != null) byId.set(String(p.positionId), p)
  }

  const naked = []
  const targetless = []
  const phantom = []
  let unmatched = 0

  for (const row of openRows) {
    const pid = row?.ctrader_position_id == null ? null : String(row.ctrader_position_id)
    const bp = pid ? byId.get(pid) : null
    if (!bp) {
      // No broker position to compare against. NOT reported as naked: the
      // reconciler owns "open here, absent there" and calling it unprotected
      // would double-report a different fault as this one.
      unmatched++
      continue
    }
    const brokerSl = num(bp.stopLoss)
    const ourSl = num(row.current_sl)

    if (brokerSl == null || brokerSl === 0) {
      naked.push({
        monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
        positionId: pid, accountId: row.account_id ?? null,
        ourSl,
        detail: ourSl != null
          // The worse of the two: our book shows protection, the broker holds
          // none. Anyone reading the UI believes this position is covered.
          ? `we show a stop at ${ourSl} but the broker holds NONE — this position is unprotected and the UI says otherwise`
          : 'no stop loss at the broker and none on record — this position is unprotected',
      })
    } else {
      if (ourSl != null && Math.abs(brokerSl - ourSl) > Math.abs(brokerSl) * 0.001) {
        phantom.push({
          monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
          positionId: pid, accountId: row.account_id ?? null,
          ourSl, brokerSl,
          detail: `stop disagreement — we show ${ourSl}, the broker holds ${brokerSl}`,
        })
      }
      // Only asked of positions that HAVE a stop. A naked position needs a
      // stop first; adding "and no target either" underneath the siren is
      // noise on top of an emergency.
      const brokerTp = num(bp.takeProfit)
      if (brokerTp == null || brokerTp === 0) {
        const src = row.source || 'unknown'
        targetless.push({
          monitoredId: row.id, tradeId: row.trade_id ?? null, symbol: row.symbol,
          positionId: pid, accountId: row.account_id ?? null,
          source: src, brokerSl,
          detail: src === 'external'
            // Opened by hand at the broker, so it never met the order-time
            // rule and arguably was never meant to. Still reported — the
            // owner asked to see unmanaged exposure, not just the bot's.
            ? `no take profit at the broker (opened outside the bot) — stop at ${brokerSl}, no target`
            : `no take profit at the broker — an order placed through the bot could not have been submitted this way (guard_no_target); this one was adopted, so the guard never saw it`,
        })
      }
    }
  }
  return { naked, targetless, phantom, checked: openRows.length, unmatched }
}

/** Which findings are due an alert, given the mute window. Pure — testable. */
export function dueForAlert(findings, lastAlertMap, nowMs, muteMs = MUTE_MS) {
  return findings.filter(f => {
    const last = Number(lastAlertMap?.[String(f.positionId)] || 0)
    return !(last > 0) || (nowMs - last) >= muteMs
  })
}

const STATE_KEY = 'naked_position_alerts_json'
const TARGET_STATE_KEY = 'targetless_position_alerts_json'
const LAST_AUDIT_KEY = 'protection_audit_last_json'

/**
 * Each account is audited against its OWN broker snapshot, so each needs its
 * own record — a single global key would mean whichever account ran last
 * silently overwrote the rest, and the panel would report one account's book
 * as if it were the whole one.
 */
const auditKeyFor = (accountId) =>
  (accountId == null || accountId === '' ? LAST_AUDIT_KEY : `acct:${accountId}:${LAST_AUDIT_KEY}`)

/**
 * Run the audit, record it, and alert on anything newly unprotected.
 *
 * Never throws: a protection AUDIT that can crash the loop would remove more
 * safety than it adds.
 */
export async function runProtectionAudit(db, openRows, brokerPositions, {
  nowMs = Date.now(), sendMessage = null, muteMs = MUTE_MS, targetMuteMs = TARGET_MUTE_MS,
  accountId = null, suggestTarget = null,
} = {}) {
  try {
    const audit = auditProtection(openRows, brokerPositions)

    const readMap = (key) => {
      try { return JSON.parse(getState(db, key) || '{}') } catch { return {} }
    }
    const lastAlerts = readMap(STATE_KEY)
    const lastTargetAlerts = readMap(TARGET_STATE_KEY)

    const due = dueForAlert(audit.naked, lastAlerts, nowMs, muteMs)
    const targetDue = dueForAlert(audit.targetless, lastTargetAlerts, nowMs, targetMuteMs)

    const KIND = new Map()
    for (const f of audit.naked) KIND.set(f, 'POSITION_UNPROTECTED')
    for (const f of audit.targetless) KIND.set(f, 'POSITION_NO_TARGET')
    for (const f of audit.phantom) KIND.set(f, 'POSITION_STOP_MISMATCH')

    for (const [f, method] of KIND) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          method, '/protection-audit', JSON.stringify(f).slice(0, 2000),
        )
      } catch { /* audit best-effort */ }
    }

    if (due.length && typeof sendMessage === 'function') {
      const lines = due.map(f => `· ${f.symbol} (position ${f.positionId}) — ${f.detail}`)
      try {
        await sendMessage(
          `\u{1F6A8} ${due.length} OPEN POSITION${due.length > 1 ? 'S' : ''} WITH NO STOP LOSS\n${lines.join('\n')}\n\nSet one with POST /actions/position-protect, or close the position.`
        )
        for (const f of due) lastAlerts[String(f.positionId)] = nowMs
      } catch { /* a failed alert must not lose the audit */ }
    }

    // Separate message, no siren: a stop is in place, so this is a management
    // gap rather than an emergency. Batched into one so a book with several
    // targetless positions produces one line per position, not one alert each.
    if (targetDue.length && typeof sendMessage === 'function') {
      // Owner 01-08: propose a concrete price with a one-tap Set-TP button
      // instead of only pointing at the curl. The suggestion is computed HERE,
      // only for alerts actually going out (≤ once per position per 6h mute),
      // so the underlying bar fetch is rare. A null suggestion degrades to the
      // original instruction-only line — the alert never waits on structure.
      const suggestions = new Map()
      if (typeof suggestTarget === 'function') {
        for (const f of targetDue) {
          try {
            const s = await suggestTarget(f)
            if (s && Number(s.tp) > 0) suggestions.set(f, s)
          } catch { /* a failed suggestion must not lose the alert */ }
        }
      }
      const lines = targetDue.map(f => {
        const s = suggestions.get(f)
        return `· ${f.symbol} (position ${f.positionId}) — stop ${f.brokerSl}, no target${f.source === 'external' ? ' · opened outside the bot' : ''}` +
          (s ? `\n  suggested TP ${s.tp} (${s.basis})` : '')
      })
      // One button row per suggested position. callback_data is capped at 64
      // bytes by Telegram — `prottp|<id>|<price>` fits comfortably.
      const buttons = targetDue
        .filter(f => suggestions.has(f))
        .map(f => [{ text: `Set TP ${suggestions.get(f).tp} on ${f.symbol}`, callback_data: `prottp|${f.positionId}|${suggestions.get(f).tp}` }])
      try {
        await sendMessage(
          `\u{26A0}\u{FE0F} ${targetDue.length} OPEN POSITION${targetDue.length > 1 ? 'S' : ''} WITH NO TAKE PROFIT\n${lines.join('\n')}\n\nThe order path refuses to submit these (guard_no_target) — these were adopted from the broker, so the guard never saw them. Tap a button below, or set your own with POST /actions/position-protect {positionId, tp}.`,
          buttons.length ? { buttons } : undefined,
        )
        for (const f of targetDue) lastTargetAlerts[String(f.positionId)] = nowMs
      } catch { /* a failed alert must not lose the audit */ }
    }

    // Forget positions that are no longer open, so the mute maps cannot grow
    // without bound across a long-running process.
    const prune = (map, findings) => {
      const live = new Set(findings.map(f => String(f.positionId)))
      for (const k of Object.keys(map)) if (!live.has(k)) delete map[k]
    }
    prune(lastAlerts, audit.naked)
    prune(lastTargetAlerts, audit.targetless)
    try {
      setState(db, STATE_KEY, JSON.stringify(lastAlerts))
      setState(db, TARGET_STATE_KEY, JSON.stringify(lastTargetAlerts))
    } catch { /* non-fatal */ }

    // ¶D·2 — the audit must never simply go quiet. See recordAuditUnavailable.
    try {
      setState(db, auditKeyFor(accountId), JSON.stringify({
        at: new Date(nowMs).toISOString(),
        ok: true,
        accountId: accountId == null ? null : String(accountId),
        checked: audit.checked,
        unmatched: audit.unmatched,
        naked: audit.naked.length,
        targetless: audit.targetless.length,
        phantom: audit.phantom.length,
      }))
    } catch { /* non-fatal */ }

    return { ...audit, alerted: due.length, targetAlerted: targetDue.length }
  } catch (err) {
    return {
      naked: [], targetless: [], phantom: [], checked: 0, unmatched: 0,
      alerted: 0, targetAlerted: 0, error: err.message,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ¶D·2 — "Position protection audit — idle."
//
// That is what the owner saw during the 2026-07-29 broker outage, and it is
// the wrong thing to see. The audit lives inside the reconcile phase and only
// runs once broker truth is in hand; when the broker was unreachable it did
// not run, so it reported nothing — which on screen is indistinguishable from
// "checked everything, all clear". A safety check that goes silent exactly
// when the system is degraded is worse than one that was never built, because
// the silence reads as reassurance.
//
// So: every outcome is recorded, including "could not check", and the reader
// always gets the LAST KNOWN state with its AGE attached. Old news labelled as
// old news is honest. A blank is not.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record that the audit could not run this cycle, and why.
 * Called from the loop when broker truth never arrived.
 */
export function recordAuditUnavailable(db, reason, { nowMs = Date.now(), accountId = null } = {}) {
  const key = auditKeyFor(accountId)
  let prev = {}
  try { prev = JSON.parse(getState(db, key) || '{}') } catch { prev = {} }
  try {
    setState(db, key, JSON.stringify({
      // The last SUCCESSFUL check is preserved verbatim — that is the state
      // the reader needs, and overwriting it with the failure would destroy
      // the only thing worth reporting during an outage.
      ...(prev.ok ? prev : { ...prev, at: prev.at ?? null }),
      ok: prev.ok === true,
      lastAttemptAt: new Date(nowMs).toISOString(),
      lastAttemptOk: false,
      lastAttemptError: String(reason || 'unknown').slice(0, 300),
    }))
  } catch { /* non-fatal */ }
}

/** Sum every per-account audit record into one whole-book view. */
function mergeAccountAudits(db) {
  let rows = []
  try {
    rows = db.prepare(
      `SELECT key, value FROM agent_state
        WHERE key = ? OR key LIKE 'acct:%:' || ?`
    ).all(LAST_AUDIT_KEY, LAST_AUDIT_KEY)
  } catch { return {} }

  const parsed = []
  for (const r of rows) {
    try { const v = JSON.parse(r.value || '{}'); if (v && typeof v === 'object') parsed.push(v) } catch { /* skip junk */ }
  }
  if (!parsed.length) return {}
  const ran = parsed.filter(p => p.ok === true && p.at)
  if (!ran.length) {
    // Nothing has completed anywhere — surface the most recent failure so the
    // reason is visible rather than a bare "never run".
    const failed = parsed.filter(p => p.lastAttemptAt).sort((a, b) => String(b.lastAttemptAt).localeCompare(String(a.lastAttemptAt)))
    return failed[0] || parsed[0]
  }
  const sum = (k) => ran.reduce((n, p) => n + (Number(p[k]) || 0), 0)
  const oldest = ran.map(p => p.at).sort()[0]
  const stillFailing = parsed.find(p => p.lastAttemptOk === false)
  return {
    at: oldest, ok: true,
    accounts: ran.length,
    checked: sum('checked'), unmatched: sum('unmatched'),
    naked: sum('naked'), targetless: sum('targetless'), phantom: sum('phantom'),
    ...(stillFailing ? {
      lastAttemptAt: stillFailing.lastAttemptAt,
      lastAttemptOk: false,
      lastAttemptError: stillFailing.lastAttemptError,
    } : {}),
  }
}

/**
 * The last known protection state, with its age and whether it is stale.
 * Never returns an empty/blank answer — see the header above.
 *
 * @param {number} expectedSec  how often the audit is expected to run
 *   (reconcile is every 3rd loop, so the caller passes loopSec × 3)
 */
export function lastProtectionAudit(db, { nowMs = Date.now(), expectedSec = 900, staleFactor = 3, accountId = null } = {}) {
  let last = {}
  if (accountId != null) {
    try { last = JSON.parse(getState(db, auditKeyFor(accountId)) || '{}') } catch { last = {} }
  } else {
    // No account asked for: report the WHOLE book by summing every account's
    // record. Age is taken from the OLDEST of them, because a portfolio is
    // only as freshly verified as its stalest account — reporting the newest
    // would let one healthy account mask five unchecked ones.
    last = mergeAccountAudits(db)
  }

  const at = Date.parse(last.at || '')
  const hasRun = Number.isFinite(at)
  const ageSec = hasRun ? Math.max(0, Math.round((nowMs - at) / 1000)) : null
  const stale = !hasRun || ageSec > expectedSec * staleFactor

  const attemptFailed = last.lastAttemptOk === false
  const mins = ageSec == null ? null : Math.round(ageSec / 60)

  let summary
  if (!hasRun) {
    // The critical case. NOT "idle" — idle sounds like a resting state, and
    // this one means no position has ever been verified as protected.
    summary = attemptFailed
      ? `never completed — last attempt failed: ${last.lastAttemptError}`
      : 'never run — no open position has been verified as protected'
  } else {
    const found = [
      last.naked ? `${last.naked} with NO stop` : null,
      last.targetless ? `${last.targetless} with no take profit` : null,
      last.phantom ? `${last.phantom} stop disagreement${last.phantom > 1 ? 's' : ''}` : null,
    ].filter(Boolean)

    // UNMATCHED IS NOT "FINE". A row the broker snapshot never mentioned was
    // not verified — it was skipped. Saying "all protected" while every row
    // went unmatched is the precise false reassurance this module exists to
    // prevent, and it is what staging reported on 2026-07-29 03:19:
    // "4 position(s) checked, all protected" when all four were unmatched
    // because the snapshot belonged to a different account.
    const checked = Number(last.checked) || 0
    const unmatched = Number(last.unmatched) || 0
    const verified = Math.max(0, checked - unmatched)

    let body
    if (checked > 0 && verified === 0) {
      body = `${checked} position(s) open but NONE could be checked against broker truth — nothing is verified`
    } else if (found.length) {
      body = `${verified} of ${checked} position(s) verified — ${found.join(', ')}`
    } else {
      body = unmatched > 0
        ? `${verified} of ${checked} position(s) verified, all protected — ${unmatched} could not be matched to broker truth`
        : `${checked} position(s) checked, all protected`
    }
    const age = `${mins} min ago`
    summary = attemptFailed
      // The whole point: say what is known AND that it is no longer being
      // confirmed, in one line, rather than showing nothing.
      ? `${body} (as of ${age}) — NOT CONFIRMED SINCE: ${last.lastAttemptError}`
      : `${body} (${age})`
  }

  return {
    hasRun,
    ok: last.ok === true,
    // How many accounts this figure covers, when it is a whole-book read.
    accounts: last.accounts ?? null,
    at: hasRun ? last.at : null,
    ageSec,
    stale,
    checked: last.checked ?? null,
    naked: last.naked ?? null,
    targetless: last.targetless ?? null,
    phantom: last.phantom ?? null,
    unmatched: last.unmatched ?? null,
    lastAttemptAt: last.lastAttemptAt ?? null,
    lastAttemptOk: last.lastAttemptOk ?? null,
    lastAttemptError: last.lastAttemptError ?? null,
    summary,
  }
}
