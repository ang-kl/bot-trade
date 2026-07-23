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
import { loadRiskConfig, getAccountBalance, computeRiskBasedVolume } from './risk.js'

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
        batch = await wsGetTrendbarsBatch(
          creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
          symbolId, [macroTf, microTf],
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
  const tick = async () => {
    if (stopped) return
    try {
      const r = await runVpoFeeder(db)
      if (r?.ok) console.log(`[vpo-feeder] pushed ${r.bars} bar set(s), ${r.volumes} volume(s)`)
    } catch (err) {
      console.error('[vpo-feeder] pass failed:', err.message)
    }
  }
  const t = setInterval(tick, intervalMs)
  t.unref?.()
  setTimeout(tick, 10_000) // first pass shortly after boot
  return () => { stopped = true; clearInterval(t) }
}
