# Railway log review — 21 September 2026

Owner supplied four JSON exports, named by service. The agent export covers
13:56–14:18 UTC; the executor exports cover startup at approximately 13:36
through configuration at 13:41 UTC. These are different observation windows.

| Service | Evidence in the supplied export |
| --- | --- |
| bot-trade | 22 repeated protection errors: zero naked, three targetless, zero stop disagreements across seven accounts. TP applications are refused for BTCUSD on …0058, ETHUSD on …9908, XRPUSD on …0949. |
| cpp-exec | Four demo accounts authenticated. Recording and shadow switched ON. 59 symbols subscribed. Agent later recorded 153,158 events, zero dropped and one gap, plus demo shadow closes. |
| cpp-acct | Three live accounts authenticated, but `TICK_SPOOL_PATH` unset. The shadow-simulation configuration log is unconditional and does not prove a worker is running. |
| cpp-verify | Journal preparation succeeded and journal reported writable. The success line was sent to stderr, producing Railway's misleading error severity. No completed verification job appears in this short export. |

The agent completed 21 logged loops: median 33.260 seconds, maximum 85.943
seconds. The fast monitor logged 41 overlap skips. Its scheduler defaults to
three seconds with per-position cadences; the independent protection band
defaults to 60 seconds. These logs do not establish every-second decisions or
every-second trailing. Neither executor export contains the trail-engine
startup line.

Controllers read-back around 14:27 UTC agreed: demo recording/shadow ON, live
OFF, all seven accounts TIME_BASED, three demo TPs missing, and three local
records on funded live …3489 unmatched to broker truth. Forty-one demo
positions were checked. The live records must not be counted as verified.

## Corrections

- The main loop reconciled positions only on the selected broker side. Its
  opposite-side sweep read equity alone. Add account-scoped reconciliation
  using a fresh WS response carrying the requested account identity, a
  five-second timeout and no retry. Malformed, failed, wrong-account or
  unnamed-symbol snapshots cause no ledger changes. The broker is read only;
  reconciliation changes local records, not broker positions or entry mode.
- Relinking, close detection and duplicate/P&L cleanup had queries keyed only
  by position id. Scope them to the account being reconciled before extending
  coverage. Preserve the selected account's existing legacy-NULL convention.
- Review found that the two-pass SL/TP convergence watch read globally while
  other-account callers wrote it under account keys. Read and write the same
  explicit per-account key; never inherit an ownerless legacy observation.
- Log the applier's failure reason, attempted TP and retryable status once per
  permitted attempt. Existing retry windows and protection decisions stay in
  force. The former `apply refused` count could not diagnose these failures.
- Send successful verifier journal preparation to stdout; warnings retain
  stderr.

## Still requiring runtime evidence

The three missing TP causes are not established by these exports. A computed
entry-based target can be behind the current market, but this is a hypothesis
until the rejection/read failure is captured. These changes do not claim to
repair those targets. Live tick observation remains disabled pending the
protection/reconciliation read-back. Validation thresholds, automatic entry
selection and account entry modes are unchanged.
