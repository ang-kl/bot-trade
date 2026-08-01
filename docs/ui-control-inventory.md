# bot-trade — UI Control Inventory (Phase A, 2026-08-01)

Route-by-route inventory of every interactive or pseudo-interactive control,
produced for the Compact M3 consolidation (see
`docs/ui-m3-compact-contract.md`). HEAD at audit: `16defbd`.

Legend for the Risk column: **yes** = accidental activation can trade,
disarm, or destroy money-moving state.

Baseline facts referenced throughout:

- `Button` (shared): 2px padding all round, 9px text (11px `lg`),
  `--radius-control` = 1px, 1px border, `disabled:opacity-50`,
  `focus:ring-1 accent/50`, `active:scale-[0.98]`. No loading variant.
- `Badge` (shared): 9px, `px-1.5 py-0.5`, 6px radius, `<span>` — never
  focusable. Tone vocabulary: up/down = P&L, on/off = state.
- Tokens: `--color-up` blue, `--color-down` red, `--color-accent` clay
  (navigation), `--color-state-on/off` blue/red. No green at token level.

---

## Part 1 · /performance, /desk, /trade

### /performance — `src/pages/Performance.jsx`

| # | Section | Label | Source | Behaviour | Role | Problems | Risk |
|---|---|---|---|---|---|---|---|
| P1 | every Card | `▾`/`▸` | Card.jsx:89-101 | collapse (display:none) | disclosure | has aria-label/expanded; no focus-visible style (JS hover only) | no |
| P2 | every Card | `⧉` | Card.jsx:102-108 | copy popup | command | same missing focus style | no |
| P3 | section headers | `⧉` `⤢` | SectionTools.jsx:95-98 | copy / popout | command | 8px radius vs 1px token; no hover/focus/active; duplicates P2's `⧉` with a different payload | no |
| P4 | expand modal | `⧉ Copy`, `✕` | SectionTools.jsx:120-121 | copy / close | command | duplicate action, different labels | no |
| P5 | FAB | `☰`/`×` | SectionNavFab.jsx:34-38 | section list | disclosure | no focus ring; hidden <700px so phones lose section nav | no |
| P6 | FAB list | section names | SectionNavFab.jsx:25-31 | scrollIntoView | navigation | clickable-styled-as-text; JS-only hover | no |
| P7 | gradient grids | column head text | raw button Performance.jsx:392-394 | hides the column | toggle | header that silently deletes a column; no pressed state, no aria | no |
| P8 | gradient grids | row label text | raw button Performance.jsx:402-404 | hides the row | toggle | indistinguishable from the data label it is | no |
| P9 | restore bar | `+ <name>` | raw button Performance.jsx:360-366 | un-hide | command | chip styling ≠ Button; no states | no |
| P10 | restore bar | `Show all` | raw button Performance.jsx:367-368 | clear hidden sets | command | raw button; no states | no |
| P11 | FX banded card | `<PAIR> <value>` | raw button Performance.jsx:464-467 | inline TP/SL detail | disclosure | reads as a data chip; selected = 1px border change only | no |
| P12 | open positions | whole row | div role=button Performance.jsx:573-576 | expand detail | disclosure | no accessible name; no focus style; nested interactive (P13) inside | no |
| P13 | inside P12 | symbol text | SymbolTarget.jsx:24-35 | opens cockpit (?trade=id) | navigation | clickable-styled-as-text; role=button w/o aria-label; interactive-in-interactive | no |
| P14 | weekend 24H | whole row | Performance.jsx:677-680 | expand | disclosure | as P12 | no |
| P15 | today's trades | whole row | Performance.jsx:775-778 | expand | disclosure | as P12 | no |
| P16 | paged tables | `‹` `›` | raw button Performance.jsx:647,649 | page ±1 | navigation | icon-only, no accessible name; hand-rolled disabled styling | no |
| P17 | ledger modal | `Expand all`/`Collapse all` | raw button Performance.jsx:923-925 | force rows open | toggle | label swap only; no aria-pressed; 8px radius | no |
| P18 | desktop ledger | whole `<tr>` | tr onClick Performance.jsx:967-968 | expand breakdown | disclosure | **tr onClick — no role, no tabindex, no keyboard, no aria** | no |
| P19 | mobile ledger | window card | raw button Performance.jsx:1020-1021 | expand | disclosure | aria-expanded ✓; no focus ring | no |
| P20 | mobile pill nav | `Now`…`Accounts` | raw button Performance.jsx:2008-2013 | setScreen | selection | aria-current="page" misused for view switch; 999px radius vs token | no |
| P21 | mobile acct filter | `All`/`Live`/`Demo` | raw button Performance.jsx:2097-2100 | setAcct | selection | no aria-pressed; hard-coded `#fff` | no |
| P22 | mobile acct filter (2nd copy) | same | Performance.jsx:2114-2117 | same | selection | three drifting copies (P21/P22/P25) | no |
| P23 | empty floating card | summary line | details/summary Performance.jsx:2369-2371 | native disclosure | disclosure | summary styled as a heading | no |
| P24 | weekend section | summary + status | Performance.jsx:2390-2393 | native disclosure | disclosure | status readout inside accessible name | no |
| P25 | desktop acct filter | account cards | raw button Performance.jsx:2434-2437 | setAcct | selection | aria-pressed here only; `#fff` hard-coded | no |
| P26 | account scope | radio cards | PerfAccountScope.jsx:58-81 | scope change | selection | best-behaved control (radiogroup + roving tabindex); no focus-visible ring | no |
| P27 | equity chart | `7D` `30D` `90D` | ReportChart.jsx:170-171 | setRange | selection | no aria; `text-white` hard-coded; raw button | no |
| P28 | debrief | `Day`/`Week` | SessionReview.jsx:232-233 | setPeriod | selection | 999px pill; no group semantics | no |
| P29 | debrief rows | whole row | SessionReview.jsx:273-276 | expand | disclosure | as P12 | no |
| P30 | regime matrix | `All`/accounts | PerfMacroSections.jsx:167-168 | setRAcct | selection | 4th account-filter copy with its OWN state diverging from page scope | no |
| P31 | regime SVG | plot dots | g onClick PerfMacroSections.jsx:211-212 | select key | selection | **SVG g onClick — no role/tabindex/keyboard/name** | no |
| P32 | regime legend | legend rows | raw button PerfMacroSections.jsx:244-248 | select key (also on hover!) | selection | hover-selects; duplicate of P31; no aria | no |

### /desk — `src/pages/Desk.jsx`

| # | Section | Label | Source | Behaviour | Role | Problems | Risk |
|---|---|---|---|---|---|---|---|
| D1 | 11 sections | `▾/▸ <title>` | raw button Desk.jsx:98-107 | collapse + localStorage | disclosure | heading-as-button; **second collapse control beside Card's own ▾** | no |
| D2 | status strip | `Autotrade ON/OFF/no data` | span Desk.jsx:445-449 | none | status | **OFF and UNKNOWN identical grey `#94a3b8`**, hard-coded hex | no |
| D3 | status strip | `⏳ pending armed` | span Desk.jsx:451-454 | none | status | status-styled-as-control | no |
| D4 | status strip | `⚠ LIVE`/`DEMO` | span Desk.jsx:456-458 | none | status | fine | no |
| D5 | status strip | `Tune ›` | Link Desk.jsx:461 | route | link | fine | no |
| D6 | status card | `armed combos (N)` | details Desk.jsx:482 | disclosure | disclosure | third disclosure idiom on one page | no |
| D7 | gauges | `what do these gauges mean?` | summary Desk.jsx:510 | disclosure | disclosure | as D6 | no |
| D8 | P&L gauges | `1` `4` `8` `16` | raw button Desk.jsx:518-522 | grid size | selection | radiogroup ✓; digit-only accessible names; `text-white` | no |
| D9 | chart wall | `1 chart` `4 wall`… | Desk.jsx:540-546 | grid size | selection | duplicate concept of D8, different labels, second persisted key | no |
| D10 | chart wall | symbol dropdown | select Desk.jsx:550-557 | pickSymbol | selection | only native select on route; 8px radius | no |
| D11 | chart wall | `<SYMBOL>` + `●` | raw button Desk.jsx:580-582 | focus symbol | navigation | clickable-styled-as-text; `●` unnamed | no |
| D12 | scan strip | signal row | raw button Desk.jsx:597-601 | focus symbol | navigation | whole row is a link in disguise; zero hover/focus styling | no |
| D13 | broker table | `Manage` | Button ghost via StdTradeTable.jsx:382 | opens PositionManager | disclosure | 9px chip gates Close/Double/Reverse | yes (indirect) |
| D14 | broker table | `Chart`/`Hide` | StdTradeTable.jsx:377-379 | inline chart | disclosure | label swap, no aria-expanded | no |
| D15 | tables | sort heads | StdTradeTable.jsx:74-77 | sort | selection | clickable-styled-as-text; aria-sort ✓ | no |
| D16 | tables | symbol cells | StdTradeTable.jsx:261/265 | Desk: chart; elsewhere: cockpit | navigation | same visual, two behaviours by caller | no |
| D17 | tables | `‹ Newer`/`Older ›` | Button subtle StdTradeTable.jsx:456-458 | page | navigation | fine (vs raw P16) | no |
| D18 | Manage sheet | `Size`/`Stop & Target`/`Chart`/`Details` | PositionManager.jsx:175-177 | tabs | selection | no role=tab/aria-selected; selection = shadow only | no |
| D19 | Manage sheet | `Modify` | PositionManager.jsx:202 (+OrderManager.jsx:89) | **nothing — permanently disabled** | command | dead control as the dominant button | no |
| D20 | Manage sheet | `Double` | Button subtle PositionManager.jsx:207-209 | confirm → position-double | command | real market order behind subtle variant | **yes** |
| D21 | Manage sheet | `Reverse` | Button subtle PositionManager.jsx:210-212 | confirm → position-reverse | command | flips a live position, subtle variant | **yes** |
| D22 | Manage sheet | `Close (<price>)` | raw button PositionManager.jsx:216-220 | confirm → position-close | command | raw bypass of Button danger; emphasis inverted vs D20/D21 | **yes** |
| D23 | Stop & Target | TP/SL/trailing/BE switches | ToggleRow PositionManager.jsx:79-95 | local until commit | toggle | correct on/off colours + aria-checked; no text state word | no |
| D24 | Manage sheet | price/pips/lots inputs | raw input PositionManager.jsx:56-70 | draft | field | bypasses Input/Field; no focus ring | no |
| D25 | Manage sheet | `Modify protection` | raw button PositionManager.jsx:281-284 | **POST protect+guard, NO confirm** | command | only unconfirmed write in the sheet — moves live SL/TP | **yes** |
| D26 | sheet header | `✕` | Button ghost PositionManager.jsx:169 | close | command | no aria-label | no |
| D27 | order sheet | `Cancel order` | raw button OrderManager.jsx:95-98 | confirm → order-cancel | command | raw bypass of danger | **yes** |
| D28 | postmortems | `Sweep lessons now` | Button ghost Desk.jsx:746-754 | postmortem-sweep | command | label-swap loading only | no |
| D29 | deal history | `7d` `30d` `3mo` `6mo` | Desk.jsx:829-834 | window | selection | radiogroup ✓; third control-height variant | no |
| D30 | risk decisions | `OK`/`VETO` rows | raw button Desk.jsx:122-135 | expand | disclosure | clickable-styled-as-text | no |
| D31 | footer | `Trade` | Link Desk.jsx:876 | route | link | fine | no |
| D32 | LLM spend | cost-alert field | Input Desk.jsx:997 | draft | field | only real Input on Desk | no |
| D33 | LLM spend | `Save cap` | Button subtle Desk.jsx:999-1008 | llm-budget POST | command | subtle for a control that changes spend behaviour | no |
| D34 | edge health | `Recover strategy labels` | Button ghost Desk.jsx:1046-1057 | backfill-label-strategy | command | mutates history, no confirm; looks like read-only D28 | no |
| D35 | edge health | ~10 "go to Tune" links | Link Desk.jsx:1059-1217 | navigate | link | ten wordings for 1-2 destinations; two read as commands | no |
| D36 | edge health | `FIB → arm` cell | Link Desk.jsx:1089 | navigate to Tune | link | implies arming, only navigates | no |
| D37 | edge health | strategy chips | Desk.jsx:1148-1154 | baseline select | selection | radiogroup ✓; `text-white` | no |
| D38 | sort heads | incl. `Δ` | use-sort.jsx:25-31 | sort | selection | text-styled; `Δ` has no name | no |
| D39 | loss review | 6 filter selects | LossReview.jsx:170-208 | filter | selection | six native selects, no labels beyond option text | no |
| D40 | loss review | `↑↓`, pagers, `clear filters` | LossReview.jsx:164-212 | state | command | `clear filters` text-styled; arrows unnamed | no |
| D41 | loss review | whole `<tr>` | LossReview.jsx:268 | expand | disclosure | tr onClick — keyboard-dead | no |
| D42 | order ledger | `veto` | raw button OrderLedger.jsx:121-126 | confirm → queued-veto (cancels AND blocks symbol) | command | **8px badge-styled-as-button for the most irreversible action**; neighbour `Cancel` is a full Button for the lesser action | **yes** |
| D43 | order ledger | `Manage`/`Close` | Button ghost OrderLedger.jsx:280 | expand inline | disclosure | `Close` = collapse here, = market-close in D22 | yes (confusable) |
| D44 | gauge wall | tiles | div onClick TradeGaugeWall.jsx:110-111 | open chronograph | navigation | div onClick — no role/keyboard/name | no |
| D45 | gauge wall | `⤢` | TradeGaugeWall.jsx:137-140 | detail | command | aria-label ✓; same glyph as P3, different action | no |
| D46 | acct engineering | `●` phase dots | span aria-hidden | none | status | correct | no |
| D47 | FAB | `☰`/`×` | SectionNavFab via Desk.jsx:435 | jump list | disclosure | as P5/P6 | no |

### /trade — `src/pages/Trade.jsx`

| # | Section | Label | Source | Behaviour | Role | Problems | Risk |
|---|---|---|---|---|---|---|---|
| T1 | status card | `Scan now` | Button ghost Trade.jsx:622-624 | POST /actions/scan | command | label-swap loading | no |
| T2 | status card | `Test fill 0.01` | Button **ghost** Trade.jsx:625-628 | prompt+confirm → validation-fill: **REAL 0.01-lot market order** | command | **most dangerous control on route in the quietest variant**, flush beside harmless neighbours | **YES** |
| T3 | status card | `Reset breaker` | Button ghost Trade.jsx:630 | reset-breaker, **no confirm** | command | re-arms a tripped breaker with zero confirmation | **YES** |
| T4 | status card | `Kill all` | Button danger Trade.jsx:632-635 | confirm → kill-all | command | correct variant; fat-finger adjacency with T3 | **YES** |
| T5 | status card | autotrade status | span Trade.jsx:640-643 | none | status | OFF and no-data same grey; ON label differs from Desk's for the same flag | no |
| T6 | status card | `⚠ LIVE`, `BREAKER TRIPPED`, errors | span Trade.jsx:611-620 | none | status | breach text far from its clearing control (T3) | no |
| T7 | guide line | `Desk` `Connect` `Tune` | local NavTab Trade.jsx:22-26 | route | link | 4th link idiom, duplicated | no |
| T8 | signals | summary | details Trade.jsx:668-670 | disclosure | disclosure | open state re-derived from data, can override user toggle | no |
| T9 | signals | sort heads | use-sort Trade.jsx:677-682 | sort | selection | text-styled | no |
| T10 | signals | `LONG`/`SHORT` | Badge up/down Trade.jsx:707 | none | status | **up/down tones used for direction** — documented misuse; SHORT reads as loss | no |
| T11 | open positions | symbol cells | SymbolTarget via StdTradeTable | opens cockpit | navigation | text-styled, unnamed role=button | no |
| T12 | order FAB | `+`/`×` | raw button Trade.jsx:758-766 | opens order pad | disclosure | 48px accent circle — biggest control opens order entry; rounded-full vs token | yes (indirect) |
| T13 | order pad | `✕` | Button ghost Trade.jsx:722 | close | command | no aria-label | no |
| T14 | order pad | Symbol field | Input+datalist Trade.jsx:725-729 | draft | field | placeholder-as-label; 9px override fighting Input's 14px | no |
| T15 | order pad | `BUY`/`SELL` | raw radio Trade.jsx:732-737 | side | selection | SELL selected = loss-red; BUY = navigation accent — wrong vocab both sides | yes (indirect) |
| T16 | order pad | Lots/SL/TP fields | Input Trade.jsx:740-745 | draft | field | placeholder-as-label ×3; `SL — required` only in placeholder | no |
| T17 | order pad | `BUY EURUSD` commit | Button (danger iff SELL) Trade.jsx:746-750 | confirm → manual-order | command | **variant carries direction, not destructiveness** | **YES** |
| T18 | broker | `Clean up stale pending orders` | Button subtle Trade.jsx:785-796 | confirm → reconcile-pending | command | cancels real orders from lowest-contrast variant | **YES** |
| T19 | external positions | `bot manage` checkbox | native checkbox Trade.jsx:824-846 | **POSTs keeper-optout on change, no confirm** | toggle | unstyled native checkbox; no busy state; failed POST leaves box wrong | **YES** |
| T20 | recent trades | `Reconcile with broker` | Button subtle Trade.jsx:854-870 | reconcile-trades | command | mutates ledger, no confirm | no |
| T21 | order log | `Test C++ engine` | Button subtle Trade.jsx:880-892 | exec-parity (read-only) | command | identical look to mutating T20 | no |
| T22 | order log | `Download my action log` | Button subtle Trade.jsx:894-910 | blob download | command | fine | no |
| T23 | order log | StdTradeTable controls | Trade.jsx:922 | as D15-D17 | — | inherits D15/D16 | no |
| T24 | order log | `OK`/`VETO` result | tone up/warning Trade.jsx:348 | none | status | `up` (profit) tone for approval state | no |
| T25 | FAB | `☰`/`×` | SectionNavFab Trade.jsx:598 | jump list | disclosure | corner collision risk with T12 on narrow screens | no |
| T26 | status card | fill result | div role=status Trade.jsx:658 | none | status | emoji-only semantics | no |

### Systemic findings (Part 1)

1. **Raw `<button>` outnumbers shared `Button` ~60:35**; Performance.jsx never imports Button at all.
2. **Clickable-styled-as-text is the most repeated defect** (sort heads, section headings, scan rows, symbol cells, FAB list rows, `clear filters`).
3. **Row disclosure has four incompatible implementations, two keyboard-dead** (`tr onClick`, `div onClick`).
4. **Desk sections carry two collapse controls each** (Card `▾` + Section heading `▾`, different persistence).
5. **Selection groups: seven variants, four aria levels**; account filter exists 5× with two diverging state atoms.
6. **Radius token honoured almost nowhere**: 999px/12px/10px/8px/6px/3px/rounded-full all live against `--radius-control: 1px`.
7. **Danger emphasis inverted vs consequence**: real-order and re-arm controls wear ghost/subtle; `veto` (cancel + block symbol) is an 8px pill; the merely-navigational order FAB is the biggest, loudest control in the app.
8. **`window.confirm` is the entire safety layer; three high-consequence writes have none**: `Reset breaker`, `Modify protection`, `bot manage` checkbox.
9. **Badge tone misuse exactly as Badge.jsx warns**: up/down for direction (T10) and approval (T24).
10. **OFF and UNKNOWN render the same hard-coded grey** on both Desk and Trade status strips.
11. **Icon-only controls without names**: pagers `‹›`, sort arrows, `Δ` head, `●` marker, `✕` closers.
12. **No loading state in the system** — every busy control is `disabled` + label swap; buttons resize mid-flight.
13. **Focus invisible outside primitives**; several controls style hover/focus by JS `element.style` mutation.
14. **Dead controls shipped as dominant actions**: permanently-disabled `Modify` buttons in both manager sheets.
15. **Label collisions**: `Close` (collapse vs market-close), `Cancel` vs `veto`, `Manage` (inline vs modal), symbol cell (chart vs cockpit).

---

## Part 2 · App chrome + /accounts, /accounts/audit, /tune, /risk, /connect

### App chrome (sidebar / topbar / tab bar / S.A.T.)

| Control | Source | Behaviour | Role | Problems | Risk |
|---|---|---|---|---|---|
| Nav links | NavLink App.jsx:273,195-201 | route | navigation | active accent = same colour Tune uses for selected radio and armed pill | no |
| Account identity block | button ActiveAccountHeader.jsx:100-111 | toggles client poll-pause | toggle | identity block silently doubles as a toggle; label says "Account" not "Pause" | no |
| S·A·T dots in that block | role=link span ActiveAccountHeader.jsx:144-158 | navigate to Tune switches | navigation | interactive role=link nested inside a real button; 6px hit area | no |
| **Master S / A / T** | MiniSwitch AccountSwitcher.jsx:23-41,126-137 | POST scan/analyze/autotrade-toggle for ALL accounts | toggle | **smallest money control in the app (8px font, 18px wide)**; T gates arm/disarm, **S and A have no confirmation** though master Scan off stops all trading; state not in accessible name | **YES** |
| **Per-account S / A / T** | MiniSwitch AccountSwitcher.jsx:186-198 | POST account-phases | toggle | three 18px targets 3px apart beside the account-pick button; disarm never confirms | **YES** |
| Account row (pick) | button AccountSwitcher.jsx:154-164 | select account (typed LIVE gate) | command | LIVE/DEMO words use up/down profit colours | no |
| Ratchet badge `⛔/⚠ ratchet` | span AccountSwitcher.jsx:170-179 | none | status | reads as a 4th chip in the switch row | no |
| Session line | button SessionFooter.jsx:155-172 | popover | disclosure | fine (compact-control + aria) | no |
| `Disconnect` | SessionFooter.jsx:374-379 | revoke after confirm modal | command | good pattern (modal + focus trap) | no |
| Sleep-after `5m/15m/1h/4h` | SessionFooter.jsx:427-435 | local | selection | pressed-toggles instead of a radiogroup | no |
| Theme (sidebar) | App.jsx:297-303 | cycles theme | command | cycling command styled/read as a state chip | no |
| Theme (More sheet) | App.jsx:391-396 | same | command | duplicate action, different label/visual, **no aria-label** | no |
| Mobile tabs + `⋯ More` | MobileTabBar.jsx:98-112 | route / sheet | navigation/disclosure | More styled identically to destination tabs | no |
| Section FAB | SectionNavFab.jsx:34-38 | jump list | disclosure | 50% radius vs no-capsule rule; no aria-expanded; list rows JS-hover only, no focus-visible | no |
| Card `▾`/`⧉` | Card.jsx:90-107 | collapse/copy | disclosure/command | aria ✓; 55% opacity pair 26px apart | no |

### /accounts

| Control | Source | Behaviour | Role | Problems | Risk |
|---|---|---|---|---|---|
| `Show my other accounts`/`Refresh…`/`Fetching…` | Button ghost Accounts.jsx:196-198 | broker-positions POST | command | one control, three labels by state | no |
| `BOT TRADES THIS ONE` | Badge tone="up" Accounts.jsx:48 | none | status | tone misuse (should be `on`) | no |
| `Live positions … ▸ show/▾ hide` | raw button Accounts.jsx:58-63 | collapse | disclosure | styled as a table caption; **no aria-expanded** | no |
| `Manage` | Button ghost StdTradeTable.jsx:382-384 | opens manager sheet | disclosure | identical weight to read-only `Chart` beside it | indirect |
| Manager sheet contents | PositionManager/OrderManager | see Part 1 D18-D27 | — | + `SELL|BUY` header spans styled as a segmented control (PositionManager.jsx:188-192) | yes |
| Sub-nav `Overview`/`Workflow audit` | AccountsSubNav.jsx:14-21 | route | navigation | `text-white` literal vs `--color-on-accent` | no |
| Strategy insights `7D/30D/All` | raw button StrategyInsights.jsx:40-45 | range | selection | **inverted emphasis: unselected is bold UPPERCASE, selected normal**; no aria | no |
| Market session `OPEN/CLOSED` | Badge on/off MarketClock.jsx:49 | none | status | correct ✓ | no |

### /accounts/audit

| Control | Source | Problems | Risk |
|---|---|---|---|
| Range `7D 14D 30D 90D` + window `15m 1h 4h` | raw inline buttons SymbolClusters.jsx:139-145 | **999px capsules** (the pattern removed elsewhere), no aria-pressed/focus style, hard-coded `#fff` | no |
| Cluster row expand | div role=button SymbolClusters.jsx:55-58 | aria-expanded + keys ✓; no focus ring | no |
| Filter chips | WorkflowAudit.jsx:233-238 | capsules again; aria-pressed ✓ | no |
| `‹ Prev`/`Next ›` | WorkflowAudit.jsx:283-289 | disabled by colour only; no focus ring | no |

### /tune (highest control density)

| Control | Source | Behaviour | Problems | Risk |
|---|---|---|---|---|
| Folio tabs | FolioTabs.jsx:35-52 | panel switch | **best-implemented control set in the app** (full tablist + arrow keys) | no |
| **Master `Scan`/`Analyze`** | Toggle Tune.jsx:668-683,1397-1398 | scan/analyze-toggle | **no confirmation on an absolute veto**; ~2px vertical padding | **YES** |
| **Master `Autotrade`** | Toggle Tune.jsx:1399-1419 | arm=confirm, disarm=typed | correct gating, **visually identical to the two ungated switches beside it** | **YES** (mitigated) |
| Autotrade scope | Tune.jsx:1428-1437 | autotrade-scope POST | widens tradeable set, no confirm; radiogroup ✓ | **YES** |
| Per-account S/A/T (Tune card) | PhaseSwitch AccountPhaseSwitches.jsx:43-71 | account-phases | duplicate of sidebar MiniSwitch at a different size; disarm never confirms | **YES** |
| `Inherit` | AccountPhaseSwitches.jsx:253-263 | clears 3 overrides | **command in a row of switches, same shape**; no confirm | **YES** |
| Stage-matrix cells | MxCell Tune.jsx:284-299 | select cell | aria-pressed misreports (pressed=value, not selection) | no |
| `Turn ON`/`Turn OFF` | Button Tune.jsx:439-441 | writes stage flag incl. live trade gate | `Turn ON` on trade stage arms a strategy in a plain neutral button, no confirm | **YES** |
| Autopilot `off/suggest/auto` | Tune.jsx:1536-1546 | autopilot POST | orphan role=radio without radiogroup | **YES** (auto confirms) |
| Five safety breakers | Toggle Tune.jsx:1561-1616 | POST each | **rendered identically to master Autotrade**; disabling a breaker removes protection, only auto-disarm confirms | **YES** |
| Cadence fields | Field Tune.jsx:1635,1880 | POST on blur | five `!important` overrides per input; tabbing through can post | no |
| Timeframe chips `4h ✕` | Tune.jsx:1753-1763 | changes armed timeframes | ~8px tap target inside chip | **YES** |
| Asset-controller cells (25 inputs) | Input Tune.jsx:1837-1850 | POST exit rules on blur | live exit-rule writes with no save step or confirm | **YES** |
| `Burn-in` | Toggle Tune.jsx:1895-1903 | opens REAL positions every 5min | identical chip to "Regime gate" | **YES** (mitigated) |
| Loss Guardian / Weekend bank / Closed-market limits / Profit Keeper | Toggle Tune.jsx:1863-2021 | POST | **duplicate editors of the same keys as Risk page** | **YES** |
| Quick-group chips | Tune.jsx:2158-2171 | add/remove watchlist group | **every UNSELECTED chip renders in semantic red bold uppercase** — a row of "errors" meaning "not added" (the exact defect fixed at :1654-1657, missed here) | no |
| `N of M ▸` strategy picker | Tune.jsx:2407-2417 | opens StrategyPicker | clickable-styled-as-text; sets which strategies may trade | **YES** |
| `Disable`/`Remove` + bulk row | Tune.jsx:2427-2490 | immediate writes | `!min-h-0` overrides remove the tap target; `Remove` danger without confirm; `clear` is a text link among buttons | low |
| `Add to Activate: … All incl. No-Go` | Tune.jsx:3013-3017 | sets arming verdicts | can arm strategies your own backtest failed; warning is prose | **YES** |
| **`Apply selection: N instruments`** | Button primary Tune.jsx:3051-3070 | re-arms instruments×timeframes | neutral chip for a live re-arm | **YES** |
| **`Arm the bot (everything in one tap)`** | Button primary Tune.jsx:3079-3103 | arms Scan+Analyze+Autotrade | **the most consequential control in the product wears the default variant** | **YES** |
| **`Arm pending orders`** | Button `variant="secondary"` Tune.jsx:3115-3125 | parks real limit orders | **`secondary` is not a defined variant → silently renders primary**; same bug at :2986 (`Download report`) so a download and a live-order arm are pixel-identical | **YES** |
| `Export`/`Import settings` | Button subtle Tune.jsx:3329,3364 | Import POSTs risk-config+timeframes+filters+symbols | **Import rewrites the whole config, no confirm/preview**, symmetric with harmless Export | **YES** |
| VerdictBadge `GO/NO-GO` | Tune.jsx:522-528 | opens popover | **badge-styled-as-button** | no |
| Six disclosure headers | Tune.jsx:130-2915 | collapse | clickable-styled-as-text ×6 | no |

### /risk

| Control | Source | Behaviour | Problems | Risk |
|---|---|---|---|---|
| `Reset` vs `Reset to defaults` | RiskReassess.jsx:150 / Risk.jsx:540 | same route, same effect | **duplicate, two labels, two confirm texts, one page** | **YES** |
| LLM provider/model selects | RiskReassess.jsx:184-210 | choose LLM | bare selects; PresetSelect exists | no |
| **`Apply N selected`** | Button primary RiskReassess.jsx:344-347 | writes LLM-proposed limits into the live gate | default variant, **no confirm** | **YES** |
| `select all` | RiskReassess.jsx:348-356 | ticks every proposal | clickable-styled-as-text beside Apply | **YES** |
| `Save account` | Button Risk.jsx:366 | balance POST | 10px/2px target drives every % limit | **YES** |
| Ten On/Off `Pill`s | Risk.jsx:69-81 (uses :384-723) | **some local-until-Save, some POST immediately** | identical pills, two commit models, nothing distinguishes them; ON uses accent (navigation) not state-on | **YES** |
| **`Halt (kill switch)`** | Pill Risk.jsx:709 | local until Save | **inverted semantics: on/accent = trading STOPPED**; offLabel omitted so armed state reads neutral | **YES** |
| Segmented pills (Close/Alert only etc.) | Risk.jsx:395-668 | local | selection presented as aria-pressed toggles, not radios; decides whether a breach flattens | **YES** |
| Seven `Save …` buttons | Risk.jsx:418-734 | POST per section | seven names, all neutral, none confirm | **YES** |
| `Reset staircase` | Button ghost Risk.jsx:471-474 | wipes banked floors | ghost for a destructive reset | **YES** |
| **`Close ALL positions`** | Button danger Risk.jsx:743-745 | confirm → close-all | correct variant, but a 9px outline chip while single-position Close is solid-red 15px full-width — **emphasis inverted between close-one and close-all** | **YES** |
| `Emergency` badge | tone="down" Risk.jsx:739 | none | P&L red for a section label | no |

### /connect

| Control | Source | Behaviour | Problems | Risk |
|---|---|---|---|---|
| Agent URL/secret | Input Connect.jsx:171-175 | local | only full-size (14px/36px) inputs in the app | no |
| **`Clear`** | Button subtle Connect.jsx:181 | wipes agent credential, **no confirm** | destroys connection in the quietest variant, 6px from `Test connection` | **YES** |
| Telegram login row | Connect.jsx:192-223 | request/verify | fine | no |
| Account row | raw button Connect.jsx:268-305 | select account (typed LIVE gate) | **nested span role=button inside it** (:278-294): Enter-only (no Space), no aria-expanded, 16px capsule radius; mis-tap on chip edge selects the account | **YES** |
| `LINKED`/`SELECTED` badges | tone="up" Connect.jsx:237,304 | none | tone misuse (should be `on`) | no |
| `BUY`/`SELL` detail badges | Connect.jsx:312,327 | none | up/down for side — third tone-misuse family | no |
| WatchlistCompare | Connect.jsx:353 | writes watchlists to other accounts | changes what other accounts trade | **YES** |

### Systemic findings (Part 2)

16. **Two independent editors for the same money state, four components, three sizes**: master and per-account S/A/T (AccountSwitcher vs Tune Toggle vs AccountPhaseSwitches); Weekend bank, Loss Guardian, guardian move %, full risk reset each have two UIs on two pages.
17. **Confirmation is inconsistent with blast radius**: Autotrade typed-gate vs bare-tap master Scan/Analyze; disarm never confirms; `Modify protection`, `Import settings`, `Clear` unconfirmed.
18. **The neutral default variant means the most dangerous commands are the quietest**: `Arm the bot`, `Apply selection`, `Apply N selected`, seven Saves — all identical to `Close`/`Add`/`Set`.
19. **`variant="secondary"` doesn't exist** — used on `Arm pending orders` and `Download report`, both silently render primary.
20. **Three different "ON" colours** (state-on blue, accent clay, accent+text-white literals) — selected-tab and armed-strategy render identically.
21. **Semantic red for merely-unselected options** (Tune group chips; inverted-emphasis pattern also at StrategyInsights and Risk `Pill`).
22. **`Halt (kill switch)` inverts the Pill's own semantics** — the precise failure its comment warns about.
23. **Two commit models behind identical pills/fields** (local-until-Save vs POST-now; Risk vs Tune Field).
24. **Interactive nesting and keyboard gaps**: span-in-button (Connect, ActiveAccountHeader), orphan radios (Autopilot), tabs without tab roles (manager sheets) while FolioTabs does it right.
25. **8px text and 18px targets on the sidebar money switches** — below the app's own floor and far below every guideline, with a command (`Inherit`) shaped like a fourth switch beside them.
26. **Two opposite hit-area strategies coexist**: `.compact-control::before` halo restores targets while `!min-h-0` overrides on ~10 Tune buttons deliberately remove them.

---

## Part 3 · Cockpit binding rules, controls, and the contradiction register

### Cockpit binding rules (digest)

Authority: BUILD-ORDER.md is a work order — colour/fonts/sizes/spacing/radii/layout/copy are all outside implementer discretion (BUILD-ORDER.md:3-5); conflicts: BUILD-ORDER > companion spec, reference .dc.html > companion spec, never silent (:29). Up=blue/down=red, never green (:59); IBM Plex Sans/Mono, two weights (400/600, one 700 per screen) (:67-81); size table ×3 devices with mechanical variant factors floored at 8px (:83-97); modal 65%×80% (min 1100×720, max 1600×980) (:103); **the page never scrolls** — only journal + advisories lists (:105, :265); exhaustive §6 delta table — any undeclared variant difference is a defect (:210); ≥44px touch targets by padding, never type growth or empty height (:235); live ≥1Hz WebSocket, roll never jump (:245); stale >5s = STALE pill + dim, no modal, no red (:249); data contract GET /api/positions/:id/cockpit (trade-cockpit-spec.md:92-111); keyboard Tab/Enter/Esc + focus return (:276); done = measured evidence (:289-292).

### Cockpit controls (TradeCockpit.jsx + SymbolTarget.jsx)

| # | Control | Line | A11y state | Notes |
|---|---|---|---|---|
| 1 | ⓘ info trigger ×14 | :70-72 | aria-label generic ("What is this?") for all 14; Enter+Space ✓ | portalled bubble hard-codes hex |
| 2-3 | Pager ‹ › | :88-90 | aria-labels ✓, disabled ✓ | radius 4 = not a spec radius |
| 4 | `Manage` | :294-295 | disabled when closed; **no onClick — dead (W-1)** | |
| 5 | `Close` (red) | :296-297 | **no onClick — dead (W-1)**, not disabled | |
| 6 | Theme toggle | :298-300 | no aria-pressed; override marker visual-only | |
| 7 | Section collapse ▸ ×6 | :521-522 | aria-label + expanded ✓ | feature itself is unspec'd (C-32) |
| 8 | Journal row | :548-552 | **no aria-expanded, Enter only** | minHeight:44 empty-height violation (C-35) |
| 9-10 | MFD tweak markers/keys | :453-490 | **mouse only, not focusable** | 5px key text |
| 11 | Advisory row | :641-645 | aria-expanded ✓, Enter+Space ✓ | |
| 12 | Fleet chip | :693-694 | role=button + tabIndex, **no onClick/onKeyDown — fully dead** | spec says click swaps cockpit |
| 13 | PFD/MFD/LOG tabs | :726-727 | **no tab roles**; colour+border only | |
| 14 | Six border close dots | :775-781 | aria-labels ✓ | 34px touch < 44 |
| 15-16 | Backdrop / root dialog | :788-789 | **aria-modal without focus trap, no accessible name** (C-47) | Esc ✓ |
| 17 | `▾ MORE`/`▴ LESS` | :826 | no aria-expanded | 44px pad applied on desktop too |
| 18 | SymbolTarget | SymbolTarget.jsx:24-33 | no name; focus ring by inline JS | |

Plus ~14 `cursor: help` tooltip-only affordances with no keyboard equivalent. No `:focus-visible` styling anywhere in src/cockpit/.

### Contradiction register (C-1 … C-53)

Doc-vs-doc:

- **C-1/C-2/C-3** ui-spec.md contradicts itself: §2 scale 12/11/10/9 + 9px headline vs §11 checklist "everything 12px, headline 14/800" vs §6 restating the abandoned "12px body" rule; §11/§5-diagram are stale pre-2026-07-25 text.
- **C-4/C-6/C-7** Three coexisting, non-intersecting type scales: ui-spec px (12/11/10/9), ui-audit rem tokens (11/13/16/18/20), ui-wiring proposal (9/10.5/12/15, unratified); the audit's "body on 1rem" acceptance is unachievable while §2 stands.
- **C-5** ui-audit-2026-07-30 §3 claims token adoption that its own §6.1 retracts; the summary table was never re-derived.
- **C-8** `--fs-session` px-vs-rem flagged for the owner, undecided.
- **C-52** Six design decisions are simultaneously "binding" and "awaiting sign-off" (radius tokens, control heights, focus ring, type scale, canonical clock, collapse triangles).

Cockpit spec-vs-spec:

- **C-9/C-10** BUILD-ORDER's 7.5px chart captions violate its own 8px floor; sub-8px reference values (6/7/5px) are irreconcilable with the floor; typeScale.js exempts sub-8px from the factor pass.
- **C-11** iPhone PFD columns: four-way disagreement (BUILD-ORDER 22/84/36; canvas-variants 24/82/28 twice; code uses a minmax(90px,…) in no document).
- **C-21/C-22** canvas-variants' measured reference uses 700 weight in ≥3 non-symbol places, violating BUILD-ORDER's two-weight rule; code silently downgrades the ruler readout.
- **C-23** MFD y-label column 26px vs 22px, 9px vs fs(8.5).
- **C-36** Check 10 (row pitch ≤26px) and check 19 (≥44px touch) are mutually unsatisfiable for a one-line journal row on iPad.
- **C-37** Fonts three-way: handoff CLAUDE.md mandates Inter, BUILD-ORDER mandates IBM Plex, ui-spec bans fallback stacks; cockpit loads Plex from a CDN with a system-ui fallback.

Cockpit spec-vs-implementation (each justified by in-code owner notes but never folded back into the specs):

- **C-12** PFD heights = spec ×0.85 (289/255/228 vs 340/300/268).
- **C-13** Shell 55vw/960-1360 vs spec 65%/1100-1600 (owner "reduce by 15%").
- **C-14/C-15** **No-outer-scroll contract inverted end-to-end**: the shell column is an explicit scroller while journal/advisories now paginate instead of scrolling (four conflicting height figures across three specs).
- **C-16/C-17/C-18** Journal+Risk placement, Invalidation columns (5→2), Advisories+Armed pairing all diverge from the delta table; `cfg.jr`/desktop `cfg.inv` are dead config.
- **C-19** Header `flexWrap: wrap` vs "never wraps"; adds two unspec'd pills, drops the spec'd ✕.
- **C-20** Every heading chip renders one role-step small (10.5 vs 11.5).
- **C-24/C-25** MFD viewBox squashed 15% with preserveAspectRatio="none"; volume separator y=178 vs 182.
- **C-26/C-27** No WebSocket exists — 2.2s polling (0.45Hz) vs ≥1Hz; staleness driven by a test flag, never feed age.
- **C-28** Data route shipped as /state/position/:id/cockpit vs spec'd /api/positions/:id/cockpit.
- **C-29** Demo fallbacks ('0002.HK', 'fib 61.8% fade v2.3', mock fleet tooltip) violate no-placeholder + Honesty rules.
- **C-30/C-31** W-1 unfixed: Manage/Close dead; Fleet chips dead (role=button, no handler); fleet max-5 unenforced in the component.
- **C-32** Cockpit collapse triangles shipped while the same feature is "awaiting go" app-wide.
- **C-33/C-34** 768px iPad/iPhone split in no spec; portrait-aspect clause unimplemented; **0.8 phone scale multiplies every size and hit box** (44→35.2px), defeating the floor and check 19.
- **C-35** Touch handled by exactly what the spec forbids (bare min-height/empty padding); armed-action rows 22px.
- **C-38** Tokens scoped to .tc-root (declared deviation) but the portalled ⓘ bubble hard-codes 4 hex values.
- **C-46/C-47/C-48/C-49** Two expandable-row idioms in one file; aria-modal without trap/name; undocumented 8-minute auto-close; six border close buttons replacing the spec'd single ✕.
- **C-50/C-51** Hard-coded 9px sizes bypass fs(); "opens in 0h 0m" fabricated tooltip on the closed-market Manage button when a position is bound.
- **C-53** Journal expanded body conforms (recorded so the register doesn't imply otherwise).

Audit-tooling gaps (responsive-audit.mjs):

- **C-39** Measures only 1024/820/390 — no 320px (an owner acceptance criterion), no width ≥1100 (the desktop cockpit variant is entirely unsampled), no 200% text pass.
- **C-40/C-41** touch<44 and minFont are printed but never fail the run; threshold disagreement 44 (HIG) vs 48 (M3) vs 44 (BUILD-ORDER).
- **C-42** No route opens the cockpit — all 20 BUILD-ORDER acceptance checks are unautomated.
- **C-43/C-44/C-45** Stale contradictory comments; dead live-mode ternary; layout mode measures skeleton pages by design (every off-host request aborted).
- Also: evaluation failures are silently reported as clean rows; fixed 900px height only; minFont blind to wrapper-applied sizes.
