# 04 — Effective risk configuration: make the route truthful

Phase 4 of the Verified Defect Repair prompt. **No threshold was changed.**
`minRR` remains 3.0 on the four demo accounts and 4.5 on live `42993489`,
exactly as the owner set them.

---

### R4-1 — An unsupported query parameter silently returned the global configuration

**Classification:** `CORRECTNESS FIX`
**Severity:** high — it is how a risk limit came to be misread by everyone,
including this audit
**Confidence:** high
**Status:** reproduced at HEAD
**SHA:** `9101eb4` (pre-fix)
**Scope:** `agent/routes/state.js` → `GET /state/risk-full`

#### Observation

The route read exactly one thing:

```js
const acct = req.query?.account ? String(req.query.account) : null
```

Every other parameter was discarded without comment. So `?accountId=47790949`,
`?acct=47790949`, or any typo, returned **HTTP 200 with the global
configuration** — presented in the same shape as an answer about that account.

#### Causal chain

That is the mechanism behind the audit's central finding. The Risk page showed
`minRR 1.5`; the accounts were gated at 4.5–6.16; both readings came from this
route. A silently-ignored parameter is worse than a rejected one: it answers a
question nobody asked, in the shape of the question they did, and nothing in
the response says which question it answered.

#### Minimum sufficient remedy

`unknownQueryParams(query, ['account'])`. Anything unrecognised is a **400**
naming what was unsupported and what is supported. Both existing frontend
callers (`Risk.jsx:272`, `Performance.jsx:1177`) send only `?account=`, so no
UI path is affected.

#### Regression proof

`agent/routes/risk-account-routes.test.js` — `?accountId=47790949` must be a
400 with `unsupported: ['accountId']`. It returned 200 before this change.

---

### R4-2 — An unknown account id was indistinguishable from a known one

**Classification:** `CORRECTNESS FIX`
**Severity:** medium
**Status:** reproduced
**Scope:** same route

#### Observation

Three states collapsed into two response shapes:

| Request | Before | After (`risk.accountScope`) |
|---|---|---|
| no `?account=` | global config | `global` |
| known account | global + overlay | `account` |
| id the registry never heard of | global config, **identical shape** | `unknown_account` |
| registry unreadable | — | `account_unverified` |

The third row is the dangerous one: a mistyped account id showed plausible
numbers that belonged to nobody, with nothing on screen to say so.

`?account=all` now reports `unknown_account`, which is accurate — there is no
portfolio-wide risk configuration, only per-account overlays over a global one.
The frontend never sends it (`Risk.jsx` drops `all` before building the URL).

---

### R4-3 — Global, overlay and effective values were not separable per key

**Classification:** `OBSERVABILITY FIX`
**Status:** reproduced
**Scope:** `agent/services/risk-effective.js` (new)

#### Observation

The route returned `effective`, `defaults`, `overridden`, `overlayKeys` and
`global`. An operator could infer that a key was overlaid, but not read one row
saying *this global value, that overlay value, this effective value, written by
X at Y*. The audit asked for exactly that row.

#### Remedy

`risk.provenance` — one entry per key:

```json
{
  "key": "minRR",
  "globalValue": 1.5,
  "overlayValue": 4.68,
  "effectiveValue": 4.68,
  "scope": "account",
  "accountId": "47790949",
  "source": "manual",
  "writtenAt": "2026-08-06T06:16:00.000Z",
  "writtenBy": "manual",
  "reason": null
}
```

#### Provenance is read, never invented

`risk-config-history.js` already records `{at, from, to, by}` per key on any
write that actually changes a value — **this existed before the audit and the
audit did not credit it.** That is the only honest source available, so:

- `by: 'manual'` → `source: 'manual'`; `by: 'reassess'` → `source: 'controller'`
  (an automatic write must not be indistinguishable from an owner's);
- an unrecognised writer → `source: 'unknown'`, with the raw label still
  reported rather than dropped;
- nothing recorded → `source: 'unknown'`, `writtenAt: null`;
- **`reason` is `null` for every key, because nothing records one.** A
  structurally absent field is stated as absent. Filling it with a plausible
  string would be the fabrication the prompt forbids.

#### Counter-evidence / residual risk

The history is a **map, not an append-only ledger** — one entry per key, so it
answers "when did this last change" and not "every change ever". The prompt
asks for an append-only history with actor, evidence window, code SHA,
approval reference and rollback value. That is a schema change plus a write-site
contract, and it is deliberately **not** in this PR: the existing map already
answers the question the audit actually asked (which value is real and who put
it there), and the fuller ledger should be designed once, against real overlay
writes, rather than bolted to two call sites now.

Also unproved: **who** set the demo accounts to 3.0 and live to 4.5. If the
change history is empty for those keys in production, `source` will read
`unknown` — which is the truthful answer, not a gap in this fix.

---

## Policy boundary

Nothing in this PR reads, writes or proposes a threshold. `minRR`,
`perTradeRiskPct`, `maxRiskCapPct`, daily caps, equity stops, exposure limits,
strategy arming, keeper/ratchet/trail policy: untouched. The one behavioural
change visible to a caller is that a malformed request now fails instead of
answering about something else.

**No live trading action was taken.**
