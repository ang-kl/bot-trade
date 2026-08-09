// ---------------------------------------------------------------------------
// cockpit-explain.js — PHASE 9 of the cockpit live-wiring prompt: the OPTIONAL
// model explanation. It paraphrases an already-validated evidence bundle. It
// never decides anything.
//
// The prompt's rules, and how each is enforced here:
//
//   "optional explanation flag, OFF by default"
//       → explanationEnabled(db) reads agent_state 'cockpit_explain_enabled'
//         and is false unless that key is literally 'true'. Nothing turns it on
//         implicitly, not even a configured API key.
//
//   "send only the structured evidence bundle, never credentials"
//       → buildEvidenceBundle() constructs the payload from the snapshot body's
//         OWN fields. It is the only thing handed to the model, and it is built
//         by allow-list, not by deleting keys from a larger object — a payload
//         that never contained a token cannot leak one.
//
//   "require text, evidenceIds, uncertainty and generatedAt in validated JSON;
//    validate evidenceIds against the bundle"
//       → validateExplanation() rejects anything else, and rejects an id the
//         bundle does not contain. A rejection is not a degraded answer: it
//         falls back to the deterministic text, whole.
//
//   "cache by evidence revision" / "do not call a model on every price tick"
//       → the cache is keyed by meta.revision, which already moves only when
//         the underlying facts move (SL/TP/status/journal/last check/live-at).
//         The snapshot read path is SYNCHRONOUS and cache-only: it never makes
//         a network call, so no cockpit repaint can reach a model.
//
//   "on failure, use deterministic explanation" /
//   "model failure cannot block the cockpit or trading loop"
//       → every path returns a valid explanation object. generateExplanation()
//         catches everything and degrades; it is invoked from an explicit route
//         the owner triggers, never from the loop.
//
//   "never create or alter an order decision"
//       → this module has no writer other than the explanation cache and the
//         token-usage ledger. It does not import the exec engine, the risk gate
//         or the position manager, and nothing reads its output back into them.
//
// ONE MORE GUARD, beyond the prompt: numbersAreGrounded(). A paraphrase that
// invents a price is the exact failure the whole cockpit spec exists to
// prevent, so every numeric token in the model's text must appear in the
// bundle. Ungrounded number → rejected → deterministic text.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { recordTokenUsage } from './llm-spend.js'

export const EXPLAIN_FLAG_KEY = 'cockpit_explain_enabled'
const CACHE_KEY = 'cockpit_explain_cache_json'
const CACHE_MAX = 20
const MAX_TEXT = 1200

/** OFF by default. Only the literal string 'true' enables it. */
export function explanationEnabled(db) {
  try { return String(getState(db, EXPLAIN_FLAG_KEY) || '').trim().toLowerCase() === 'true' } catch { return false }
}

/**
 * The bundle handed to the model — built by allow-list from the snapshot body.
 *
 * Evidence ids are the intention block's own (its evidenceIndex keys), so the
 * model can only cite what the deterministic layer already stands behind.
 */
export function buildEvidenceBundle(body) {
  const intention = body?.intention && typeof body.intention === 'object' ? body.intention : {}
  const evidenceIndex = intention.evidenceIndex && typeof intention.evidenceIndex === 'object' ? intention.evidenceIndex : {}
  const corr = body?.correlation && typeof body.correlation === 'object' ? body.correlation : {}
  const env = body?.environment && typeof body.environment === 'object' ? body.environment : {}
  return {
    revision: body?.meta?.revision ?? null,
    symbol: body?.position?.symbol ?? null,
    side: body?.position?.side ?? null,
    marketOpen: body?.position?.marketOpen ?? null,
    deterministic: intention.explanation?.text ?? null,
    state: intention.currentDecision?.state ?? null,
    decision: intention.currentDecision ?? null,
    nextAction: intention.nextAction ?? null,
    armedActions: Array.isArray(intention.armedActions) ? intention.armedActions : [],
    invalidation: Array.isArray(intention.invalidation) ? intention.invalidation : [],
    currentR: intention.currentR ?? null,
    thesis: intention.thesis ?? null,
    correlation: { status: corr.status ?? null, summary: corr.summary ?? null, related: Array.isArray(corr.related) ? corr.related : [] },
    environment: {
      session: env.session ?? null,
      regime: env.regime ?? null,
      newsGate: env.macroNews?.gate ?? null,
      newsStatus: env.macroNews?.status ?? null,
    },
    advisories: Array.isArray(body?.advisories) ? body.advisories : [],
    evidence: Object.entries(evidenceIndex).map(([id, e]) => ({ id, source: e?.source ?? null, asOf: e?.asOf ?? null, value: e?.value ?? null })),
  }
}

/** The deterministic answer, in the contract's explanation shape. Always valid. */
export function deterministicExplanation(body, nowMs = Date.now()) {
  const ex = body?.intention?.explanation
  return {
    text: ex?.text ?? 'No deterministic explanation is available for this position.',
    mode: 'deterministic',
    model: null,
    generatedAt: ex?.generatedAt ?? new Date(nowMs).toISOString(),
    evidenceRevision: body?.meta?.revision ?? null,
    evidenceIds: [],
    uncertainty: null,
  }
}

// --- cache ------------------------------------------------------------------

function readCache(db) {
  try { const o = JSON.parse(getState(db, CACHE_KEY) || '{}'); return o && typeof o === 'object' ? o : {} } catch { return {} }
}

/**
 * The cached model explanation for THIS revision, or null.
 *
 * Synchronous and side-effect-free on purpose: the snapshot read path calls it,
 * and a read path must never be able to reach the network.
 */
export function cachedExplanation(db, revision) {
  if (!revision) return null
  const hit = readCache(db)[String(revision)]
  return hit && hit.text ? hit : null
}

export function putCachedExplanation(db, revision, entry) {
  if (!revision) return
  const cache = readCache(db)
  cache[String(revision)] = entry
  // Bounded: oldest generatedAt evicted first, so a long-lived agent cannot
  // grow this key without limit.
  const keys = Object.keys(cache)
  if (keys.length > CACHE_MAX) {
    keys.sort((a, b) => String(cache[a]?.generatedAt || '').localeCompare(String(cache[b]?.generatedAt || '')))
    for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k]
  }
  try { setState(db, CACHE_KEY, JSON.stringify(cache)) } catch { /* cache is best-effort */ }
}

// --- validation -------------------------------------------------------------

/** Strip a ```json fence if the model wrapped its answer in one, then parse. */
export function parseModelJson(raw) {
  const s = String(raw ?? '').trim()
  const body = s.startsWith('```')
    ? s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()
    : s
  return JSON.parse(body)
}

/**
 * Every number the text states must appear in the bundle. Percentages and R
 * values the model derives are still numbers it did not measure — if it is not
 * in the bundle, it is not on screen.
 */
export function numbersAreGrounded(text, bundle) {
  const hay = JSON.stringify(bundle)
  const nums = String(text).match(/-?\d+(?:\.\d+)?/g) || []
  return nums.every(n => {
    if (hay.includes(n)) return true
    // A trailing-zero difference is formatting, not a new fact: 1.10 ≡ 1.1.
    const trimmed = n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n
    return hay.includes(trimmed)
  })
}

/**
 * Claims the deterministic layer has not made. The prompt names these words
 * specifically; the rule here is that the model may only repeat such a claim if
 * the deterministic text already contains it.
 */
const GUARDED_CLAIMS = ['confirmed', 'normal', 'all clear', 'thesis intact', 'path to tp']

export function validateExplanation(obj, bundle) {
  if (!obj || typeof obj !== 'object') throw new Error('explanation is not an object')
  const text = obj.text
  if (typeof text !== 'string' || !text.trim()) throw new Error('explanation.text is missing')
  if (text.length > MAX_TEXT) throw new Error(`explanation.text exceeds ${MAX_TEXT} characters`)
  if (!Array.isArray(obj.evidenceIds) || obj.evidenceIds.length === 0) throw new Error('explanation.evidenceIds is missing')
  if (typeof obj.uncertainty !== 'string' || !obj.uncertainty.trim()) throw new Error('explanation.uncertainty is missing')
  if (typeof obj.generatedAt !== 'string' || !obj.generatedAt.trim()) throw new Error('explanation.generatedAt is missing')
  const known = new Set((bundle.evidence || []).map(e => e.id))
  const unknown = obj.evidenceIds.filter(id => !known.has(id))
  if (unknown.length) throw new Error(`explanation cites unknown evidence: ${unknown.join(', ')}`)
  if (!numbersAreGrounded(text, bundle)) throw new Error('explanation states a number that is not in the evidence bundle')
  const lower = text.toLowerCase()
  const det = String(bundle.deterministic || '').toLowerCase()
  const claimed = GUARDED_CLAIMS.filter(c => lower.includes(c) && !det.includes(c))
  if (claimed.length) throw new Error(`explanation makes an unsupported claim: ${claimed.join(', ')}`)
  return { text: text.trim(), evidenceIds: obj.evidenceIds.slice(), uncertainty: obj.uncertainty.trim() }
}

// --- the model call ---------------------------------------------------------

export const SYSTEM_PROMPT = [
  'You rewrite a trading bot\'s DETERMINISTIC explanation of one open position into plain English for its owner.',
  'You are not a trader and you make no decisions. You never suggest an action, an entry, an exit, a size or a price.',
  'You may only restate what the evidence bundle contains. You may not add a fact, a number, a probability or a forecast.',
  'Never write "confirmed", "normal", "all clear", "thesis intact" or "path to TP" unless that exact claim is already in the deterministic text.',
  'Answer with JSON only, no prose and no code fence, with exactly these keys:',
  '  text          — 1 to 4 sentences, plain English, no invented numbers',
  '  evidenceIds   — the bundle evidence ids your text rests on (at least one, all from the bundle)',
  '  uncertainty   — one sentence naming what is unknown or stale; "none stated" if the bundle names nothing',
  '  generatedAt   — ISO 8601 timestamp',
].join('\n')

/**
 * Produce an explanation for this snapshot body. Cache-first; degrades to the
 * deterministic text on ANY failure (flag off, no client, network, bad JSON,
 * failed validation).
 *
 * @param {object} db
 * @param {object} body           the cockpit snapshot body
 * @param {object} [deps]
 * @param {object} [deps.client]  an llm-provider client ({messages.create})
 * @param {boolean} [deps.force]  ignore the cache (owner pressed refresh)
 * @param {number} [deps.nowMs]
 */
export async function generateExplanation(db, body, deps = {}) {
  const nowMs = deps.nowMs ?? Date.now()
  const fallback = deterministicExplanation(body, nowMs)
  const revision = body?.meta?.revision ?? null
  if (!explanationEnabled(db)) return { ...fallback, reason: 'explanation flag is off' }

  if (!deps.force) {
    const hit = cachedExplanation(db, revision)
    if (hit) return { ...hit, cached: true }
  }

  let client = deps.client
  if (!client) {
    // Switched off is a stated position, not a fault — say so plainly rather
    // than letting the caller read a model error and wonder what broke.
    const { llmDisabled } = await import('../lib/llm-switch.js')
    if (llmDisabled(db, getState)) return { ...fallback, reason: 'LLM layer disabled' }
    try {
      const { createLLMClient } = await import('../lib/llm-provider.js')
      client = createLLMClient(process.env, { task: { type: 'cockpit_explanation' } })
    } catch (err) {
      return { ...fallback, reason: `no model client: ${err.message}` }
    }
  }

  const bundle = buildEvidenceBundle(body)
  try {
    const res = await client.messages.create({
      model: client.model,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(bundle) }],
    })
    const raw = res?.content?.[0]?.text ?? ''
    const valid = validateExplanation(parseModelJson(raw), bundle)
    const entry = {
      text: valid.text,
      mode: 'model',
      model: res?.model || client.model || null,
      generatedAt: new Date(nowMs).toISOString(),
      evidenceRevision: revision,
      evidenceIds: valid.evidenceIds,
      uncertainty: valid.uncertainty,
    }
    // Cost is the owner's standing concern — the same ledger every other LLM
    // call writes to, under its own purpose so it can be read separately.
    try {
      recordTokenUsage(db, {
        purpose: 'cockpit_explanation',
        model: entry.model,
        usage: { input_tokens: res?.usage?.input_tokens ?? 0, output_tokens: res?.usage?.output_tokens ?? 0 },
      })
    } catch { /* accounting must never break the answer */ }
    putCachedExplanation(db, revision, entry)
    return entry
  } catch (err) {
    return { ...fallback, reason: `model explanation rejected: ${err.message}` }
  }
}
