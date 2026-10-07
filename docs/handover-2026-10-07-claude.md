# Handover — Claude · № 11,788 · 07-10-2026 14:1x SGT (claude-builder)

For Codex (and the owner). What Claude built, merged and measured on 07-10-2026
from the owner's rebase at № 11,571 (05:05 SGT) to this note, what is live in
production, what is open, and the rules both agents work under. Session:
https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2

## 1. Merged today, in order (all squash-merged on main under the standing gate)

| PR | SHA | What |
|---|---|---|
| #1243 | 31ad4b14 | Guardian sweeps every enabled registered account on both sides, one `/trail-config` union per side, plus a backstop sweep; `GET /state/trail-status?account=<id>` (engine-side read). |
| #1245 | 62276a2c | F·1: the shared sidecar HTTP server's slow-request line to stdout, stderr only past 5 s (four byte-identical copies). A refused `/trail-config` push is recorded, logged and read back as `lastPushRefusal`. Codex's findings on #1243 (withheld push on a failed pass; backstop gated on active rows; read-back cursor per own rows) and on #1245 (`trailSpecsComplete`). |
| #1246 | a1a2f679 | TrailEngine ON by default in cpp-exec (`TRAIL_TICK_ENABLED` only opts out with the literal `false`); goal-tracker test hardened; Card ⇲ maximize overlay portalled to `document.body` (the `.glass-panel` backdrop-filter made the card the containing block of the fixed overlay). |
| #1248 | 0aca9fca | Codex P1 on #1246: the keeper's and the trade guard's stop amends are **ratchet transactions** (`ratchetOnly`, `expectedDirection`, `expectedSymbolId`); the sidecar re-reads the broker's stop under the position's lock and answers `unchanged` instead of widening; `unchanged` is counted (`alreadyTighter`), not announced; the row's `current_sl` takes the broker's confirmed stop. A ratchet amend has no JS fallback. |
| #1249 | a626227d | Codex P1 on #1248: the guard's `expectedSymbolId` from the account's own snapshot. Plus the C·1 registry re-anchor payload, rollback, evidence and builder (NOT applied, see §4). |
| #1250 | 18cacd4e | Codex P1 on #1249: the guard's quote and pip metadata by the snapshot's symbol id (superseded the same day by Codex's #1251, which refuses a row without a broker symbol identity — the stricter rule, kept). |
| #1253 | f0d5764a | Trail-config **push cadence cap**: `trailSetDigest(specs)`; a side's union is pushed when the digest changed or 60 s passed since the last accepted push; a refused push retries next sweep. Measured after deploy: from a push every 4–8 s to about one a minute. |
| #1254 | (open at this note) | Codex P1 on #1253: whether a stop is KNOWN joins the digest (`sl`/`nosl`), its value still does not, so the arming push after the keeper's own first stop is never withheld. |

Codex's own PRs today, merged by the owner: #1247 (Signals eligibility), #1251 (guard refuses rows without a broker symbol identity), #1252 (live market cards / Performance tables).

## 2. Production state (measured, not assumed)

- `TRAIL_TICK_ENABLED` is **deleted** on cpp-exec and cpp-acct (the owner, 04:11Z). Both gateways log "tick-level trail engine started". `/state/trail-status?account=46979908` → `enabled: true`, `lastPushRefusal: null`, 5 tracked across …9908/…7342/…0949, stop policy Opposite + trailing-on-lock. Live side `enabled: true`; a live position appeared at 06:07Z (1 spec pushed for the live side).
- Node log, 06:09:26Z: `trail-config 5 spec(s) pushed for the demo side (accepted; 5 unchanged sweep(s) since the last push)`.
- Engine amend counters (`amendsOk`/`amendsFailed`) were still 0/0 at 05:47Z: no tick had yet improved a stop by a tenth of the trail distance. The first non-zero `amendsOk` is the proof the engine trails; nobody has seen it yet.
- `SCANNER_BRIDGE_ENABLED` on bot-trade: Claude set it to `0` at 04:04Z (first step of the re-anchor procedure); the owner set it back to `1`. It is `1` now.
- The scanner registry is **unchanged**: revision 5bd5533f, 902 profiles. See §4.

## 3. Conventions both agents follow (owner-confirmed)

- **Serial ratchet.** One sequence for both agents; each ratchets on the highest stamp it can see, with the session name on the stamp. Claude's last stamp at this note: № 11,788. Codex's #1251 commit reads № 11,737.
- **Dated serial comments in code**: `// Claude · № 11,760 07-Oct (…)` / `// Codex · №11,737 · 2026-10-07; codex-footprint: …`.
- **Lock file** on branch `agent-locks` (`.agent-lock.json`): add an entry when a PR starts, remove it when it merges; `notes[]` carries cross-agent notes (one from Claude at № 11,736 is there).
- **Codex findings on a merged PR are fixed in the next PR**, named in its title. Every one of Codex's P1s today was confirmed real and fixed the same hour.
- **Stop writers**: any new amend of a stop on a managed or guarded row carries `ratchetOnly: true`, `expectedDirection` (±1), `expectedSymbolId` (from THIS account's broker snapshot, never the shared map), and handles `unchanged: true` as "not a move" (no count, no notice, row takes `result.protection.stopLoss`). The sidecar's ratchet path is the only writer allowed to widen nothing.
- **Trail digest contract** (`agent/services/guardian.js: trailSetDigest`): a push is "new" when the position set, `trailDistance`, `digits`, `dir`, `symbolId`, `currentTp`, `entryPrice` or stop-known changes. `currentSl`'s value and `peakPrice` are NOT in it on purpose (the engine keeps its own tighter stop and further peak across a configure). If you add a field the engine acts on at ingest, add it to the digest and its test.
- **CLAUDE.md ledger line** rides every code PR; two of Claude's lines today carry a guessed time (written 05:52 stamped "06:00"; written 06:10 stamped "06:12"), disclosed at № 11,768·C and № 11,786·D.

## 4. Open — the owner's

**4.1 Scanner registry re-anchor (C·1, the "two silent demo tick feeds").** Not a feed fault. The registry anchors 53 demo tick + all 690 timeframe profiles on 46979908 and 53 live tick profiles on 43069009, while the gateways stream from 46130058 (demo) and 42993489 (live); those 796 profiles can never receive a quote, the verifier calls the feeds silent, and the native timeframe scanner matches 0 of 690 (`/state/scanner-mirrors` → `bridge.timeframeCoverage.matchingProfiles: 0`).

The payload (902 → 796: the 106 dead tick anchors dropped, the 690 timeframe profiles moved to 46130058 with identical symbol ids; proposed revision a8a740a9), its rollback and evidence are in `docs/scanner-realign-2026-10-07.json`, `docs/scanner-realign-rollback-2026-10-07.json`, `docs/scanner-realign-evidence-2026-10-07.json`; the builder is `scripts/build-scanner-realign-2026-10-07.mjs` (in-memory registry round trip, no production writer). Claude's permission classifier refused the compare-and-set twice; it is the owner's to run:

```
curl -X POST "https://sg-trade.up.railway.app/actions/scanner-profiles" \
  -H "Authorization: Bearer $AGENT_SECRET" -H "Content-Type: application/json" \
  --data-binary @docs/scanner-realign-2026-10-07.json
```
200 with `revision` a8a740a9… = applied; 409 `profile_revision_conflict` = the registry moved, rebuild from a fresh `/state/scanner-alignment-snapshot`. **Codex: do not register profiles or move the selected account until this lands; after it, timeframe profiles live on 46130058.**

**4.2 Not yet verified by anyone**: the Card ⇲ overlay fix (#1246) in a real browser; the live engine's first amend (`amendsOk > 0` on `/state/trail-status?account=42993489`).

## 5. Open — engineering, none ordered

- Position 1722 (DOW.US on …9908): management stalled on `quote_unavailable` since 06-10 19:54Z (verifier work item `position:1722`, `lastCompletedAtMs` unchanged). Likely the US-stock calendar, but the stall survived the open. Read the management journal against the DOW.US calendar before touching anything.
- The sweep still fires on demo ticks every 2.5 s (`cooldownMs`); only the push is capped. Fine while the guards and keeper are cheap.
- `agent-locks` notes: prune the № 11,736 note once 4.1 lands.

## 6. Read-backs (bearer `AGENT_SECRET_READ`)

```
GET /state/trail-status?account=46979908      # enabled, lastPushRefusal, tracked, amendsOk/Failed, positions
GET /state/trail-status?account=42993489      # live side
GET /state/scanner-mirrors                    # bridge.timeframeCoverage, candidates by account
GET /state/scanner-alignment-snapshot         # registry revision, profiles by feed anchor, tickFeeds observed
GET /state/tick-recorder, /state/tick-readiness
Railway bot-trade logs, filter "pushed for the" — the push cadence line
```
