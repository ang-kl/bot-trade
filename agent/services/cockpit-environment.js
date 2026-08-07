// ---------------------------------------------------------------------------
// cockpit-environment.js — PHASE 7 of the cockpit live-wiring prompt:
// environment, macro news and fundamentals STATUS, from the app's own
// sources. No new providers, no new handshakes on the read path.
//
//   session   — symbol-hours (broker schedule when the sidecar captured one,
//               the heuristic session model otherwise). nextOpenAt is only
//               stated when the BROKER schedule says so; the heuristic
//               deliberately returns null rather than inventing a time.
//               There is no exchange-name source in this app, so `exchange`
//               carries the honest fact we do have: the asset class.
//   regime    — the quant phase's regimes table via latestRegime, with its
//               own staleness bound. label/direction verbatim.
//   macroNews — the cached ForexFactory weekly calendar the risk gate's
//               news window already trades on: relevantEvents (currency-
//               matched, High/Medium, capped 4) with real title/currency/
//               impact/scheduled time/minutes-from-now, plus fetchedAt and
//               cache age. The gate sub-block states the distinction the
//               prompt demands: the calendar gate blocks NEW entries only —
//               it never closes an existing position.
//   fundamentals — not_ingested. No provider is configured; per the prompt,
//               any future one must be allowlisted, cached, timestamped,
//               attributable and feature-flagged. Saying so beats an empty
//               array that reads as "nothing happening".
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { relevantEvents, newsWindowEvent, cachedEventsSync } from './news-calendar.js'
import { nextOpenInfo } from './symbol-hours.js'
import { latestRegime } from './regime-gate.js'
import { categoriseSymbol } from '../lib/sessions.js'
import { loadRiskConfig } from './risk.js'

const NEWS_FRESH_MS = 6 * 3600_000 // the calendar's own refetch TTL

export function buildEnvironment(db, symbol, nowMs = Date.now()) {
  // --- session --------------------------------------------------------------
  let session = { state: 'unknown', exchange: null, nextOpenAt: null, source: null }
  try {
    const info = nextOpenInfo(db, symbol, new Date(nowMs))
    session = {
      state: info.open ? 'open' : 'closed',
      // Asset class, not an invented exchange name — none exists in this app.
      exchange: categoriseSymbol(symbol),
      nextOpenAt: info.next_open_at ?? null,
      source: info.source === 'broker' ? 'broker symbol-hours schedule' : 'heuristic session model (no broker schedule captured)',
    }
  } catch { /* stays unknown */ }

  // --- regime ---------------------------------------------------------------
  let regime = { label: null, direction: null, asOf: null, source: 'regimes table (quant phase)', status: 'no_data' }
  try {
    const r = latestRegime(db, symbol)
    if (r) {
      regime = {
        label: r.regime,
        direction: r.trend_direction ?? null,
        asOf: r.computed_at,
        ...(r.ageMin != null ? { ageMin: r.ageMin } : {}),
        source: 'regimes table (quant phase)',
        status: r.stale ? 'stale' : 'live',
      }
    }
  } catch { /* stays no_data */ }

  // --- macro news -----------------------------------------------------------
  let macroNews = { events: [], source: 'ForexFactory weekly calendar (cached)', fetchedAt: null, cacheAgeMs: null, status: 'no_data' }
  try {
    const fetchedMs = Number(getState(db, 'news_calendar_fetched_ms'))
    const haveFetch = Number.isFinite(fetchedMs) && fetchedMs > 0
    const all = cachedEventsSync(db, nowMs)
    const cfg = (() => { try { return loadRiskConfig(db) } catch { return {} } })()
    const inWin = newsWindowEvent(all, symbol, nowMs, {
      minBefore: cfg.newsGateMinBefore ?? 15,
      minAfter: cfg.newsGateMinAfter ?? 15,
      impacts: cfg.newsGateImpacts ?? ['High'],
    })
    macroNews = {
      events: relevantEvents(all, symbol, nowMs).map(e => ({
        title: e.title,
        currency: e.country,           // the feed's field name is `country`; it carries the currency code
        impact: e.impact,
        scheduledAt: new Date(e.t).toISOString(),
        minutesFromNow: Math.round((e.t - nowMs) / 60_000),
        inGateWindow: !!(inWin && inWin.t === e.t && inWin.title === e.title),
      })),
      source: 'ForexFactory weekly calendar (cached by the loop; the same feed the risk gate reads)',
      fetchedAt: haveFetch ? new Date(fetchedMs).toISOString() : null,
      cacheAgeMs: haveFetch ? Math.max(0, nowMs - fetchedMs) : null,
      status: !haveFetch ? 'no_data' : (nowMs - fetchedMs) > NEWS_FRESH_MS ? 'stale' : 'live',
      // The prompt: "Distinguish existing-position management from new-entry
      // gating." The calendar gate VETOES new entries; it never closes what
      // is already open — that stays with SL/TP and the managers.
      gate: {
        enabled: cfg.newsGateEnabled === true,
        appliesTo: 'new entries only — an existing position is not closed by the calendar gate',
        activeEvent: inWin
          ? { title: inWin.title, currency: inWin.country, impact: inWin.impact, scheduledAt: new Date(inWin.t).toISOString() }
          : null,
      },
    }
  } catch { /* stays no_data */ }

  return {
    session,
    regime,
    macroNews,
    fundamentals: {
      items: [],
      source: null,
      status: 'not_ingested',
      detail: 'no fundamentals provider is configured — any future provider must be allowlisted, cached, timestamped, attributable and feature-flagged',
    },
    status: 'derived',
  }
}
