// ---------------------------------------------------------------------------
// agent/lib/research-config.js — the research programme's parameters, READ
// FROM agent/config/research.json, never typed into code.
//
// Claude · № 13,094 11-Oct (ordered № 13,093; claude-builder). The owner's
// third check on the plan: "i see a few forced hardcoded settings, are these
// against dynamic setups". The sweep values, bar forms and run sizes of the
// research are research choices, so they live in a config file the owner can
// change without a code change, and a request may override them per run.
// Each run records the values it used.
//
// RESEARCH ONLY. No live gate, order path or trade-management module reads
// this file: agent/research-isolation.test.js pins that. The sample minimum
// is NOT here on purpose: it is the owner's existing bar in
// agent/config/tick-validation.json (traded.minTrades), read through
// services/tick-validation.js loadThresholds.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const RESEARCH_CONFIG_FILE = fileURLToPath(new URL('../config/research.json', import.meta.url))

const finite = v => typeof v === 'number' && Number.isFinite(v)
const posInt = v => Number.isInteger(v) && v > 0
/** A bounded list of distinct finite numbers in (0, max]; garbage dropped, never guessed. */
export function numberList(raw, { max = 10, limit = 8, min = 0 } = {}) {
  if (!Array.isArray(raw)) return []
  const seen = new Set(), out = []
  for (const v of raw) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= min || n > max) continue
    const r = Math.round(n * 1000) / 1000
    if (seen.has(r)) continue
    seen.add(r); out.push(r)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Load the research config. A missing or unreadable file returns EMPTY
 * sections (`{ exitReplay: {}, barForm: {}, source: 'unavailable' }`), never
 * defaults: a research run must say what it used, and "the file was missing"
 * is a result, not a reason to invent a sweep.
 */
export function loadResearchConfig({ file = RESEARCH_CONFIG_FILE } = {}) {
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return { exitReplay: {}, barForm: {}, source: 'unavailable', file } }
  const er = raw?.exitReplay ?? {}, bf = raw?.barForm ?? {}
  return {
    source: 'file',
    file,
    exitReplay: {
      trailR: numberList(er.trailR, { max: 10 }),
      tpR: numberList(er.tpR, { max: 10 }),
      followThroughR: numberList(er.followThroughR, { max: 10 }),
      exitAtMeanPeriod: posInt(er.exitAtMeanPeriod) ? er.exitAtMeanPeriod : null,
      maxDays: posInt(er.maxDays) ? er.maxDays : null,
    },
    barForm: {
      timeBarsMs: numberList(bf.timeBarsMs, { max: 86_400_000, limit: 12, min: 999 }),
      tickBarsNominalMs: numberList(bf.tickBarsNominalMs, { max: 86_400_000, limit: 12, min: 999 }),
      maxSilenceMs: posInt(bf.maxSilenceMs) ? bf.maxSilenceMs : null,
      pauseBetweenSegmentsMs: finite(bf.pauseBetweenSegmentsMs) && bf.pauseBetweenSegmentsMs >= 0 ? bf.pauseBetweenSegmentsMs : null,
      maxSegmentsPerRun: posInt(bf.maxSegmentsPerRun) ? bf.maxSegmentsPerRun : null,
      smallRun: { symbols: posInt(bf.smallRun?.symbols) ? bf.smallRun.symbols : null, days: posInt(bf.smallRun?.days) ? bf.smallRun.days : null },
      calibrationSegments: posInt(bf.calibrationSegments) ? bf.calibrationSegments : null,
      computeWindowBars: posInt(bf.computeWindowBars) ? bf.computeWindowBars : null,
      maxSymbolsPerRun: posInt(bf.maxSymbolsPerRun) ? bf.maxSymbolsPerRun : null,
      // { strategyKey: ms } — only positive integers survive; a garbage entry is dropped, never guessed.
      designFloorMs: Object.fromEntries(Object.entries(bf.designFloorMs && typeof bf.designFloorMs === 'object' ? bf.designFloorMs : {}).filter(([k, v]) => /^[a-z0-9_]{1,64}$/.test(k) && posInt(v))),
      // Amendment area 1: the run's declared limits; a missing one is null and the job refuses to start.
      limits: (() => {
        const l = bf.limits && typeof bf.limits === 'object' ? bf.limits : {}
        const fm = l.fastMonitor && typeof l.fastMonitor === 'object' ? l.fastMonitor : {}
        return {
          workerMemoryMb: posInt(l.workerMemoryMb) ? l.workerMemoryMb : null,
          maxRuntimeMs: posInt(l.maxRuntimeMs) ? l.maxRuntimeMs : null,
          maxTempBytes: posInt(l.maxTempBytes) ? l.maxTempBytes : null,
          maxCells: posInt(l.maxCells) ? l.maxCells : null,
          maxTransactionRows: posInt(l.maxTransactionRows) ? l.maxTransactionRows : null,
          maxPullsPerMinute: posInt(l.maxPullsPerMinute) ? l.maxPullsPerMinute : null,
          maxSkippedTicksDelta: Number.isInteger(fm.maxSkippedTicksDelta) && fm.maxSkippedTicksDelta >= 0 ? fm.maxSkippedTicksDelta : null,
          maxBusyShare10m: finite(fm.maxBusyShare10m) && fm.maxBusyShare10m > 0 && fm.maxBusyShare10m <= 1 ? fm.maxBusyShare10m : null,
          pollMs: posInt(l.pollMs) ? l.pollMs : null,
        }
      })(),
    },
  }
}

/**
 * Per-run overrides from a request body or query, applied over the file's
 * values with the same validation. Returns the merged section and the list
 * of keys the request changed, so the run can record them.
 */
export function withOverrides(section, overrides = {}, spec = {}) {
  const out = { ...section }, changed = []
  for (const [key, rule] of Object.entries(spec)) {
    if (overrides[key] === undefined) continue
    const v = rule.list ? numberList(overrides[key], rule) : (rule.int ? (posInt(Number(overrides[key])) ? Number(overrides[key]) : null) : overrides[key])
    if (v == null || (Array.isArray(v) && !v.length)) continue
    out[key] = v; changed.push(key)
  }
  return { value: out, overridden: changed }
}
