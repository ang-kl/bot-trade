# Exits on non-primary accounts do not reach their account

**Date:** 2026-07-30 · **Status:** found and pinned by tests; **NOT fixed** ·
**Severity:** high, live-money · **Found by:** Phase 1 (owner-approved
characterisation work, tests only)

## The one-paragraph version

Entries route to the right account. Exits do not. Every close and stop-loss
amendment sent by the exit sweeps omits `ctidTraderAccountId`, so the C++ sidecar
fills in its own **primary** account — and the primary is elected once per broker
session and then frozen. The result is that on every account except the primary,
positions open normally and are then never managed: the stop ratchet, the giveback
close, the loss cap, the time cap and the weekend bank all fail with
`POSITION_NOT_FOUND`, each one logging and carrying on by design. Seen from the
outside that looks exactly like *"autotrade drops from the accounts and I don't
see any trades"*.

Nothing has been changed. The behaviour is now pinned by
`agent/multi-account-routing.characterisation.test.js` (20 tests), so the fix
will be visible as those tests changing.

## The mechanism, in three parts

**1. Exit payloads carry no account.** Twelve call sites pass a `positionId` and
nothing else:

| File | Line | Call |
| --- | --- | --- |
| `agent/services/profit-keeper.js` | 324, 340 | `closePosition` |
| `agent/services/profit-keeper.js` | 355 | `amendPosition` |
| `agent/services/loss-guardian.js` | 194 | `closePosition` |
| `agent/services/loss-guardian.js` | 203 | `amendPosition` |
| `agent/services/profit-ratchet.js` | 144 | `closePosition` |
| `agent/services/loss-cap.js` | 129 | `closePosition` |
| `agent/services/weekend-bank.js` | 72 | `closePosition` |
| `agent/services/trade-guard.js` | 155 | `amendPosition` |
| `agent/services/trade-guard.js` | 167 | `closePosition` |

The entry paths already stamp it — `loop.js:418`,
`services/pending-orders.js:332`, `services/closed-market-limits.js:48` — and so
do `cancelOrder` and `reconcile` inside `exec-engine.js`. **The gap is exits, and
only exits.**

**2. The sidecar fills in the primary.** `cpp-exec/src/engine.cpp:276-280`:

```cpp
static jsn::Value withAccountId(const jsn::Value& payload, long long accountId) {
  jsn::Value p = payload.isObject() ? payload : jsn::Value{jsn::Object{}};
  if (p.get("ctidTraderAccountId").isNull()) p.set("ctidTraderAccountId", accountId);
  return p;
}
```

`/order`, `/amend`, `/close` and `/cancel` all pass `primaryAccountLocked()` as
that default (engine.cpp:317, 330, 337, 344), and the primary is
`accountIds_.front()` (engine.hpp:114).

**3. The primary is frozen, not merely stale.** This is the part that reading the
Node side alone gets wrong, and I got it wrong on the first pass.
`setCredentials` (engine.cpp:63-107) has two branches:

- **`sameSession`** — same host, app and access token on a live authed session.
  It *appends* any not-yet-authorised ids and leaves `accountIds_` otherwise
  untouched. **The primary does not move.**
- **fresh session** — a different host/app/token, or nothing live yet. It clears
  `accountIds_`, sets the primary from the pushed `accountId`, and forces a
  reconnect.

So once a session is up, pushing `/connect` with a different `accountId` adds
that account and changes nothing about where unstamped operations go. The primary
is whatever the *first* push after a reconnect named, for the life of that
session.

Node makes this harder to see in two ways, both pinned as tests:

- `ensureSidecarSession` keys its memo on `[...creds.accountIds].sort()`
  (`exec-engine.js:110-113`), which discards the ordering `ctrader-creds.js:46`
  deliberately builds (`[primary, ...others]`). `[A,B]` and `[B,A]` hash the
  same, so switching account doesn't even re-push.
- When it *does* re-push — the roster-less creds hand-assembled at
  `loop.js:517` — Node believes it switched account and the sidecar takes the
  `sameSession` branch and does not.

## What the tests prove

`agent/multi-account-routing.characterisation.test.js`, against
`agent/test-support/fake-broker.js` — a two-account fake of the sidecar that
keeps a ledger per account and records, for every operation, whether its account
came from the caller or was filled in from the primary.

- An entry stamped for B lands on B; nothing appears on A.
- An unstamped `closePosition` with B's credentials is executed against A,
  `resolvedBy: 'primary'`, and B's position is **still open** afterwards.
- The same for `amendPosition`: the protective stop is never moved.
- Three consecutive close attempts all fail the same way — retrying cannot fix a
  routing bug.
- A token refresh re-elects the primary, and then *the very same unstamped
  close succeeds*. That is the cleanest demonstration that the code is fine and
  the routing is not.
- When the primary happens to be the intended account, everything passes. This
  is why the defect is invisible on a single-account desk and invisible on the
  primary account of a multi-account desk.

The fake also covers reconnects (including the M4 finding that a sidecar which
lost its credentials is never re-pushed until something invalidates the memo),
late responses via gates rather than sleeps, per-account rejects with the error
text `loop.js` substring-matches on, and the `exec-fallback` asymmetry that
allows a `NOT_CONNECTED` write to retry on the JS path while refusing every
ambiguous failure.

## What this does NOT establish

- **Whether a `positionId` can collide across two accounts under one cTID is
  UNVERIFIED.** It is not in the public cTrader API docs and this session has no
  live multi-account data to test it against. If ids cannot collide, the symptom
  is the one above: exits fail and positions stay open. If they can, the same
  code path closes a position on the **wrong account**. The fix is identical
  either way, which is why the question is recorded rather than resolved — but it
  decides whether this is "positions go unmanaged" or "positions get closed on
  the wrong account", and it should be answered before Phase 2 ships.
- **Whether this is what happened on 2026-07-30.** Production is not reachable
  from this session, so the connection between this mechanism and the owner's
  report remains a hypothesis with a matching signature, not a confirmed
  diagnosis. Confirming it needs the production `action_log` /
  `position_events` for a non-primary account: the signature is entries
  succeeding and every subsequent close/amend on the same position failing with
  `POSITION_NOT_FOUND`.

## The fix, for Phase 2 — not applied here

Stamp the account at the chokepoint rather than at twelve call sites:
`placeOrder`, `amendPosition` and `closePosition` in `agent/lib/exec-engine.js`
already receive `creds`, so each can default
`ctidTraderAccountId` from `creds.accountId` exactly the way `cancelOrder`
already does at line 323. That is one edit per function, it cannot be forgotten
by a new caller, and it makes the sidecar's `withAccountId` default unreachable
from Node.

Two things to do alongside it:

1. **Drop the `.sort()` from the memo key**, or key on the primary explicitly.
   Sorting a list whose order is load-bearing is the bug that hid this one.
2. **Decide what an unstamped operation should do in the sidecar.** Defaulting to
   the primary is a silent mis-route. Refusing it outright would have surfaced
   this on the first non-primary exit. That is a C++ behaviour change and needs
   the owner's call.

Neither is in this PR. Phase 1 was scoped to tests, and the value of stopping
here is that the fix now has a failing-test target rather than an argument.
