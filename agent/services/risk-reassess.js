// ---------------------------------------------------------------------------
// agent/services/risk-reassess.js — "Re-Risk": ask an LLM to re-derive the
// risk limits for the account as it stands today.
//
// Owner (2026-07-30), on the Risk page's top buttons:
//   "Reset: reset to default.
//    Re-Risk: using Claude or OpenAI (prompt user to choose either LLM and
//      model name) to do a risk assessment base on the balance account and
//      not on watchlist.
//    Re-Risk+Watchlist: ... base on the balance account with watchlist in
//      mind.
//    Result below the re-risk include last date/time of re-risk (watchlist
//      symbol number)"
//
// IT PROPOSES. IT DOES NOT APPLY.
//
// That is a deliberate design decision and the owner should know I made it.
// These keys are the money limits — perTradeRiskPct, dailyLossLimit,
// maxOpenPositions, equityStopPct. An LLM writing straight into them means one
// hallucinated decimal point silently changes how much every future trade can
// lose, and the risk gate would enforce it faithfully. So a run stores a
// PROPOSAL: current value, proposed value, and the model's reason for each.
// Applying is a separate, explicit act (see routes: /actions/risk-reassess
// runs it, /actions/risk-config applies whatever the owner accepts).
//
// Every proposal is also CLAMPED to a hard envelope below before it is even
// shown. The model cannot propose 90% per-trade risk; it will be recorded as
// clamped and flagged. Bounds here are not the model's to argue with.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { loadRiskConfig, DEFAULT_RISK_CONFIG, getAccountBalance, getAccountLeverage } from './risk.js'
import { readWatchlist } from './watchlists.js'

export const STATE_KEY = 'risk_reassess_json'

/**
 * The ONLY keys a reassessment may touch, each with a hard envelope.
 *
 * Deliberately narrow: position sizing, loss caps, exposure counts and the
 * quality floors. Not in this list, and so not proposable — the news/carry/
 * commission/slippage gate toggles, blockedSymbols, stopTriggerMethod, and
 * leverage (leverage is the broker's fact, not a preference).
 */
export const PROPOSABLE = {
  perTradeRiskPct:    { min: 0.0025, max: 0.03, kind: 'fraction', label: 'Risk per trade' },
  maxRiskCapPct:      { min: 0.0025, max: 0.05, kind: 'fraction', label: 'Hard risk cap per trade' },
  dailyLossPct:       { min: 0.005,  max: 0.10, kind: 'fraction', label: 'Daily loss limit' },
  dailyLossLimit:     { min: 1,      max: 1e7,  kind: 'usd',      label: 'Daily loss limit ($)' },
  maxOpenPositions:   { min: 1,      max: 50,   kind: 'int',      label: 'Max open positions' },
  maxConsecutiveLosses: { min: 2,    max: 10,   kind: 'int',      label: 'Max consecutive losses' },
  cooldownMinutes:    { min: 0,      max: 1440, kind: 'int',      label: 'Cooldown after the streak' },
  symbolCooldownMinutes: { min: 0,   max: 4320, kind: 'int',      label: 'Per-symbol cooldown' },
  minRR:              { min: 1,      max: 5,    kind: 'number',   label: 'Minimum reward:risk' },
  minSLDistancePct:   { min: 0.02,   max: 2,    kind: 'number',   label: 'Minimum stop distance (%)' },
  maxCurrencyExposure: { min: 1,     max: 10,   kind: 'int',      label: 'Max positions per currency' },
  maxClusterExposure: { min: 1,      max: 10,   kind: 'int',      label: 'Max positions per cluster' },
  maxMarginUsagePct:  { min: 0.05,   max: 0.9,  kind: 'fraction', label: 'Max margin usage' },
  marginLevelFloorPct: { min: 100,   max: 1000, kind: 'number',   label: 'Margin level floor (%)' },
  equityStopPct:      { min: 0.02,   max: 0.5,  kind: 'fraction', label: 'Equity stop' },
}

/**
 * Coerce + clamp one proposed value. Returns null when it is not a usable
 * number at all (the key is then dropped, not defaulted).
 *
 * @returns {{value: number, clamped: boolean}|null}
 */
export function clampProposal(key, raw) {
  const spec = PROPOSABLE[key]
  if (!spec) return null
  // Number(null) is 0 and Number('') is 0 — both finite, so a missing value
  // would otherwise be accepted and then clamped up to the minimum, inventing
  // a setting the model never proposed. Reject absence explicitly.
  if (raw == null || raw === '' || typeof raw === 'boolean') return null
  let n = Number(raw)
  if (!Number.isFinite(n)) return null
  if (spec.kind === 'int') n = Math.round(n)
  // A model asked for a "percent" often answers 5 when it means 0.05. Only
  // reinterpret when the value cannot possibly be a fraction (>1) AND the
  // /100 reading lands inside the envelope — otherwise clamp honestly rather
  // than guess at intent.
  if (spec.kind === 'fraction' && n > 1 && n / 100 >= spec.min && n / 100 <= spec.max) {
    n = n / 100
  }
  const clampedValue = Math.min(spec.max, Math.max(spec.min, n))
  return { value: clampedValue, clamped: clampedValue !== n }
}

/** Closed-trade statistics the model needs to reason about size. Pure SQL. */
export function tradeStats(db, accountId = null) {
  try {
    const where = accountId != null ? 'AND account_id = ?' : ''
    const params = accountId != null ? [String(accountId)] : []
    const row = db.prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) AS wins,
              AVG(CASE WHEN pnl_usd > 0 THEN pnl_usd END) AS avgWin,
              AVG(CASE WHEN pnl_usd < 0 THEN pnl_usd END) AS avgLoss,
              MIN(pnl_usd) AS worst,
              SUM(pnl_usd) AS net
         FROM trades WHERE status = 'closed' AND pnl_usd IS NOT NULL ${where}`
    ).get(...params) || {}
    const n = Number(row.n) || 0
    return {
      closedTrades: n,
      winRatePct: n ? Math.round((Number(row.wins) || 0) / n * 1000) / 10 : null,
      avgWinUsd: row.avgWin == null ? null : Math.round(Number(row.avgWin) * 100) / 100,
      avgLossUsd: row.avgLoss == null ? null : Math.round(Number(row.avgLoss) * 100) / 100,
      worstLossUsd: row.worst == null ? null : Math.round(Number(row.worst) * 100) / 100,
      netUsd: row.net == null ? null : Math.round(Number(row.net) * 100) / 100,
    }
  } catch {
    return { closedTrades: 0, winRatePct: null, avgWinUsd: null, avgLossUsd: null, worstLossUsd: null, netUsd: null }
  }
}

/**
 * Everything the model is told. Assembled separately from the prompt so a test
 * can assert what does and does not leave this process — no credentials, no
 * account numbers beyond the id already visible throughout the UI.
 */
export function buildContext(db, { accountId = null, includeWatchlist = false } = {}) {
  const config = loadRiskConfig(db)
  const balance = getAccountBalance(db, accountId)
  // Signature is (db, config, accountId) — config supplies the fallback
  // leverage when neither the per-account nor the global key is set.
  const leverage = getAccountLeverage(db, config, accountId)
  let openPositions = 0
  try {
    const w = accountId != null ? 'AND account_id = ?' : ''
    const p = accountId != null ? [String(accountId)] : []
    openPositions = db.prepare(
      `SELECT COUNT(*) AS n FROM monitored_positions WHERE status = 'active' ${w}`
    ).get(...p)?.n ?? 0
  } catch { openPositions = 0 }

  const watchlist = includeWatchlist
    ? readWatchlist(db, accountId).filter(w => w.enabled !== false).map(w => w.symbol)
    : []

  return {
    accountId: accountId == null ? null : String(accountId),
    balanceUsd: balance,
    leverage,
    openPositions,
    includeWatchlist,
    watchlist,
    watchlistCount: watchlist.length,
    stats: tradeStats(db, accountId),
    current: Object.fromEntries(Object.keys(PROPOSABLE).map(k => [k, config[k] ?? null])),
  }
}

function envelopeLines() {
  return Object.entries(PROPOSABLE)
    .map(([k, s]) => `- ${k} (${s.label}): ${s.kind}, allowed ${s.min}..${s.max}`)
    .join('\n')
}

/** The prompt. Separated so it is inspectable and testable. Pure. */
export function buildPrompt(ctx) {
  const wl = ctx.includeWatchlist
    ? (ctx.watchlist.length
        ? `\n## Watchlist (${ctx.watchlist.length} symbols the bot may trade on this account)\n${ctx.watchlist.join(', ')}\n\nTake the composition into account: how many instruments, how correlated they are, and which asset classes they span. More instruments and tighter correlation argue for lower per-trade risk and tighter cluster/currency caps.`
        : '\n## Watchlist\nEmpty. Say so in your summary and do not invent a universe.')
    : '\n## Watchlist\nDELIBERATELY EXCLUDED from this assessment. Judge from the account and its record alone. Do not reason about specific instruments.'

  return `You are a risk manager for an automated futures/FX/CFD trading bot. Re-derive its risk limits for the account below.

## Account
Balance: ${ctx.balanceUsd == null ? 'UNKNOWN' : `${ctx.balanceUsd} USD`}
Leverage: ${ctx.leverage == null ? 'UNKNOWN' : `1:${ctx.leverage}`}
Open positions right now: ${ctx.openPositions}

## Its actual record (closed trades)
Closed trades: ${ctx.stats.closedTrades}
Win rate: ${ctx.stats.winRatePct == null ? 'n/a' : `${ctx.stats.winRatePct}%`}
Average win: ${ctx.stats.avgWinUsd ?? 'n/a'} USD
Average loss: ${ctx.stats.avgLossUsd ?? 'n/a'} USD
Worst single loss: ${ctx.stats.worstLossUsd ?? 'n/a'} USD
Net: ${ctx.stats.netUsd ?? 'n/a'} USD
${wl}
## Current settings
${JSON.stringify(ctx.current, null, 1)}

## What you may change, and the hard limits
${envelopeLines()}

Rules:
- Survival first. A small account cannot afford the risk a large one can.
- If the record is thin (under 30 closed trades) prefer conservatism and SAY the sample is thin.
- Only include a key if you are actually changing it. Do not restate unchanged values.
- Percentages expressed as fractions must be fractions (0.02 = 2%).
- Never exceed the allowed range for a key.

Return ONLY valid JSON, no prose outside it:
{
  "summary": "<2-4 sentences: the risk posture you are recommending and why>",
  "warnings": ["<any material concern about this account, or an empty array>"],
  "proposals": [
    { "key": "<one of the keys above>", "value": <number>, "reason": "<one sentence>" }
  ]
}`
}

/**
 * Parse + validate the model's answer into a stored result. Pure: no DB, no
 * network, so the whole validation path is testable without an LLM.
 *
 * Unknown keys are DROPPED and named in `rejected` rather than silently
 * ignored — a model proposing something outside the envelope is information.
 */
export function parseAssessment(text, ctx) {
  const clean = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  const parsed = JSON.parse(clean)
  const proposals = []
  const rejected = []
  for (const p of Array.isArray(parsed.proposals) ? parsed.proposals : []) {
    const key = String(p?.key || '')
    if (!(key in PROPOSABLE)) { rejected.push({ key, why: 'not a proposable setting' }); continue }
    const c = clampProposal(key, p?.value)
    if (!c) { rejected.push({ key, why: `not a usable number: ${JSON.stringify(p?.value)}` }); continue }
    const current = ctx.current[key] ?? null
    if (current != null && Number(current) === c.value) continue   // no-op, drop it
    proposals.push({
      key,
      label: PROPOSABLE[key].label,
      current,
      proposed: c.value,
      clamped: c.clamped,
      reason: String(p?.reason || '').slice(0, 400),
    })
  }
  return {
    summary: String(parsed.summary || '').slice(0, 2000),
    warnings: (Array.isArray(parsed.warnings) ? parsed.warnings : []).map(w => String(w).slice(0, 400)).slice(0, 20),
    proposals,
    rejected,
  }
}

/** Read the stored result of the last run (null before the first one). */
export function loadLastAssessment(db) {
  try {
    const raw = JSON.parse(getState(db, STATE_KEY) || 'null')
    return raw && typeof raw === 'object' ? raw : null
  } catch { return null }
}

/**
 * Run one reassessment end to end and store it.
 *
 * @param {*} db
 * @param {{provider: string, model: string, includeWatchlist?: boolean, accountId?: string|null}} opts
 * @param {{createClient?: Function, now?: () => Date}} [deps] injectable for tests
 */
export async function runReassessment(db, opts, deps = {}) {
  const { provider, model, includeWatchlist = false, accountId = null } = opts || {}
  const createClient = deps.createClient
    || (async (p, m) => (await import('../lib/llm-provider.js')).createLLMClientFor(p, m))
  const now = deps.now ? deps.now() : new Date()

  const ctx = buildContext(db, { accountId, includeWatchlist })
  if (ctx.balanceUsd == null) {
    throw new Error('account balance is unknown — link the account or set a balance before a reassessment')
  }
  const client = await createClient(provider, model)
  const resp = await client.messages.create({
    model: client.model || model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: buildPrompt(ctx) }],
  })
  const text = (resp?.content || []).filter(c => c?.type === 'text').map(c => c.text).join('')
  const assessment = parseAssessment(text, ctx)

  const result = {
    at: now.toISOString(),
    provider,
    model: resp?.model || client.model || model,
    includeWatchlist,
    watchlistCount: ctx.watchlistCount,
    accountId: ctx.accountId,
    balanceUsd: ctx.balanceUsd,
    leverage: ctx.leverage,
    stats: ctx.stats,
    ...assessment,
    // Stored but never auto-applied. The Risk page applies what the owner
    // accepts, through /actions/risk-config.
    applied: false,
    appliedAt: null,
  }
  setState(db, STATE_KEY, JSON.stringify(result))
  return result
}

/** Mark the stored assessment as applied, with the keys that actually went in. */
export function markApplied(db, keys, now = new Date()) {
  const last = loadLastAssessment(db)
  if (!last) return null
  const next = { ...last, applied: true, appliedAt: now.toISOString(), appliedKeys: keys }
  setState(db, STATE_KEY, JSON.stringify(next))
  return next
}

export { DEFAULT_RISK_CONFIG }
