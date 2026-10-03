# C·6 tick switch-on: the evidence, and the research it needs (03-10-2026)

Owner, 02-10-2026 (№ 10,572·C ¶C·6): "yes" to the tick switch-on and its 24-hour soak. Owner, 03-10-2026 02:2x SGT: "C·6 tick switch-on", then "research".

## What the gate says (read-only, 02-10-2026 18:27Z)

`GET /state/tick-readiness`: all seven accounts `ready: false`, stage UNVALIDATED, on four checks: `profile_pinned` (none), `replay_evidence` (no trial for a pinned profile), `profile_matches_sidecar` (the sidecars run 967c1defd6e78d09, no evidence names it) and `validation_stage`. The chain the gate wants: REPLAY_PASSED (pins a profile) → a 48 h shadow window → SHADOW_PASSED → ready. Nothing here is bypassed; every request that admits tick is refused until `ready` is true.

## What the evidence says

- Replay rung, empty. The trial ledger holds 636 trials; the newest 50 (20-09, profile 498439d200112736, the demo spool's 11-09 segment pair) each have 0 trades. No trial exists for the running profile. Nothing can pass "40 trades, PF ≥ 1.3, max DD 8 R, expectancy lower bound ≥ 0".
- Shadow rung, failing. The shadow portfolio on profile 967c1def (the sidecar fills the strategy's signals on the live quotes, places nothing): demo side 4,483 closed trades since 11-09, win 19 %, PF 0.335, net −2,660 R; live side 3,192 trades since 21-09, win 18.3 %, PF 0.288, net −2,038 R. With today's live filters applied as a counterfactual, the kept subset is PF 0.18. The owner threshold is PF ≥ 1.3. The strategy as deployed loses about 0.6 R per trade; the gate is doing what it was built for.

So the switch cannot be flipped on this evidence. Finishing C·6 means research: a profile that passes replay, deployed to the sidecars, a fresh 48 h shadow, then SHADOW_PASSED — days at best, and only if the research finds something.

## The blockage this change removes (owner principle 3)

`POST /actions/tick-research` could replay only the OLDEST segments a side still lists (`maxSegments`, oldest first, 2 of 1,677,720 records each under the 5,000,000 cap). On 02-10 the sides listed 35 sealed segments (demo 22 from 11-09, live 13 from 27-09); the oldest two are the demo spool's 11-09 weekend pair, replayed already on 20-09 with 0 trades, and no job could reach a weekday recording. `segments: [names]` now names the files: the sync pulls exactly those, the replay reads exactly those, a name not listed by a side nor cached is refused by name, and the record cap is judged on the named set. Tests pin each half; six mutations each turn a named test red.

## The research plan

1. After the US close (20:00Z), one stage-A job per weekday pair, named: live spool 28-09 08:31→29-09 01:35 first, then 29-09, 30-09, 01-10. Each job is the 12-point grid (rangeEvents 128…1024 × minEfficiency 0.25/0.4/0.55; the running profile is the N 256 / E 0.4 point) over about 3.36 M records, in the keeper's worker thread (measured 48.8 s per 200k quotes, so roughly 15 minutes a job). Trials are written to the ledger with their replay verdicts; nothing is pinned, placed or changed.
2. Read the ledger per profile: any (profile, symbol) with ≥ 40 validation trades, PF ≥ 1.3, DD ≤ 8 R?
3. Only for a candidate: the one `includeTest` confirmation run (the holdout opens once), then the owner decides whether `POST /actions/tick-validation` imports REPLAY_PASSED. Then the sidecar profile, then the shadow soak.
4. If nothing passes, C·6 stays closed on this evidence and the owner is told so with the numbers.

## The exits grid (03-10-2026, owner "go for the grid", № 10,777·B·1 → № 10,784)

Nine jobs, one per point, each over the same 28–29-09 live pair as job 1
(`seg-1790584268659-000002.tks` 08:31→15:32Z and `seg-1790609552135-000003.tks`
15:32→01:35Z, 3,355,442 records), the running profile's N 256 / E 0.4 with
`stopVolMult` ∈ {1.5, 2, 3} and the replay sim's `targetR` ∈ {1, 2, 3}; costs
as the sim's class table; 53 trials (symbols) a job, 477 in all, every trial on
the ledger with its replay verdict; nothing pinned. Run 04:36–05:06Z, about
20 s a job (one profile a job, not the 12-point stage-A grid).

| stop × target | trades | net R | exits stop / target / hold | best ≥ 40-trade symbol (PF, lower bound, max DD) |
|---|---|---|---|---|
| 1.5 × 1R | 6 | −4.0 | 4 / 1 / 1 | none with 40 trades |
| 1.5 × 2R | 104 | −61.3 | 76 / 15 / 13 | 10027: 42 trades, PF 0.12, −1.02, 35.6 R |
| 1.5 × 3R | 157 | −109.2 | 123 / 11 / 23 | 10006: 53, PF 0.25, −0.96, 44.9 R |
| 2 × 1R | 21 | −11.7 | 12 / 4 / 5 | none |
| 2 × 2R | 146 | −73.1 | 98 / 18 / 30 | 10006: 50, PF 0.34, −0.84, 35.8 R |
| 2 × 3R | 164 | −96.9 | 114 / 6 / 44 | 10006: 56, PF 0.24, −0.88, 42.7 R |
| 3 × 1R | 95 | −28.9 | 37 / 20 / 38 | none |
| 3 × 2R | 151 | −55.7 | 69 / 8 / 74 | 10006: 52, PF 0.28, −0.70, 29.4 R |
| 3 × 3R | 165 | −70.2 | 82 / 4 / 79 | 10006: 51, PF 0.32, −0.69, 28.0 R |

Verdict: zero of 477 trials clear the owner bar (40 trades, PF ≥ 1.3, max DD
≤ 8 R, expectancy lower bound ≥ 0). Every point loses; the best profit factor
on any symbol with 10 or more trades is 0.62 (10003, 25 trades, 2 × 2R). Wider
stops trade more and lose less per trade but still lose; tighter targets starve
the trade count (the 1R points reject most entries on the cost-to-target
filter). The stop multiple and the target multiple do not rescue this entry
rule on this pair; C·6 stays closed on the evidence, and the next lever is the
entry rule itself (a different N/E point already failed in job 1) or a
different data regime, not the exits.
