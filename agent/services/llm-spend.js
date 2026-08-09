// ---------------------------------------------------------------------------
// agent/services/llm-spend.js — LLM token & cost accounting.
//
// Owner (2026-07-17): "build token used — I need to ensure this app doesn't
// cost me a shock." Every Anthropic call is persisted to token_usage
// (day × purpose × model) with input/output/cache tokens, priced with the
// published per-model rates, and surfaced as today / 7d / 30d spend plus a
// monthly projection. An owner-set daily cost cap alerts on Telegram once
// per day when crossed.
//
// Prices are $ per MILLION tokens (input, output). Cache reads bill ~0.1×
// input, cache writes ~1.25× input. Unknown models price at the Opus tier —
// costs must surprise DOWN, never up.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

export const MODEL_PRICES = {
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  // OpenAI (primary provider when OPENAI_API_KEY is set) — $/1M tokens.
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  // NOT LISTED, deliberately: the gpt-5.x family the tier router now names
  // (OPENAI_MODEL_DEFAULT / _PREMIUM / _REASONING). Their per-million rates are not
  // verified here, so it resolves to FALLBACK_PRICE — the Opus tier — and the
  // spend figure for those calls reads HIGH rather than wrong-cheap. Add real
  // entries once the published rates are confirmed; do not guess them, because
  // this table feeds a dollar number the owner reads as fact.
  //
  // Note on matching: priceFor takes the FIRST key the model id starts with,
  // so more specific ids must be inserted before their prefixes (see
  // 'gpt-4o-mini' above 'gpt-4o').
}
const FALLBACK_PRICE = { input: 5, output: 25 } // conservative: Opus tier

function priceFor(model) {
  const key = Object.keys(MODEL_PRICES).find(k => String(model || '').startsWith(k))
  return key ? MODEL_PRICES[key] : FALLBACK_PRICE
}

/** Estimated USD for one usage bundle on one model. */
export function costUsd(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = {}) {
  const p = priceFor(model)
  return (
    (input * p.input +
      output * p.output +
      cacheRead * p.input * 0.1 +
      cacheWrite * p.input * 1.25) /
    1_000_000
  )
}

/**
 * Persist one API call's usage. `usage` is the Anthropic response usage
 * object (input_tokens, output_tokens, cache_read_input_tokens,
 * cache_creation_input_tokens) — missing fields count as 0.
 */
export function recordTokenUsage(db, { purpose, model, usage, now = new Date() }) {
  const day = now.toISOString().slice(0, 10)
  db.prepare(
    `INSERT INTO token_usage (day, purpose, model, calls, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(day, purpose, model) DO UPDATE SET
       calls = calls + 1,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens`
  ).run(
    day,
    purpose || 'unknown',
    model || 'unknown',
    usage?.input_tokens || 0,
    usage?.output_tokens || 0,
    usage?.cache_read_input_tokens || 0,
    usage?.cache_creation_input_tokens || 0,
  )
}

function rowCost(r) {
  return costUsd(r.model, {
    input: r.input_tokens,
    output: r.output_tokens,
    cacheRead: r.cache_read_tokens,
    cacheWrite: r.cache_write_tokens,
  })
}

function totals(rows) {
  const t = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 }
  for (const r of rows) {
    t.calls += r.calls
    t.input_tokens += r.input_tokens
    t.output_tokens += r.output_tokens
    t.cache_read_tokens += r.cache_read_tokens
    t.cache_write_tokens += r.cache_write_tokens
    t.cost_usd += rowCost(r)
  }
  t.cost_usd = Math.round(t.cost_usd * 10000) / 10000
  return t
}

/** Spend dashboard: today / 7d / 30d, per purpose×model, monthly projection. */
export function spendView(db, { now = new Date() } = {}) {
  const day = (d) => d.toISOString().slice(0, 10)
  const today = day(now)
  const d7 = day(new Date(now.getTime() - 7 * 86400_000))
  const d30 = day(new Date(now.getTime() - 30 * 86400_000))
  const since = (from) => db.prepare('SELECT * FROM token_usage WHERE day > ?').all(from)
  const rows30 = since(d30)
  const rows7 = rows30.filter(r => r.day > d7)
  const rowsToday = rows30.filter(r => r.day === today)

  // Per purpose×model over 30d, priced, largest first.
  const byPurpose = {}
  for (const r of rows30) {
    const key = `${r.purpose}|${r.model}`
    const b = (byPurpose[key] ??= { purpose: r.purpose, model: r.model, calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 })
    b.calls += r.calls
    b.input_tokens += r.input_tokens
    b.output_tokens += r.output_tokens
    b.cache_read_tokens += r.cache_read_tokens
    b.cache_write_tokens += r.cache_write_tokens
    b.cost_usd = Math.round((b.cost_usd + rowCost(r)) * 10000) / 10000
  }

  const t30 = totals(rows30)
  const activeDays = Math.max(1, new Set(rows30.map(r => r.day)).size)
  return {
    today: totals(rowsToday),
    last7d: totals(rows7),
    last30d: t30,
    // Projection assumes recent behaviour continues: 30d daily average × 30.
    projected_month_usd: Math.round((t30.cost_usd / activeDays) * 30 * 100) / 100,
    by_purpose: Object.values(byPurpose).sort((a, b) => b.cost_usd - a.cost_usd),
    daily_cap_usd: Number(getState(db, 'llm_daily_cost_alert_usd')) || null,
  }
}

/**
 * Daily cost cap: owner sets llm_daily_cost_alert_usd (0/absent = off).
 * When today's estimated spend crosses it, alert ONCE per day.
 */
export function checkSpendAlert(db, { now = new Date(), notify = null } = {}) {
  const cap = Number(getState(db, 'llm_daily_cost_alert_usd'))
  if (!Number.isFinite(cap) || cap <= 0) return null
  const today = now.toISOString().slice(0, 10)
  const rows = db.prepare('SELECT * FROM token_usage WHERE day = ?').all(today)
  const spent = totals(rows).cost_usd
  if (spent < cap) return null
  if (getState(db, 'llm_spend_alerted_day') === today) return { alerted: false, spent }
  setState(db, 'llm_spend_alerted_day', today)
  try {
    notify?.(`🔴 LLM SPEND ALERT: today's estimated Anthropic cost $${spent.toFixed(2)} crossed your $${cap.toFixed(2)}/day cap. Spend breakdown is on Desk → LLM spend.`)
  } catch { /* alerting must never throw */ }
  return { alerted: true, spent }
}

// ---------------------------------------------------------------------------
// A CAP THAT ACTUALLY CAPS (owner, 09-08-2026, on discovering ~$2,314 in 30
// days against a "$5 daily cap").
//
// `llm_daily_cost_alert_usd` above is an ALERT THRESHOLD and always was — the
// route that sets it is documented as arming "the once-a-day Telegram". It
// notifies and nothing else, so production ran at roughly $77/day against a $5
// line for weeks while looking configured. A number labelled "cap" that cannot
// stop anything is worse than no number: it answers the question the operator
// was going to ask, wrongly.
//
// THIS REVERSES A DELIBERATE EARLIER DECISION, and it should be read as such.
// loop.js:2770 says of the token budget: the monitor checks "must not be paused
// mid-position, so an exceeded budget warns instead of gating." That reasoning
// was sound when the only cost was tokens. It is no longer the whole picture at
// $3,000/month on a demo account — and the thing being paused is a SECOND
// OPINION, not a safety layer: entries, the risk gate, sizing and every
// stop/target adjustment are deterministic, and the broker holds the SL/TP
// whatever this returns.
//
// So the cap is real, and OFF BY DEFAULT. An unset key behaves exactly as
// today. Setting it is the owner choosing to trade position-review coverage for
// a spend ceiling, which is a choice only they can make.
// ---------------------------------------------------------------------------

export const SPEND_CAP_KEY = 'llm_daily_cost_cap_usd'

/**
 * Today's spend against the hard cap.
 *
 * @returns {{cap: number|null, spent: number, exceeded: boolean, day: string}}
 *   cap null = no ceiling configured, which is the default.
 */
export function spendCapState(db, { now = new Date() } = {}) {
  const day = now.toISOString().slice(0, 10)
  let raw = null
  try { raw = getState(db, SPEND_CAP_KEY) } catch { raw = null }
  // `Number(null)` and `Number('')` are 0, and 0 here would read as a cap of
  // zero dollars — an instant, permanent shutdown of the LLM layer from a key
  // nobody set. Reject the empty values by identity before coercing.
  const cap = (raw == null || raw === '') ? null : Number(raw)
  if (!Number.isFinite(cap) || cap <= 0) return { cap: null, spent: 0, exceeded: false, day }

  let spent = 0
  try {
    spent = totals(db.prepare('SELECT * FROM token_usage WHERE day = ?').all(day)).cost_usd
  } catch {
    // UNREADABLE SPEND IS NOT ZERO SPEND, but it is also not grounds to cut the
    // monitor: the same fail-open direction as llm-switch's state read, and for
    // the same reason. A SQLITE_BUSY must not silence position review.
    return { cap, spent: 0, exceeded: false, day, unreadable: true }
  }
  return { cap, spent, exceeded: spent >= cap, day }
}

/** True when a hard cap is configured AND today's spend has reached it. */
export function spendCapExceeded(db, opts = {}) {
  return spendCapState(db, opts).exceeded === true
}
