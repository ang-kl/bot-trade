# Account view: two accounts shown, every account dynamic — plan

Claude · № 13,098 · 11-10'26 10:10 SGT · claude-builder. Ordered by the owner
at № 13,096's question ("check that all 7 accounts are not hardcoded … reduce
down to 2 accounts dynamically when view … create a .MD first"). Nothing in
this document is built yet; it is the plan the owner approves or amends.

## 1. The audit (read-only, measured 11-10 09:5x SGT)

**The UI is not hardcoded to seven accounts.** Every page takes its account
list from two live sources and iterates it:

| Source | What it carries | Who reads it |
|---|---|---|
| `GET /state/accounts` (the `accounts` registry table) | 7 rows: id, live/demo, enabled, mode (active / manage_only / archived), currency | Accounts overview, Risk matrix, Performance cards, compare views |
| the broker roster the Connect flow caches in the browser (`accounts_cache_v1`) | the accounts the cTrader login can see | the account switcher, the "Viewing" picker |

The only count checks are "zero accounts" and "fewer than two" guards (the
picker hides itself with one account; the watchlist compare asks for a
second). No grid, tab strip or layout assumes seven. The two literal account
numbers in `src/` are comments (an example label in the Scoreboard formatter,
a note on the daily-stop reading in Performance), not logic. **No sub-folder
archive of the present UI is needed; none was created.**

Where "seven" does live is agent-side and owner-authored, not UI:

- `agent/config/intraday-phase-restoration.json` — the owner's one-time
  approval list of seven account ids for Scan/Analyze/Autotrade (a new account
  needs its own approval, by design).
- `agent/config/manual-hybrid.json` — the two profit-taking accounts
  (43097342, 42993489).
- `agent/config/momentum-entries.json`, `strategy-pins.json` — the tsmom trial
  account (46130058).

## 2. The two accounts (owner-corrected at № 13,098)

Read from `GET /state/account-overview` at 09:5x SGT, not from memory:

| Account | Side | Currency | Balance | Equity | Open positions |
|---|---|---|---|---|---|
| 42993489 | Live | SGD | 51.36 | 51.36 | 0 |
| 43097342 | Demo | SGD | 3,062.38 | 3,059.28 | 3 (JPYX, USDSGD, NVDA.US) |

My first reading at № 13,096 named 46130058 (USD 30,009.96) as the demo; the
owner corrected it to the SGD 3,000 demo, 43097342. The corrected pair is
also the pair `manual-hybrid.json` names and CLAUDE.md's profit-only scope
(DEMO43097342, LIVE42993489).

The other enabled accounts are not empty: 46130058 holds 2 positions
(USD 30,010), 46979908 (manage_only) 1, 47790949 (USD 42,855) 1.

## 3. Options

### C·1 — a dynamic "viewed accounts" set (recommended; UI only)

- One UI preference, stored with the other UI state (`ui_view_accounts`):
  the set of account ids to display. Default: all enabled accounts.
- Pickers, cards, compare tables and the matrix render only that set. A chip
  in the account header says "Viewing 2 of 7 · show all"; the chooser lists
  every registry account with its side, currency and balance.
- A newly registered account appears in the chooser automatically and is
  included by default, so the view grows on its own when an account is added;
  an archived account drops out on its own.
- Nothing about trading, enablement or the registry changes: the loop keeps
  managing every enabled account's positions. No protection decision.
- Build: one preference route (read/write, owner-gated like the other UI
  settings), one `useViewedAccounts()` hook, the filter applied in the
  roster-driven components, the chip. 390px check with real data, the full
  gate, auto-merge, deploy read-back.

### C·3 — archive or disable the other accounts (ask-first)

- Shrinks the view the same way but stops the bot managing those accounts'
  open positions (5 today). A trading decision under P7: not done without the
  owner's order and the owner's word on the open positions first (close them,
  or leave those accounts manage_only).

## 4. Decision requested

- "C·1": build the view-set as above, defaulting the view to 42993489 and
  43097342 on first use (the owner may change it in the chooser).
- "C·3 …": the owner's instruction on the open positions, then the archive.

Conversation ref: ordered № 13,096 (owner) · reported № 13,098. Session
https://claude.ai/code/session_01C1hz86KuE5JKVq6W2KtUE2.
