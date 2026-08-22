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
// equivalent is to detect it and, since 04-08-2026, to FIX it.
//
// THAT LAST PART REVERSES A DECISION MADE HERE, and the reversal is the point.
// This module used to say, in as many words, that it would not attach a target
// itself: "choosing a take-profit price is a strategy judgement … a guessed one
// closes trades at a level nothing supports, which is worse than none at all."
// That was right about guessing and wrong about the conclusion, because the
// alternative shipped was not "a human decides" — it was a Telegram button
// nobody taps. Owner, 04-08-2026: "SO MANY POSITIONS WITH NO TARGET SET",
// pasting six. §43 requires protection to have its own functioning path, and a
// target that materialises only if someone happens to be looking at their phone
// is not one.
//
// What changed underneath is that the guess is gone: tp-suggest.js computes a
// target from real volume structure (the HVN work, #163), and the alert has
// been printing it for days. Applying the number we already trust enough to
// recommend is a smaller step than continuing to recommend it and do nothing.
//
// STILL DELIBERATELY NOT DONE:
//
//   · touching a position opened OUTSIDE the bot (`source === 'external'`).
//     That is the owner's own trade and their own exit; choosing one for them
//     is overruling a decision nobody asked us about.
//   · inventing a target when the suggester returns nothing. No target is
//     better than an unsupported one — that half of the original reasoning
//     stands unchanged.
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
const LOG_STATE_KEY = 'protection_log_writes_json'
const LAST_AUDIT_KEY = 'protection_audit_last_json'

/** How often one position+kind may re-enter action_log. See the write loop. */
const LOG_MUTE_MS = Math.max(60_000, Number(process.env.PROTECTION_LOG_MUTE_MS) || 3600_000)

/**
 * Each account is audited against its OWN broker snapshot, so each needs its
 * own record — a single global key would mean whichever account ran last
 * silently overwrote the rest, and the panel would report one account's book
 * as if it were the whole one.
 */
const auditKeyFor = (accountId) =>
  (accountId == null || accountId === '' ? LAST_AUDIT_KEY : `acct:${accountId}:${LAST_AUDIT_KEY}`)

/**
 * THE MUTE MAPS ARE PER ACCOUNT TOO — and for a sharper reason than the audit
 * record above (owner, 04-08-2026: three targetless alerts pasted back, two of
 * them the identical USDBRL position).
 *
 * They were global while this pass runs once per account, and the prune step at
 * the end of the pass deletes every entry whose position is not in THIS pass's
 * findings. So account A alerted and stamped its ids, then account B's pass
 * pruned them away as "no longer open" — and A re-alerted on the next cycle,
 * for ever. The mute window was not merely leaky; between two accounts it was
 * cancelled outright.
 *
 * Scoping the map makes the prune correct by construction: a pass only ever
 * sees, stamps and prunes the account it is auditing.
 */
const muteKeyFor = (accountId, key) =>
  (accountId == null || accountId === '' ? key : `acct:${accountId}:${key}`)

/**
 * Run the audit, record it, and alert on anything newly unprotected.
 *
 * Never throws: a protection AUDIT that can crash the loop would remove more
 * safety than it adds.
 */
export async function runProtectionAudit(db, openRows, brokerPositions, {
  nowMs = Date.now(), sendMessage = null, muteMs = MUTE_MS, targetMuteMs = TARGET_MUTE_MS,
  logMuteMs = LOG_MUTE_MS, accountId = null, suggestTarget = null, applyTarget = null,
} = {}) {
  try {
    const audit = auditProtection(openRows, brokerPositions)

    const readMap = (key) => {
      try { return JSON.parse(getState(db, key) || '{}') } catch { return {} }
    }
    const lastAlerts = readMap(muteKeyFor(accountId, STATE_KEY))
    const lastTargetAlerts = readMap(muteKeyFor(accountId, TARGET_STATE_KEY))

    const due = dueForAlert(audit.naked, lastAlerts, nowMs, muteMs)
    const targetDue = dueForAlert(audit.targetless, lastTargetAlerts, nowMs, targetMuteMs)

    const KIND = new Map()
    for (const f of audit.naked) KIND.set(f, 'POSITION_UNPROTECTED')
    for (const f of audit.targetless) KIND.set(f, 'POSITION_NO_TARGET')
    for (const f of audit.phantom) KIND.set(f, 'POSITION_STOP_MISMATCH')

    // THE DURABLE TRAIL IS RATE-LIMITED TOO. It was not: the mute windows
    // above gate Telegram only, so this loop wrote a row for EVERY finding on
    // EVERY pass. protection_audit is loop-tied, so one standing condition
    // emitted a row every few minutes for as long as it lasted —
    // POSITION_STOP_MISMATCH in particular, because until the reconciler
    // learned to converge a standing disagreement (see reconciler.js) nothing
    // could ever clear it, so it logged forever.
    //
    // One row per position per kind per LOG_MUTE_MS still reconstructs
    // duration — a position naked for six hours leaves six rows, which is
    // enough to answer "how long was it exposed" — while a page of
    // action_log stops being one position repeating itself.
    const logMutes = readMap(muteKeyFor(accountId, LOG_STATE_KEY))
    for (const [f, method] of KIND) {
      const key = `${method}|${f.positionId}`
      const last = Number(logMutes[key] || 0)
      if (last > 0 && (nowMs - last) < logMuteMs) continue
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(
          method, '/protection-audit', JSON.stringify(f).slice(0, 2000),
        )
        logMutes[key] = nowMs
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
      // APPLY IT, DON'T ONLY ASK (owner, 04-08-2026: "SO MANY POSITIONS WITH
      // NO TARGET SET"). §43 says protection must have its own functioning
      // path; a target that exists only if a human taps a Telegram button is
      // not one, and the owner's own policy has required a TP at order time
      // since #23 — an adopted position is the same position, arriving by a
      // different door.
      //
      // BOUNDED DELIBERATELY. Only positions the bot owns: `source === 'external'`
      // is the owner's own hand-placed trade, and choosing an exit for it would
      // be the bot overruling a human decision it was never asked about. Only
      // when a suggestion actually computed — no target is better than an
      // invented one. And a TP can only ever close in profit, so the worst case
      // is a suboptimal exit, never a loss the position would not otherwise
      // have taken.
      const applied = new Map()
      if (typeof applyTarget === 'function') {
        for (const f of targetDue) {
          if (f.source === 'external') continue
          const s = suggestions.get(f)
          if (!s || !(Number(s.tp) > 0)) continue
          try {
            const r = await applyTarget(f, s)
            if (r && r.ok) applied.set(f, s)
          } catch { /* a failed amend must not lose the alert — it still tells the owner */ }
        }
      }
      const lines = targetDue.map(f => {
        const s = suggestions.get(f)
        if (applied.has(f)) return `· ${f.symbol} (position ${f.positionId}) — TP SET to ${s.tp} (${s.basis})`
        return `· ${f.symbol} (position ${f.positionId}) — stop ${f.brokerSl}, no target${f.source === 'external' ? ' · opened outside the bot, left alone' : ''}` +
          (s ? `\n  suggested TP ${s.tp} (${s.basis})` : '')
      })
      // One button row per suggested position. callback_data is capped at 64
      // bytes by Telegram — `prottp|<id>|<price>` fits comfortably.
      // No button for a target already set — offering to do what was just done
      // is how an operator learns to distrust the buttons.
      const buttons = targetDue
        .filter(f => suggestions.has(f) && !applied.has(f))
        .map(f => [{ text: `Set TP ${suggestions.get(f).tp} on ${f.symbol}`, callback_data: `prottp|${f.positionId}|${suggestions.get(f).tp}` }])
      try {
        await sendMessage(
          `\u{26A0}\u{FE0F} ${targetDue.length} OPEN POSITION${targetDue.length > 1 ? 'S' : ''} WITH NO TAKE PROFIT${applied.size ? ` — ${applied.size} SET AUTOMATICALLY` : ''}\n${lines.join('\n')}\n\nThese were adopted from the broker, so the entry guard never saw them. The bot now sets a target on its OWN adopted positions where it can compute one; anything opened outside the bot is left for you. Tap a button below, or set your own with POST /actions/position-protect {positionId, tp}.`,
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
    // Same bound for the log mutes, but keyed `KIND|positionId`, so drop any
    // key whose finding is no longer present in THIS pass — a position that
    // gets its stop back should log immediately if it ever loses it again.
    {
      const live = new Set([...KIND].map(([f, method]) => `${method}|${f.positionId}`))
      for (const k of Object.keys(logMutes)) if (!live.has(k)) delete logMutes[k]
    }
    try {
      setState(db, muteKeyFor(accountId, STATE_KEY), JSON.stringify(lastAlerts))
      setState(db, muteKeyFor(accountId, TARGET_STATE_KEY), JSON.stringify(lastTargetAlerts))
      setState(db, muteKeyFor(accountId, LOG_STATE_KEY), JSON.stringify(logMutes))
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

// ---------------------------------------------------------------------------
// PROTECTION AUDIT ON ITS OWN PATH — every enabled account, off the main loop.
//
// Operating Goal Plan §43, the one Non-Negotiable Rule:
//
//   "A position must never be considered safely managed merely because the
//    main strategy loop is running. Protection, active management, broker
//    reconciliation and emergency authority must each have their own
//    functioning and observable path."
//
// The audit did not have one. It ran inside the loop's per-account reconcile
// block, sharing a heartbeat with order_monitor, and both went stalled at the
// same instant on 2026-08-04 — 961s old against a 314s expectation — because
// the phase that carries them had not completed. §70.7 names this exact
// failure: "Ensure the five-minute strategy loop is never the sole position
// protector."
//
// This is that second path. It runs from the fast monitor, which has its own
// 3-second ticker, its own overlap guard, and no dependency on the loop — it
// is in fact where the loop's OWN watchdog lives, so it keeps running when
// the loop is wedged. Cadence is a wall clock, not a tick count.
//
// The loop-side audit is deliberately LEFT IN PLACE. Two paths asking "is this
// position still protected" is the point; the audit only reads and alerts, so
// a duplicate pass costs a muted alert at worst, and §43 asks for redundancy
// rather than a handover.
//
// Per-account, against that account's OWN broker snapshot. Auditing every
// account's rows against one account's positions marks the rest `unmatched` —
// checked but never verified — which staging showed on 2026-07-29 as
// "all protected" over four unaudited positions.
// Broker refusals that mean "this credential cannot reach that account" —
// never "that account is in trouble". Kept narrow on purpose: anything not
// listed here is treated as a real audit failure, which is the safe default.
const UNAUTHORISED_CODES = [
  'CH_ACCESS_TOKEN_INVALID', 'CH_ACCESS_TOKEN_EXPIRED', 'ACCOUNT_NOT_AUTHORIZED',
  'NOT_AUTHENTICATED', 'CH_CLIENT_AUTH_FAILURE',
  // ADDED 08-08-2026. `CANT_ROUTE_REQUEST` is the broker refusing to route to
  // an account this session was never authorised for — the disabled LIVE
  // account 42993489, which is still swept because `manage_only` accounts hold
  // open positions and dropping them from the audit would stop checking whether
  // those positions have stops. So it belongs in the same class as the token
  // codes above: a fact about ACCESS, not about exposure. Left out of the list,
  // it counted as a real audit failure and parked protection_audit in `warn` —
  // the "always amber, so nobody reads it" failure this list exists to prevent.
  'CANT_ROUTE_REQUEST',
]
const UNAUDITABLE_RE = new RegExp(UNAUTHORISED_CODES.join('|'))

/**
 * @returns {{accounts:number, naked:number, targetless:number, phantom:number,
 *            errors:string[], unauditable:string[]}}
 */
export async function runProtectionAuditAllAccounts(db, baseCreds, deps = {}) {
  const out = { accounts: 0, naked: 0, targetless: 0, phantom: 0, targetsRestored: 0, errors: [], unauditable: [], blind: false }
  if (!baseCreds?.ready) return out

  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const { getEnabledAccounts } = await import('./account-registry.js')

  let roster = []
  try {
    // One credential set reaches one host: a demo token cannot read a live
    // account's positions, so only the same side is swept.
    const isLive = !!baseCreds.isLive
    roster = getEnabledAccounts(db)
      .filter(a => (a.is_live === 1) === isLive)
      .map(a => String(a.account_id))
  } catch { roster = [] }

  const primary = baseCreds.accountId != null ? String(baseCreds.accountId) : null
  const ids = [...new Set([...(primary ? [primary] : []), ...roster])]
  if (!ids.length) return out

  // THE NUMERATOR MUST COUNT THE SAME SET AS THE DENOMINATOR (review, 08-08).
  // `out.accounts` counts any id in `ids` that reconciled, and `ids` prepends
  // `primary` with no enabled test — so one reachable NON-roster account defeats
  // `blind` for the whole obliged set: a disabled-but-selected account
  // reconciles fine (the sidecar authorises it, ctrader-creds.js:45), every
  // ENABLED account is refused, and the sweep beats green having verified
  // nothing it was obliged to verify. One account short of the alarm firing.
  const obliged = new Set(roster)
  let reachedObliged = 0

  const stmt = db.prepare(
    // current_tp / side / entry_price are read by services/target-restore.js:
    // the recorded target it may put back, and the two fields that prove the
    // target is the right side of the entry. Without them the restore plan
    // skips every position for want of data it was never given — a repair
    // out of reach of what it repairs.
    `SELECT mp.id, mp.trade_id, mp.symbol, mp.current_sl, mp.current_tp, mp.side,
            mp.entry_price, mp.account_id, mp.source,
            t.ctrader_position_id
       FROM monitored_positions mp
       LEFT JOIN trades t ON t.id = mp.trade_id
      WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL
        AND (mp.account_id = ? OR mp.account_id IS NULL)`
  )

  for (const id of ids) {
    try {
      const creds = id === primary ? baseCreds : { ...baseCreds, accountId: id }
      if (!creds?.ready) continue
      const rec = await exec.reconcile(creds)
      const positions = rec?.position || []
      const openRows = stmt.all(String(id))
      // No local rows AND no broker positions is a genuinely clean account —
      // but a broker position with no local row is exactly what the audit is
      // for, so an empty openRows does not skip the pass.
      if (!openRows.length && !positions.length) { out.accounts++; if (obliged.has(String(id))) reachedObliged++; continue }
      const brokerSl = positions.map(p => ({
        positionId: p.positionId,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
      }))
      let sendMessage = null
      if (process.env.TELEGRAM_BOT_TOKEN) {
        sendMessage = (await import('./telegram.js')).sendMessage
      }
      const prot = await runProtectionAudit(db, openRows, brokerSl, {
        sendMessage, accountId: id, ...(deps.auditOpts || {}),
      })
      out.accounts++
      if (obliged.has(String(id))) reachedObliged++
      out.naked += prot.naked.length
      out.targetless += prot.targetless.length
      out.phantom += prot.phantom.length

      // PUT BACK WHAT WAS LOST. #748 stopped targets being deleted; positions
      // stripped before it deployed stay stripped until something acts. The
      // audit is where the fact is already known, so it is where the repair
      // belongs — reporting it forever while holding the position id, the
      // broker's stop and the recorded target would be the shape this repo
      // keeps paying for.
      try {
        const { restoreMissingTargets } = deps.targetRestore ?? await import('./target-restore.js')
        const rowsById = new Map(openRows.map(r => [String(r.ctrader_position_id), r]))
        const fix = await restoreMissingTargets(db, creds, prot.targetless, rowsById, {
          ...(deps.restoreOpts || {}),
          notify: sendMessage ? (m) => sendMessage(m).catch(() => {}) : undefined,
        })
        out.targetsRestored += fix.restored
        for (const e of fix.errors) out.errors.push(`${id}: target restore — ${e}`)
        if (fix.restored) console.log(`[protection] ${id}: restored ${fix.restored} take profit(s) from the book`)
        for (const sk of fix.skipped) console.log(`[protection] ${id}: target NOT restored — ${sk}`)
      } catch (err) {
        // A failed repair must never take down the audit that found the fault.
        out.errors.push(`${id}: target restore failed — ${err?.message || err}`)
      }
    } catch (err) {
      const msg = String(err?.message || err)
      // UNAUDITABLE IS NOT UNPROTECTED, and the difference decides whether
      // this controller is worth reading.
      //
      // Demo 5268549's token does not cover it, so every pass returned
      // CH_ACCESS_TOKEN_INVALID and the first deploy of this path parked
      // protection_audit permanently in `error` — a controller that is always
      // red is a controller nobody reads, which is the same defect fixed in
      // the health panel hours earlier and reintroduced here by me.
      //
      // An account the broker refuses to authorise cannot be audited; that is
      // a fact about ACCESS, not about whether anything is exposed. It is
      // reported by name and separately, and does not on its own mark the
      // sweep failed. A genuine audit failure on a REACHABLE account still
      // does — because there, "we could not check" really does mean positions
      // may be sitting unprotected.
      if (UNAUDITABLE_RE.test(msg)) {
        out.unauditable.push(`${id}: ${msg}`)
        // MAKE THE GAP SURVIVE THE RECLASSIFICATION (review, 08-08). Before
        // this PR a CANT_ROUTE_REQUEST landed in `errors`, so the operator saw
        // amber with the account named. Reclassifying it as an access fact
        // stops it holding the controller red — correctly — but `unauditable`
        // reached only a console.warn, so the PARTIAL case (some accounts
        // reached, one refused) would render as a plain green with the gap
        // named nowhere. `blind` cannot catch that; it only fires when EVERY
        // account is refused.
        //
        // "We could not check this account" is exactly what this per-account
        // record was built to carry (see ¶D·2 above), and it preserves the last
        // successful reading rather than overwriting it. So the beat stays green
        // and the panel still says which account went unverified.
        recordAuditUnavailable(db, msg, { accountId: id, ...(deps.auditOpts?.nowMs ? { nowMs: deps.auditOpts.nowMs } : {}) })
      } else {
        out.errors.push(`${id}: ${msg}`)
        // THE GENUINE FAILURE MUST STAMP THE RECORD TOO (2026-08-22). This
        // branch — the WORSE failure, "a reachable account we could not
        // check" — was the only outcome that never wrote the per-account
        // record. Measured 2026-08-16: the sweep failed on a 502 every ~50s,
        // 20,492 runs, while /state/protection-audit presented a lastAttemptAt
        // six days old as the current state — the panel said the controller
        // had stopped when in fact only its RECORD had. The heartbeat and the
        // record disagreed, and the one that updates every pass is the one to
        // believe; this makes the record that one. Last success is preserved
        // (recordAuditUnavailable never overwrites `at`/`ok`), so this only
        // moves lastAttemptAt/lastAttemptError — which is the truth.
        recordAuditUnavailable(db, msg, { accountId: id, ...(deps.auditOpts?.nowMs ? { nowMs: deps.auditOpts.nowMs } : {}) })
      }
    }
  }
  // AN AUDIT THAT REACHED NOTHING IS NOT A CLEAN AUDIT, and this is the price
  // of every widening of UNAUTHORISED_CODES above. `CANT_ROUTE_REQUEST` is an
  // access fact per account — but if the whole sidecar session goes down, EVERY
  // account returns it, every one lands in `unauditable`, and the controller
  // would read `ok` while not a single position was checked. That is a worse
  // lie than the amber it replaces: green means "your positions are protected".
  //
  // So the honest rule is per-sweep, not per-account: reaching some accounts
  // and being refused by others is a real audit with a named gap; reaching NONE
  // of them means the sweep verified nothing and must say so.
  //
  // MEASURED AGAINST `roster`, NOT AGAINST `ids` (review, 08-08). `ids` prepends
  // `primary` unconditionally — no enabled test, no side test — so with the
  // global flag on `live` and a DISABLED live account selected, `ids` is that
  // one account, its reconcile throws CANT_ROUTE_REQUEST, and `accounts === 0`.
  // Against an implicit `ids` denominator that reads as blind, and the fast
  // monitor would beat failed every 60s for ever: the amber this change removes,
  // returned as permanent red, on the very same account and error. The
  // classification fix above would have been undone by its own counterweight.
  //
  // `roster` is the set we were actually obliged to reach — enabled, same side.
  // Empty roster plus an unreachable selected account is not a blind sweep;
  // there was nothing we were required to audit. The staleness of the work
  // product (checkProtectionFreshness) is what catches a sweep that stops
  // producing readings, and that is the right instrument for it.
  out.blind = reachedObliged === 0 && roster.length > 0 &&
    (out.unauditable.length > 0 || out.errors.length > 0)
  return out
}
