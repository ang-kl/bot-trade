// Claude · № 15,144 16-Oct (owner: "B priorities class that are profitable as
// first to trade … C·2 Policy, build class-aware routing" after § 15,128;
// claude-builder).
//
// The class-routing POLICY, read from agent/config/class-routing.json (owner
// principle 9: setups are not hardcoded; every value is in the repo where the
// owner can change it without a code change). Two things live here:
//   · priority per class → the scan tier (selectScanBatch's share);
//   · block tokens per class and per symbol → (strategy, side) candidates the
//     scan refuses at signal selection, each refusal recorded with the token
//     that caused it (never a silent drop: owner principle 4).
// A block-list, not an allow-list: a strategy nobody listed is routed exactly
// as before, so a new strategy cannot be refused everywhere by omission.
// Malformed tokens are reported and ignored; an unreadable file turns the
// policy OFF with its reason, never into a guessed default.
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const CLASS_ROUTING_FILE = fileURLToPath(new URL('../config/class-routing.json', import.meta.url))
const TOKEN_RE = /^([a-z][a-z0-9_]*|\*)(?::(long|short))?$/ // a strategy key starts with a letter
const CHECK_MS = 60_000
const DEFAULT_PRIORITY = 9
let MEMO = null // { file, mtimeMs, checkedAt, policy }

const OFF = (reason, file) => ({ enabled: false, reason, warnings: [], classes: {}, symbols: {}, scanShare: null, source: 'unavailable', file })

/** 'va_breakout:long' → { strategy, side }; 'rsi_meanrev' → side null; '*:long' → every strategy long. */
export function parseToken(raw) {
  const m = TOKEN_RE.exec(String(raw ?? '').trim().toLowerCase())
  return m ? { strategy: m[1], side: m[2] || null } : null
}

/** Validate a parsed file into the policy the scan reads. Pure. */
export function compilePolicy(raw, { knownStrategies = null, file = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return OFF('class-routing.json is not an object', file)
  const warnings = []
  const compileBlocks = (list, where) => {
    const out = []
    if (list != null && !Array.isArray(list)) { warnings.push(`${where}.block is not an array; ignored`); return out }
    for (const t of list || []) {
      const p = parseToken(t)
      if (!p) { warnings.push(`${where}: malformed token "${t}" ignored`); continue }
      if (Array.isArray(knownStrategies) && p.strategy !== '*' && !knownStrategies.includes(p.strategy)) {
        warnings.push(`${where}: unknown strategy "${p.strategy}" (kept; it blocks nothing until a strategy of that key exists)`)
      }
      out.push({ strategy: p.strategy, side: p.side, token: `${p.strategy}${p.side ? ':' + p.side : ''}` })
    }
    return out
  }
  const classes = {}
  for (const [name, spec] of Object.entries(raw.classes && typeof raw.classes === 'object' ? raw.classes : {})) {
    const pr = Number(spec?.priority)
    classes[String(name).toLowerCase()] = { priority: Number.isFinite(pr) ? pr : DEFAULT_PRIORITY, block: compileBlocks(spec?.block, `classes.${name}`) }
  }
  const symbols = {}
  for (const [name, spec] of Object.entries(raw.symbols && typeof raw.symbols === 'object' ? raw.symbols : {})) {
    symbols[String(name).toUpperCase()] = { block: compileBlocks(spec?.block, `symbols.${name}`) }
  }
  let scanShare = null
  if (raw.scanShare != null) {
    const slots = Number(raw.scanShare?.prioritySlots), rank = Number(raw.scanShare?.priorityMaxRank)
    if (Number.isInteger(slots) && slots > 0 && Number.isFinite(rank)) scanShare = { prioritySlots: slots, priorityMaxRank: rank }
    else warnings.push('scanShare: prioritySlots must be a positive integer and priorityMaxRank a number; the share is off')
  }
  return { enabled: raw.enabled !== false, reason: null, warnings, classes, symbols, scanShare, source: 'file', file }
}

/**
 * The policy, memoised on the file's mtime (checked at most once a minute).
 * `knownStrategies` (STRATEGY_KEYS) only adds warnings for unknown keys.
 */
export function loadClassRouting({ file = CLASS_ROUTING_FILE, knownStrategies = null, now = Date.now() } = {}) {
  if (MEMO && MEMO.file === file && now - MEMO.checkedAt < CHECK_MS) return MEMO.policy
  let mtimeMs = null
  try { mtimeMs = statSync(file).mtimeMs } catch { mtimeMs = null }
  if (MEMO && MEMO.file === file && mtimeMs != null && MEMO.mtimeMs === mtimeMs) { MEMO.checkedAt = now; return MEMO.policy }
  let policy
  try { policy = compilePolicy(JSON.parse(readFileSync(file, 'utf8')), { knownStrategies, file }) }
  catch (e) { policy = OFF(`class-routing.json unreadable: ${e.message}`, file) }
  MEMO = { file, mtimeMs, checkedAt: now, policy }
  return policy
}

/** The class's scan priority (lower first); an unlisted class is 9. */
export function classPriority(policy, cls) {
  const c = policy?.classes?.[String(cls || '').toLowerCase()]
  return c ? c.priority : DEFAULT_PRIORITY
}

/**
 * Is this (symbol, class, strategy, side) candidate routed OUT? The symbol's
 * own tokens are checked before the class's. `{ ok: true }` when the policy is
 * off or nothing matches; otherwise the reason names the token and its source.
 */
export function isRouted(policy, { cls, symbol, strategy, bias } = {}) {
  if (!policy || policy.enabled === false) return { ok: true, reason: null }
  const key = String(strategy || '').toLowerCase()
  const side = String(bias || '').toLowerCase()
  const sym = String(symbol || '').toUpperCase()
  const hit = (list, source) => {
    for (const t of list || []) {
      if (t.strategy !== '*' && t.strategy !== key) continue
      if (t.side && t.side !== side) continue
      return { ok: false, reason: `${key || '(no strategy)'} ${side || '(no side)'} routed out of ${source} by class-routing.json token "${t.token}"`, token: t.token, source }
    }
    return null
  }
  return hit(policy.symbols?.[sym]?.block, `symbol ${sym}`)
    || hit(policy.classes?.[String(cls || '').toLowerCase()]?.block, `class ${String(cls || 'other').toLowerCase()}`)
    || { ok: true, reason: null }
}

export function _resetClassRoutingForTests() { MEMO = null }
