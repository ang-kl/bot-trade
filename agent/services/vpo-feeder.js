// ---------------------------------------------------------------------------
// agent/services/vpo-feeder.js — pushes real trendbars and real risk.js-
// computed position size to the C++ Virtual Pending Order sidecar (POST
// /vpo-config) on a timer. This is the ONLY place that fetches bars or
// computes sizing for VPO — cpp-exec never invents either (see
// doc_reference/cpp-virtual-pending-order-engine.md and
// cpp-exec/src/vpo_config_store.hpp's "no parallel sizing/indicator source
// of truth" contract). A dead/disabled feeder just means the sidecar's
// cached bars/volume age out (VpoConfigStore's staleness check) and the
// dispatcher stops arming/firing — fails safe, not silently stale.
//
// Config lives in agent_state:
//   vpo_enabled       'true' to run the feeder at all (default 'false')
//   vpo_config_json   [{ key, symbol, symbolId, macroTf, microTf }, ...]
//                      — MUST match cpp-exec's VPO_SYMBOLS env (same
//                      symbol/symbolId/key triples) or the sidecar has
//                      nowhere to file the pushed bars/volume.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { getCtraderCreds } from '../lib/ctrader-creds.js'
import { loadRiskConfig, getAccountBalance, computeRiskBasedVolume, persistRiskEvent } from './risk.js'
import { evaluateGlobalGuards } from './global-guards.js'
import { newsWindowEvent, cachedEventsSync } from './news-calendar.js'

// ---------------------------------------------------------------------------
// Pre-arm risk gate (owner-approved build 5, 2026-07-27 — audit finding
// F-L4-01/DR-1: the C++ tier's tryFire→placeOrder path never touches
// risk.js's evaluateTrade, so a VPO-armed strategy traded with the news
// gate, duplicate-symbol veto, and global halt all bypassed). The sidecar's
// only sizing source is the volume THIS feeder pushes, and its fire site
// hard-refuses a non-positive volume (vpo_dispatcher.cpp:99-116, recorded
// as no_sizing) — so vetoing here, by pushing -1, closes the bypass without
// touching C++. Cheap sync checks only, mirroring evaluateTrade's own 0/0b
// sections; the full gate (Kelly, margin shrink, exposure caps) still can't
// run pre-arm because there is no concrete entry/SL yet — this is the
// subset that needs no proposal to evaluate.
// ---------------------------------------------------------------------------
export function vpoPreArmVeto(db, cfg, symbol) {
  const gg = evaluateGlobalGuards(db)
  if (!gg.ok) return gg.reason

  const dup = db.prepare(
    `SELECT COUNT(*) AS n FROM monitored_positions WHERE status = 'active' AND symbol = ?`
  ).get(symbol)?.n || 0
  const dupTrades = db.prepare(
    `SELECT COUNT(*) AS n FROM trades WHERE status = 'open' AND symbol = ?`
  ).get(symbol)?.n || 0
  if (dup + dupTrades > 0) return `duplicate_symbol: ${symbol} already has an open position — VPO must not stack`

  if (cfg.newsGateEnabled) {
    const ev = newsWindowEvent(cachedEventsSync(db), symbol, Date.now(), {
      minBefore: Number(cfg.newsGateMinBefore) || 15,
      minAfter: Number(cfg.newsGateMinAfter) || 15,
      impacts: Array.isArray(cfg.newsGateImpacts) && cfg.newsGateImpacts.length ? cfg.newsGateImpacts : ['High'],
    })
    if (ev) return `news_window: ${ev.impact} ${ev.country} ${ev.title}`
  }

  // Margin-level floor (build 3's key; undefined on configs predating it → skip).
  if (cfg.marginLevelFloorPct != null && Number.isFinite(Number(cfg.marginLevelFloorPct))) {
    try {
      const snap = JSON.parse(getState(db, 'broker_snapshot_cache_json') || 'null')
      const lvl = snap?.account?.health?.marginLevelPct
      const ageMs = snap?.fetchedAt ? Date.now() - Date.parse(snap.fetchedAt) : Infinity
      if (Number.isFinite(lvl) && ageMs < 5 * 60_000 && lvl < Number(cfg.marginLevelFloorPct)) {
        return `margin_level_floor: live margin level ${lvl.toFixed(1)}% < floor ${Number(cfg.marginLevelFloorPct)}%`
      }
    } catch { /* unreadable snapshot → fail open, same as the main gate */ }
  }
  return null
}

function execBase() {
  return process.env.EXEC_URL || 'http://127.0.0.1:8091'
}

async function pushToSidecar(payload) {
  const res = await fetch(execBase() + '/vpo-config', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.EXEC_SECRET || ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`vpo-config push ${res.status}: ${text}`)
  }
}

function getVpoConfig(db) {
  try { return JSON.parse(getState(db, 'vpo_config_json') || '[]') } catch { return [] }
}

// Deep enough for the sidecar's Cup & Handle (kChMinBars = 210), with headroom.
const VPO_FETCH_BARS = 260

/** One feeder pass: fetch bars + resolve sizing for every configured entry, push once. */
export async function runVpoFeeder(db, deps = {}) {
  if ((getState(db, 'vpo_enabled') || 'false') !== 'true') return { skipped: 'vpo_enabled is not true' }
  const entries = getVpoConfig(db)
  if (!entries.length) return { skipped: 'vpo_config_json is empty' }

  const creds = getCtraderCreds(db)
  if (!creds?.ready) return { skipped: 'cTrader credentials not ready' }

  const { wsGetTrendbarsBatch } = deps.ws || await import('../lib/ctrader-ws.js')
  const { getVolumeMeta, lotsToVolume } = deps.sizing || await import('../lib/lot-sizing.js')
  const push = deps.push || pushToSidecar

  const cfg = loadRiskConfig(db)
  const balance = getAccountBalance(db)

  const barsOut = []
  const volumesOut = []
  const seenBarKeys = new Set()
  const batchCache = new Map() // symbol -> {macroTf,microTf} batch, avoid refetching per duplicate symbol

  for (const entry of entries) {
    const { key, symbol, symbolId, macroTf = '4h', microTf = '15m' } = entry || {}
    if (!key || !symbol || !symbolId) continue
    try {
      const cacheKey = `${symbol}|${macroTf}|${microTf}`
      let batch = batchCache.get(cacheKey)
      if (!batch) {
        // Explicit depth. This defaulted to 150 (ctrader-ws.js), and the
        // sidecar's Cup & Handle needs 210 (kChMinBars in vpo_strategies.cpp),
        // so cup_handle / inv_cup_handle could never clear their length guard
        // on the VPO path either — armed, and structurally unable to fire.
        // Costs no extra request: the broker limit is 5 REQUESTS/sec, not bars.
        // vp_value slices back to its historical 150-bar window on the C++
        // side so the extra depth does not silently change its value area.
        batch = await wsGetTrendbarsBatch(
          creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
          symbolId, [macroTf, microTf], VPO_FETCH_BARS,
        )
        batchCache.set(cacheKey, batch)
      }
      for (const tf of [macroTf, microTf]) {
        const barKey = `${symbol}|${tf}`
        if (seenBarKeys.has(barKey)) continue
        seenBarKeys.add(barKey)
        const bars = (batch[tf] || []).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
        barsOut.push({ symbol, timeframe: tf, bars })
      }

      // Sizing: same risk.js math the live bot uses, using the tightest
      // allowed stop against the latest micro-bar close as the reference
      // price — mirrors sizing-preview.js's own convention (the LARGEST
      // lots the gate could ever approve; a real armed setup's actual SL
      // distance only ever sizes smaller).
      const micro = batch[microTf] || []
      const lastClose = micro.length ? micro[micro.length - 1].c : null
      // Pre-arm gate BEFORE sizing: a vetoed symbol pushes volume -1, which
      // the C++ fire site hard-refuses (no_sizing) — the bypass-closing seam.
      const vetoReason = vpoPreArmVeto(db, cfg, symbol)
      if (vetoReason) {
        volumesOut.push({ key: `${key}:${symbol}`, volume: -1 })
        try {
          persistRiskEvent(db,
            { symbol, side: null, strategy: `vpo:${key}`, source: 'vpo_pre_arm' },
            { approved: false, veto_reason: `vpo_pre_arm ${vetoReason}` })
        } catch { /* visibility only — never block the push */ }
        console.log(`[vpo-feeder] ${key}/${symbol} VETOED pre-arm: ${vetoReason}`)
        continue
      }
      if (balance != null && lastClose != null) {
        const slDistance = lastClose * (cfg.minSLDistancePct / 100)
        const sized = computeRiskBasedVolume(balance, symbol, slDistance, cfg.perTradeRiskPct, lastClose)
        const meta = await getVolumeMeta(
          creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId,
        )
        const { volume } = lotsToVolume(sized.volume, meta)
        volumesOut.push({ key: `${key}:${symbol}`, volume: volume > 0 ? volume : -1 })
      } else {
        volumesOut.push({ key: `${key}:${symbol}`, volume: -1 })
      }
    } catch (err) {
      console.error(`[vpo-feeder] ${key}/${symbol} failed:`, err.message)
    }
  }

  if (!barsOut.length && !volumesOut.length) return { skipped: 'nothing resolved this pass' }
  await push({ bars: barsOut, volumes: volumesOut })
  return { ok: true, bars: barsOut.length, volumes: volumesOut.length }
}

/** Runs the feeder on an interval until stopped. Mirrors guardian.js's startX(db, ...) shape. */
export function startVpoFeeder(db, intervalMs = 60_000) {
  let stopped = false
  // Overlap guard: a pass walks every configured entry serially, each doing
  // broker round-trips — with a slow broker one pass outlives the 60s
  // interval and copies stack, re-pushing to the sidecar in parallel.
  // `stopped` only covers shutdown.
  let running = false
  const tick = async () => {
    if (stopped || running) return
    running = true
    try {
      const r = await runVpoFeeder(db)
      if (r?.ok) console.log(`[vpo-feeder] pushed ${r.bars} bar set(s), ${r.volumes} volume(s)`)
    } catch (err) {
      console.error('[vpo-feeder] pass failed:', err.message)
    } finally {
      running = false
    }
  }
  const t = setInterval(tick, intervalMs)
  t.unref?.()
  setTimeout(tick, 10_000) // first pass shortly after boot
  return () => { stopped = true; clearInterval(t) }
}
