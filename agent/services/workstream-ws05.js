// ---------------------------------------------------------------------------
// agent/services/workstream-ws05.js — WS-05 (Live Trade Management and Exit)
// as a workstream you can point at, not a habit spread across nine files.
//
// §70.1: "Establish WS-05 as an independent workstream." §69.5.1: "Make WS-05 a
// first-class programme workstream."
//
// WHAT WAS ACTUALLY MISSING. Every piece of WS-05 exists and runs — the tick
// guardian, the trade guards, the profit keeper, the loss guardian, the loss
// cap, the profit ratchet, the minute review, the protection audit, the
// reconciler, the C++ trail engine. What did not exist was the WORKSTREAM:
// nowhere could you ask "is live trade management healthy right now, and by
// what authority is each part of it acting". The plan's own audit put it as
// "WS-05 stop-loss authorities: partially source-traceable; needs runtime
// precedence" (docs/agent-graph-audit-2026-08-03.md).
//
// The pieces already declared individually:
//   · services/management-state.js — the §40 states, the §41 authorities, which
//     writer holds which, and (since §70.6) which rule fires on which trigger
//   · services/heartbeat.js — whether each controller is beating
//   · services/position-events.js — what each one actually did
//
// This composes them into ONE answer. It is deliberately a READ: a workstream
// that also acted would be a tenth writer on the same positions, which is the
// exact failure §36.2.3 warns about ("two components must not unknowingly write
// the same stop").
//
// WHY THAT IS WORTH A MODULE. §30.2 — "a five-minute strategy scan is not
// sufficient as the sole mechanism for managing exposed capital" — is a claim
// about the SYSTEM, and until now nothing could evaluate it. Three of these
// members were on the 5-minute loop as recently as 04-08-2026, and the way that
// was found was reading loop.js, not asking. A workstream that reports its own
// response-speed layers can answer §36 by being queried.
// ---------------------------------------------------------------------------

import { CONTROLLERS, heartbeatView } from './heartbeat.js'
import { WRITER_AUTHORITY, AUTHORITIES, rulesForWriter, triggerForRule } from './management-state.js'

/**
 * The workstream's identity, straight from the plan so the code and the
 * document cannot drift apart silently.
 */
export const WS05 = Object.freeze({
  id: 'WS-05',
  name: 'Live Trade Management and Exit',
  goal: 'Protect and manage every open position continuously from the moment it is filled until final broker-confirmed closure.',
  boundary: 'Begins when a position is filled or adopted from the broker. Ends only after broker-confirmed closure and transfer to post-trade reconciliation.',
})

/**
 * The §36 response-speed layers, and which controller answers for each.
 *
 * `controller` is a heartbeat key where one exists. `broker_native` has none on
 * purpose and says so: it runs AT THE BROKER, which is the entire point of
 * §36.1 — it must keep working when this process, its database, the network and
 * Telegram are all unavailable. A layer reporting "healthy" because our own
 * heartbeat is beating would be describing the wrong machine.
 */
export const LAYERS = Object.freeze([
  {
    id: 'broker_native', label: 'Layer 0 — broker-native protection', authority: 'broker_native',
    speed: 'immediate, at the broker', controller: null,
    note: 'Stop-loss and take-profit held by the broker. No heartbeat by design: it survives this process being down, which is what it is for.',
  },
  {
    id: 'tick_safety', label: 'Layer 1 — tick / price-event safety', authority: 'tick_safety',
    speed: 'each relevant tick', controller: 'guardian',
    note: 'The tick guardian, plus the C++ trail engine which ratchets stops in-process at the broker connection.',
  },
  {
    id: 'cpp_trail', label: 'Layer 1b — C++ trail engine', authority: 'tick_safety',
    speed: 'each tick, out of process', controller: 'cpp_exec',
    note: 'The one management rule that already runs outside Node. Node reads its result back and journals trail_tightened.',
  },
  {
    id: 'fast_manager', label: 'Layer 2 — fast manager (60s band)', authority: 'fast_manager',
    speed: '60 seconds', controller: 'fast_monitor',
    note: 'Trade guards, profit keeper, loss guardian and the protection audit. Moved off the 5-minute loop on 04-08-2026 (§70.7).',
  },
  {
    id: 'per_minute_policy', label: 'Layer 3 — per-minute policy review', authority: 'per_minute_policy',
    speed: '60 seconds', controller: 'minute_review',
    note: 'Reads and reports; writes nothing to a position. Owner-override detection lives here (§70.4).',
  },
  {
    id: 'bar_close_strategy', label: 'Layer 4 — bar-close strategy', authority: 'bar_close_strategy',
    speed: '5 minutes', controller: 'main_loop',
    note: 'The strategy cycle. §30.2: never the sole protector of exposed capital — the layers above exist so it is not.',
  },
  {
    id: 'reconciliation', label: 'Layer 5 — reconciliation', authority: 'reconciliation',
    speed: 'each reconcile pass', controller: 'protection_audit',
    note: 'Broker truth versus our book, including whether every open position is actually protected right now.',
  },
])

/** Every controller this workstream depends on, deduped, in layer order. */
export function memberControllers() {
  return [...new Set(LAYERS.map(l => l.controller).filter(Boolean))]
}

/**
 * Which writers belong to WS-05, with the authority each holds and the rules it
 * owns. Derived from WRITER_AUTHORITY rather than listed again here — a second
 * list is a second thing to forget to update, and this workstream exists partly
 * because that had already happened twice (loss_guardian and two other writers
 * were absent from the heartbeat registry until 04-08-2026).
 */
export function members() {
  const inScope = new Set(['tick_safety', 'fast_manager', 'per_minute_policy', 'bar_close_strategy', 'reconciliation', 'emergency_control'])
  return Object.entries(WRITER_AUTHORITY)
    .filter(([, authority]) => inScope.has(authority))
    .map(([writer, authority]) => {
      const rules = rulesForWriter(writer)
      return {
        writer,
        authority,
        // Authorities are ordered strongest-first in management-state.js, so
        // the index IS the precedence — the "runtime precedence" the audit said
        // was missing, read from the same table the arbitrator uses.
        precedence: AUTHORITIES.indexOf(authority),
        rules: rules.map(r => ({ rule: r, trigger: triggerForRule(r) })),
      }
    })
    .sort((a, b) => a.precedence - b.precedence)
}

/**
 * The workstream's health, as one object.
 *
 * `healthy` is deliberately conservative: a member controller whose state
 * cannot be read counts as unhealthy, because "we do not know whether live
 * trade management is running" and "it is running" must not render the same.
 *
 * @returns {{workstream, layers, members, healthy, degraded: string[], unknown: string[]}}
 */
export function ws05Health(db) {
  let beats = {}
  try {
    // heartbeatView returns an ARRAY keyed by `name`, and it always includes
    // every registered controller — an unrun one arrives as status 'idle'
    // rather than being absent.
    for (const row of heartbeatView(db)) if (row?.name) beats[row.name] = row
  } catch { beats = {} }

  const degraded = []
  const unknown = []
  const layers = LAYERS.map(l => {
    if (!l.controller) return { ...l, status: 'broker', ok: true }
    const b = beats[l.controller]
    if (!b) {
      // A member with no heartbeat row is NOT reported as fine. This is the
      // exact shape of the loss_guardian defect: it beat a name the registry
      // did not know, so the panel simply never showed it, and the one writer
      // whose job is to put a stop on a naked position was invisible for weeks.
      unknown.push(l.controller)
      return { ...l, status: 'unknown', ok: false }
    }
    // 'idle' means registered but never run — for a protection layer that is
    // not "fine yet", it is "we have no evidence this has ever run", and it
    // must not read as healthy. 'warn' is a run with recent failures behind it;
    // it stays healthy because the pass did complete.
    const ok = b.status === 'ok' || b.status === 'warn'
    if (b.status === 'idle') unknown.push(l.controller)
    else if (!ok) degraded.push(l.controller)
    return { ...l, status: b.status, ok, lastRunAt: b.last_run_at ?? null, ageSec: b.age_sec ?? null }
  })

  return {
    workstream: WS05,
    layers,
    members: members(),
    // Every registered member controller, so a reader can see the ones this
    // workstream claims without cross-referencing heartbeat.js by hand.
    registered: memberControllers().filter(k => k in CONTROLLERS),
    healthy: degraded.length === 0 && unknown.length === 0,
    degraded,
    unknown,
  }
}
