# Pull request record: mae-chandelier-observe

**03-10-2026: the observer this record describes was removed on the owner's order ("remove all three"); see the RETIRED block at the top of `docs/mae-chandelier-observe.md`. This record is kept as written.**

№ 10,430 · 02-10'26 07:01 SGT · Grok 4.7 · effort not metered.

The observe commits were pushed straight to `main`. This pull request is the record. It does not replay them and it does not amend a stop.

| Commit | What |
|---|---|
| `0bcdd23` | Observe-only MAE and Chandelier. `mayAmend` false. |
| `faad844` | `GET /mae-chandelier-observe` on Railway `cpp-verify`. |
| `1d0e539` | Serial № 10,425 in the doc and the route comment. |
| `5d92e8d` | Cached 1h bars only. No new broker fetch. |
| `c958f06` | Doc note for that cache. |

Tests run before this record: 5 Node tests passed, C++ check printed `may_amend false`.
