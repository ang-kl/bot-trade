# bot-trade — Design & Text UI Spec

**Reference implementation:** the Performance page (`src/pages/Performance.jsx`)
plus the shared primitives in `src/index.css`, `src/components/common/Card.jsx`
and `src/components/StdTradeTable.jsx`.

This is the spec every page is held to. Where a page disagrees with this
document, the page is wrong. Where this document disagrees with the code, the
document is wrong — fix it in the same PR.

Written from the owner's review notes on an **iPad mini in Safari** (744 pt
portrait / 1133 pt landscape), which is the primary reading device. A layout
that only works at 1440 px is not finished.

---

## 1 · Prime directives

Four rules outrank every other line in this document. When they conflict with
each other, they are ranked.

1. **Honesty.** A number that isn't known renders `—`. Never a placeholder,
   never an interpolation, never a plausible-looking reconstruction. If a
   value's provenance is weak, say so in the row's own copy.
2. **Density.** No blank space that isn't doing work. Vertical padding on a
   data row is `1px 0`. A card is as tall as its content and no taller.
3. **Uniformity.** One body size, one row height, one head treatment, one
   expand affordance, one empty state — across every table on every page. A
   reader should never have to re-learn a table.
4. **Symmetry.** Paired panels share a row and a baseline. Columns of the same
   kind share a width. Nothing is *almost* aligned.

### What "dense" means concretely

| Element | Value |
|---|---|
| Data row vertical padding | `1px 0` |
| Card padding | `'6px 8px'` (compact) — `'8px 10px'` (section panel) |
| Gap between rows in a stack | `2` |
| Gap between cards in a row | `8` |
| Gap between page sections | `8`–`12` |
| Detail/expansion line padding | `'1px 0 2px 20px'` |
| Header-to-first-row gap | `paddingBottom: 1` on the head row, nothing else |

Anything above `12px` of vertical whitespace between two pieces of data needs a
reason written next to it in a comment.

---

## 2 · Type scale

**Four tokens, two tiers** (owner, 05-08-2026 — the *type canon*).

The sizes were stated by screenshot, not by number: body is "the picture text
`7d`, `30d`", which is `Segmented md`; the header is "`Strategy Liveness
table` but increase by 1pt", which was `.t-h3` at 11px against a 9px body —
body + 2, so +1pt was first read as **body + 3** — a derivation later corrected
to **body + 2** (see below). Then: *"please canonical for tablet and iphones"*,
*"9.5px will be ideal as minimum"*, *"11 px for desktop"*.

|  | `--fs-body` | `--fs-head` (+1) | `--fs-h` (+2) | `--fs-title` (+3) |
|---|---|---|---|---|
| **tablet + iPhone** (`:root`) | `9.5px` | `10.5px` | `11.5px` | `12.5px` |
| **desktop** (`≥1280px`) | `11px` | `12px` | `13px` | `14px` |

**Headings came down one step on 05-08-2026.** Owner: *"the text font size is
to big"*. Measured across five pages at 375px, nothing visible exceeded the
canon — every oversized hit was a screen-reader-only element, a hidden skip
link, an SVG `<title>` or the wordmark. So the canon itself was the complaint,
and shown the numbers the owner chose **headings only**.

Why the earlier `+3`/`+4` was wrong, recorded so it is not re-derived: the
"+1pt" instruction was about ONE element — `.t-h3` in the Strategy Liveness
card, against a 9px body. Turning that into a whole ladder, and then adding a
further step for the page title, compounded a single-element adjustment into
every heading on every page. `--fs-body` and `--fs-head` did not move: `9.5`
and `11` are the owner's own stated numbers and were never what read wrong.

Tablet and iPhone share a tier because they are the same thing for reading: a
held device where the constraint is fitting a dense table on a narrow screen.
The desk is a fixed screen with room to spare. **That is why desktop is larger
than phone here and not the reverse** — the phone is not a small desktop.
`9.5px` is the floor; the touch tier sits exactly on it.

Everything downstream derives from `--fs-body` by a fixed offset, so moving
the body size moves the whole ladder and the hierarchy cannot drift apart.
Form fields ride it too (`--font-field-max: var(--fs-head)`).

Nothing carries a px literal any more. Tailwind call sites use
`text-(length:--fs-body)` — the explicit v4 length syntax, because
`text-[var(--fs-body)]` silently compiles to `color` (see
`css-token-syntax.test.js`). Inline styles use `var(--fs-body)` / `var(--fs-h)`.

| Role | Token | Weight |
|---|---|---|
| Major heading (page title, modal/print title, `.t-h1`/`.t-heading`) | `--fs-title` | `800` |
| Section title (card heading, `.t-h2`/`.t-h3`) | `--fs-h` | `700–800`, accent |
| Column header cell (`thead th` / `.t-gridhead`) | `--fs-head`, proper case, **wraps** | `600` (`W_HEAD`) |
| Row identifier / first-column head | `--fs-body` | `500` (`W_ROWLABEL`) |
| Every data cell (`tbody td`, app-wide, ledger included) | `--fs-body` | `400` (`W_CELL`) |
| All other data / info text (captions, meta, pills, footnotes, controls) | `--fs-body` | `400` |
| Headline figure per card | `--fs-body` | `800` — emphasis by weight + colour, not size |

The px-named `--fs-d*` scale is gone entirely: a token called `d9` that renders
11px on a desk is a lie in the source. Enforced by
`src/lib/type-canon.test.js`, which fails on **any** px literal in **any**
file, and checks both tiers and the offsets.

### Glyphs are not text

There is **no exception list**. There used to be one — six files with a
table of allowed px literals — and an exception list is a list of things
nobody owns, so it only ever grows. Owner, 05-08-2026: *"fix C1"*.

It was split by what each thing actually is:

| | token | tiers |
|---|---|---|
| sidebar + tab-bar icons | `--fs-glyph-sm` 14px | flat |
| phone tab-bar icons, `×` close marks | `--fs-glyph-md` 16px | flat |
| `☰` table-of-contents FAB | `--fs-glyph-lg` 18px | flat |
| `+` order FAB | `--fs-glyph-xl` 22px | flat |
| `bot-trade` wordmark | `--fs-wordmark` 15px | flat |

**Flat across both tiers on purpose.** An icon that resized with the type
tier would change its own tap target, which is the one thing about a tab-bar
icon or a floating action button that must not move.

The phone BUY/SELL and CLOSE buttons went the other way: their **labels** are
text and now carry `--fs-h`. Their boxes (`w-full`, `py-2.5`) are untouched —
the tap target has nothing to do with the type scale, and binding the two
together is what made them look like an exception in the first place.

Form fields keep their own older rule (`min(calc(1em + 1px),
--font-field-max)`, owner 2026-07-28), which still wins over any class — but
the cap now rides `--fs-head` instead of pinning 10px, so fields move with
the tier.

### Text colour

Owner, 05-08-2026: "darker font colour during light mode and light-brighter in
dark mode." Contrast is measured against the surface the app actually paints —
the glass card, `rgba(255,255,255,.62)` over `--color-bg`, not `--color-bg`
itself — and every text token clears **4.5:1** in all three themes. Two of them
did not before: `--color-muted-light` sat at 2.83:1 (light) and 2.50:1 (dark),
i.e. effectively invisible at any size. `src/lib/type-canon.test.js` recomputes the
ratios from `index.css` on every run.

### The bold rule

**Bold is reserved for two things per card:** the section title, and at most
one headline figure. Nothing else. Body text is never bold — the owner has
raised this more than once, and an audit that found 121 of ~135 bold elements
on this page is what produced the current tokens.

Emphasis inside a data row comes from **colour** (`P_UP` / `P_DN` / `P_MU`),
never from weight.

### Headings

A heading is distinguished by weight, colour (`P_ACC`/accent for section
titles) and position — the scale moves one step per level (`--fs-h` = body+3,
`--fs-title` = body+4). `.t-h3` is `var(--fs-h) / 700`; the old escalating
per-breakpoint heading scale is gone on purpose, and the two-tier canon
replaced it with exactly one step.

The Performance and Workflow-audit pages build several section titles as
`<span style={{ fontSize: 'var(--fs-h)', fontWeight: 800 }}>` rather than as
`.t-h3` elements. Those spans are headings and carry the heading token; a
`--fs-h` on anything that is not a title is a bug the canon test will not
catch, because it cannot read intent.

### Numbers

Every numeric cell carries `fontVariantNumeric: 'tabular-nums'` so columns of
figures align on the digit. Signed money uses `signed()` (explicit `+`),
absolute money uses `money()`.

---

## 3 · Colour

Use the tokens, never raw hex, except in the deliberately-palette'd regime
plot. Token shortcuts on the Performance page:

```
P_ACC  --color-accent          section titles, active pills
P_UP   --color-up              positive P&L
P_DN   --color-down            negative P&L
P_TX   --color-text            primary reading text
P_SB   --color-text-sub        secondary prose
P_MU   --color-muted           units, timestamps, "—", quiet metadata
P_WRN  --color-warning-text    conditions the reader must not miss
P_EDG  --glass-edge            hairline rules inside a card
P_GBD  --color-border          card borders
P_GL   --color-surface         card background
P_ACS  --color-accent-soft     active tint
```

**Green is forbidden** and enforced by `npm run check:no-green`. Positive is
`--color-up`, which is not green in this theme.

### ON / OFF state

Owner, 2026-07-29: *"The positive / or ON button or state should be blue with
the blueish-tint background while the negative or OFF button or state is red
with redish-tint background."* Plus the HIG note: *"Use green or system accent
colors sparingly and consistently to show completion or active choices."*

```
--color-state-on-text / -bg / -border     ON, armed, enabled, open, reachable
--color-state-off-text / -bg / -border    OFF, disarmed, disabled, closed, failed
```

Both states are **filled**, not just outlined — a tinted background is the
cue that survives a 9px label. Use `<Badge tone="on">` / `tone="off"`, or the
tokens directly on a switch.

Three rules that are easy to get wrong:

1. **Do not use `up`/`down` for state.** Those mean profit and loss. An armed
   strategy is not a profit. `tone={x ? 'up' : 'down'}` on an ON/OFF pill
   reads as money and was corrected across Tune, Desk, Connect and MarketClock.
2. **OFF is red, not neutral grey.** Several tables rendered a disarmed
   strategy in the same muted grey as "no data", so *off* and *unknown* were
   indistinguishable. Grey means "we don't know"; red means "we know, and it
   is off".
3. **The clay accent is navigation, not state.** `--color-accent` marks the
   active nav pill and section titles. An armed toggle painted with it looked
   like a selected tab; ON is blue.

Per theme: light and dark resolve ON to blue and OFF to red. **Sepia** has no
blue in its palette, so it resolves ON to its own warm accent — declared
explicitly rather than inherited, because inheriting light mode's `#1a56db`
would drop a cold blue onto warm paper.

Table heads use Apple system-grey tokens, set per theme:

```
--table-head-bg    light #f2f2f7 · dark #1c1c1e · sepia #efe7d8
--table-head-fg    light #3c3c43 · dark #ebebf5 · sepia #4a3d26
--table-head-rule  rgba(60,60,67,.29) / rgba(235,235,245,.3)
```

All three themes (light / dark / sepia) must be legible. Check before shipping.

---

## 4 · Layout, grid and symmetry

### Breakpoints

| Width | Meaning |
|---|---|
| `≤ 559px` | phone — everything single column |
| `≥ 700px` | Performance switches from pill screens to full sections; **the section-nav FAB appears here — on every page** (`SectionNavFab`; Tune's FAB switches tabs instead of scrolling) |
| `≤ 1023px` | even panel pairs stack |
| `≤ 1279px` | tablet: table head padding drops to `3px`, sticky first column engages, uneven pairs stack |
| `≥ 1024px` | desktop sidebar appears (`lg`) |

The FAB and the section/pill branch **must switch at the same breakpoint**.
They didn't once, and iPad portrait got 14 sections with no jump-nav.

### The `minmax(0, …)` rule

A bare `1fr` is `minmax(auto, 1fr)`. In a grid containing a wide table, the
table's min-content width forces its own track past its share and steals the
space from its neighbour — this is what crushed the FX-bands card to a 140 px
ribbon. **Every fractional track that can contain a table is written
`minmax(0, 1fr)`**, the grid item gets `minWidth: 0`, and the wide child gets
`overflowX: 'auto'` so it scrolls inside its own panel instead of deforming the
row.

Shared classes:

```css
.perf-2col-even   minmax(0,1fr) minmax(0,1fr) · gap 8 · stacks ≤1023px
.perf-regime      minmax(260px,330px) minmax(0,1fr) minmax(260px,330px)
                  → 2-up with the chart full-width above, ≤1279px
                  → single column ≤559px
.perf-band-row    118px 84px 1fr → 1fr ≤1279px
```

### Symmetry rules

- Paired cards in a row share `alignItems: 'start'` and identical padding.
- A card never `flex: 1` into a taller sibling's height — that stretch is what
  produced tall boxes holding two lines of text.
- Repeated columns use one shared `gridTemplateColumns` constant
  (`OPEN_COLS`, `SESS_COLS`, `TODAY_HOURLY_COLS`, `TODAY_TRADE_COLS`,
  `WEEKEND_ROW_COLS`) — declared once, at module scope, and reused by both the
  head row and the body rows so they cannot drift apart.
- A card whose content is wider than its column scrolls; it never widens the
  row.

### Full-width vs paired

A card goes **full width** when its rows are horizontally dense — the FX-banded
card carries every pair per band, so width is the only thing that makes it
readable. A card is **paired** when it's a short list or a summary. Don't pair
two wide tables.

---

## 5 · Cards

Every card is the same object:

```
┌───────────────────────────────────────────────────── ▾ ⧉ ┐
│ Section title      short caption explaining the data     │  ← one baseline row
│ headline figure                                          │  ← optional, 14/800
│ ─────────────────────────────────────────────────────    │
│ COLUMN HEADS                                             │
│ data row                                                 │
│ data row                                                 │
│ ‹ Page 1 / 3 ›                                           │
└──────────────────────────────────────────────────────────┘
```

**Header line.** Title (`flexShrink: 0`), then the caption on the *same
baseline* (`alignItems: 'baseline'`, `flexWrap: 'wrap'`), then tools pushed
right. The caption says what the data is and how it reconciles with the other
cards — that sentence is part of the UI, not decoration.

**Collapse triangle** (`▾` / `▸`) at `right: 34` when copyable, `right: 8`
otherwise. Collapsing sets `display: none` on the body rather than unmounting
it, so sort/page/scroll state survives and everything below genuinely **moves
up**. The collapsed bar still shows the card's heading text.

**Copy button** (`⧉`) at `right: 8`. Opens the copy popup with two tabs:

- **Text** — the card's rendered `innerText`, or a hand-written `toText`.
- **JSON** — an explicit `data` prop if the caller passes one, otherwise
  derived automatically from the card's own `<table>` by `tableToJson()`
  (`thead th` → keys, `tbody tr` → values, colSpan detail rows skipped).

Because the JSON is scraped from the DOM, **every card containing a table gets
a JSON tab on every page with no per-page work**, and what it emits is exactly
what is on screen — it cannot drift from the UI. That is the fix for "why do
other pages only have text copy".

---

## 6 · Tables

### Anatomy

```
▸  09:41   XAUUSD   LONG 0.05                      -412.30
   ↑ 14px  ↑ 42px   ↑ 66px  ↑ 74px                  ↑ 1fr, right-aligned
   marker  time     symbol  side/lots               P&L
▾  TP partial · fib_618_fade · opened 08:12 UTC · held 1h 29m · plan 2.4:1
   ↑ one expansion line, 20px indent, P_MU
```

Rules:

- Marker column is exactly `14px`. `▸` collapsed, `▾` expanded.
- Identifier column is `W_ROWLABEL`; everything else `W_CELL`.
- The money column is **right-aligned** and coloured by sign.
- Row separator is a single `1px solid P_EDG` bottom border. No zebra fill, no
  outer box per row.
- Row padding `1px 0`. Column gap `6`.

### Column heads — one rule, no exceptions

Every header in the app resolves to the SAME five properties. There are two
implementations because the app has two kinds of table, and they are kept
identical on purpose.

**Real `<table>`** — the unlayered element selector, which beats Tailwind's
layered utilities, so a stray `font-bold` on a `<th>` cannot change anything:

```css
thead th {
  font-family: inherit;                            /* Inter */
  background: var(--table-head-bg);
  color: var(--table-head-fg);
  border-right: 1px solid var(--table-head-rule);  /* none on last cell */
  padding: 0 8px;          /* → 0 3px at ≤1279px */
  font-size: 10px;          /* the ONE exception to the 9px body size */
  font-weight: 600;
  text-transform: none;     /* proper case — UPPERCASE widens ~10% */
  letter-spacing: normal;
  white-space: nowrap;      /* one line, never two, never three */
  text-align: center;
}
```

**Column heads are `--fs-head` (body + 1), proper case, and they WRAP.**

That last part changed on 05-08-2026, owner: *"please rescale the column to
scrollable within table cell or word wrap."* Raising the desk body to 11px
widens every column, and the previous answer — `nowrap` heads plus a
horizontal page scroll — stops being honest once the table is wider than the
screen by more than a nudge.

What the 2026-07-25 `nowrap` was protecting against was a **three-row** header,
and that came from UPPERCASE + 12px + an unconstrained break, all three at
once. Proper case and the head size stay, so a wrapped head is two lines, not
three — and two readable lines beat one line the reader has to scroll sideways
to finish.

Three rules carry it:

- `thead th` and `.t-gridhead > *`: `white-space: normal; overflow-wrap:
  anywhere`. The grid head also **lost its ellipsis** — that HID the label, and
  a grid column template is fixed, so a truncated head could not be recovered
  by scrolling the way a real table's could.
- `tbody td`: `overflow-wrap: anywhere`, so a 9-digit position id or
  `USDCNH.spot` breaks instead of stretching the column. Deliberately **no**
  `white-space` here — the rule is unlayered and would beat the
  `whitespace-nowrap` that keeps prices and timestamps on one line.
- `.cell-scroll`: opt-in, on a cell's own child span. For content that must
  stay on one line and is long, the **cell** scrolls, not the table.

**CSS-grid tables** (most of the Performance page) get `.t-gridhead` on the
header row, which declares the same font, size, weight, case, colour and
background, with `border-right` on each child except the last, plus
`white-space: nowrap; overflow: hidden; text-overflow: ellipsis` so a long
label truncates instead of wrapping or colliding. No horizontal padding there:
the grid templates are tuned to the pixel and the existing `gap` already
separates the cells the rule divides.

**A header row must not declare font, size, weight, case, colour or wrapping
itself.**
Inline styles beat the class and per-`th` utilities confuse the reader about
where the value comes from — an audit found three different header weights in
use (700 in the ledger, 600 in most tables, 500 in a few) purely from local
overrides. If a header needs to look different, change the rule, not one table.

Resolved values, all three themes:

| | Light | Dark | Sepia |
|---|---|---|---|
| Font | Inter → `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif` | same | same |
| Size / weight | 10px / 600, proper case, one line | same | same |
| Text colour | `#3c3c43` | `#ebebf5` | `#4a3d26` |
| Background | `#f2f2f7` | `#1c1c1e` | `#efe7d8` |
| Cell border | `rgba(60,60,67,.29)` | `rgba(235,235,245,.30)` | `rgba(74,61,38,.28)` |

Never a coloured or branded head fill — Apple system grey only. The declared
12px renders at 13.2px wherever the viewport is ≥1153px, because of
`html { zoom: 1.1 }`; iPad mini never crosses that line in either
orientation, a full-size iPad does in landscape.

At `≤1279px` the padding drops to `3px` per side. On the 12-column ledger that
8 px→3 px change recovers ~120 px of pure padding, which is what let the table
finally reach end to end instead of being cut off mid-number.

### Sticky first column

Wide tables carry `.t-sticky-col`. Below 1280 px the first column pins:

```css
.t-sticky-col tbody td:first-child,
.t-sticky-col thead th:first-child { position: sticky; left: 0; z-index: 3; }
```

so the row's identity stays on screen while the reader scrolls the numbers.

### Pagination

`PagedRows({ rows, pageSize = 4, maxHeight = 150 })`. The pager only renders
when `rows.length > pageSize`. Controls are `‹ Page 1 / 3 ›` at `12px`,
`marginTop: 4`. Tables the owner reads closely (Today) use
`pageSize={8} maxHeight={300}`.

Never let a table scroll unbounded down the page; never paginate a 3-row table.

### Expandable rows

**Every row that has more to say is expandable.** One canonical pattern:

```jsx
<div role="button" tabIndex={0} aria-expanded={open}
     onClick={toggle}
     onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}>
```

- Exactly one row open at a time per table (`openId` state).
- The collapsed row is **one line**. Never six.
- The expansion is **one line** of `·`-joined facts, or a short bullet list when
  there are genuinely distinct points — never a paragraph.
- Fields with no data are **dropped from the expansion**, not printed as `—`.
  A row that prints `in: … → out: —` on every single trade is noise.

This is what OHLC/volume/SL-TP detail is for: it belongs in the expansion, not
inline. Inline OHLC is what made weekend rows wrap to six lines each.

### Point texting

When a cell must carry several facts, write **short points**, one per line —
not one long `·`-joined sentence that wraps to six lines inside a 130 px cell.
The owner's phrase for this is "point texting", and it is a requirement for any
narrow cell containing prose.

---

## 7 · States

| State | Treatment |
|---|---|
| Loading | `<Skeleton lines={n} />` shimmer, `role="status"`, `sr-only` "Loading…". **Never** a spinner, never bare "Loading…" text. |
| Empty (no data in range) | One `12px` `P_MU` line that says *why* it's empty and what to do: "No activity in this range — this chart draws from the bot's decisions and closed trades. Widen the range to see more." |
| Empty (window closed) | Fall back to the last **completed** window and label it: "market closed — showing Friday's full FX day". A card is never blank because the market is shut. |
| Not collected yet | Say so plainly: "the agent does not ingest broker cash-flow events yet". Never imply a zero. |
| Too sparse to draw | Draw the points, not a line. Two points connected read as a trend that doesn't exist. Footnote it. |
| Uncounted / unmapped | **List the items**, don't print a count. "26 positions outside the map" told the reader nothing they could act on. |

---

## 8 · Navigation

Four coordinated surfaces.

### Desktop sidebar (`≥1024px`)

`lg:w-56`, sticky full height, `.glass-panel` inner with
`overflow-y: auto` so long nav never clips. Grouped: **Overview** (Performance,
Desk) · **Trading** (Trade, Accounts) · **Setup** (Tune, Risk, Connect). Active
item is an accent gradient with a glow; inactive is `P_SB` text. Theme cycle
button pinned to the bottom (`mt-auto`).

### Mobile / tablet top bar (`<1024px`)

Sticky pill bar at `top-3`, horizontally scrollable, `min-h-[36px]` tap targets,
theme toggle pushed to the right.

### Fixed footer

`position: fixed` at the viewport bottom (not the page-flow end) so it is
visible on short screens; `lg:left-56` clears the sidebar; `z-40`. `main`
carries `pb-20` / `lg:pb-16` so real content is never permanently hidden under
it. Content scrolls *behind* the translucent bar.

### The FAB stack — full spec

Two buttons, one fixed column, bottom-right on every page that mounts
`SectionNavFab`. They answer the two questions a reader has on any screen, in
the same corner: **where am I** (☰) and **whose numbers is this** (the account
pill).

| Property | Value |
|---|---|
| Container | `.fab-stack` — `fixed`, `right: 18px`, `z-index: 40`, column, `align-items: flex-end`, `gap: 8px` |
| Bottom | `calc(49px + env(safe-area-inset-bottom) + 10px)`; **`18px` at `≥1024px`** |
| Visibility | **every width.** Never `hidden min-[700px]:*` again — see below |
| Nav button | `44 × 44`, `borderRadius: '50%'`, `1px solid P_GBD`, `.glass-fixed`, glyph `☰` / `×` at `--fs-glyph-lg` |
| Account button | `56 × 44`, `borderRadius: 22`, `.glass-fixed`, two stacked lines: `DEMO`/`LIVE`/`ALL`/`ACCT` at `--fs-body`, then the 4-digit login (or `ACCTS` / `?`) at `--fs-head` |
| Panels | `.glass-panel`, `marginBottom: 8`, `borderRadius: 12`; **one open at a time** — both at once runs off the top of a 375px screen |
| Panel rows | full-width left-aligned, `--fs-body`, `min-height: 44px` on the account sheet |
| Nav source of truth | `src/lib/nav-tree.js` — every page, sub-page and section, each tagged T/F/C |
| Scope source of truth | `lib/scope-fab.js` (face + rows) over `lib/scope-label.js` (naming) |
| Scope action | `setViewedAccount` — the VIEW lens. **Never** `/actions/ctrader-select-account` |

**The bottom offset is a correctness rule, not a margin.** `MobileTabBar` is
`min-h-[49px]` and `lg:hidden`, so it occupies the bottom edge at every width
below 1024px. A FAB parked on top of it steals taps from the app's primary
navigation. `scripts/responsive-audit.mjs` measures this on every route and
fails on `OVERLAPS-TABBAR`.

**Phones see it.** The stack carried `hidden min-[700px]:flex` until
05-08-2026, so on the owner's iPhone SE (375px) it had never once been painted
— and the audit's narrowest width was 390px, so nothing measured the width
where its absence would have shown. 375 is now in the audit's width list.

**Three states on the account face, and the third is the point.** `DEMO 7353`
(one account) · `ALL ACCTS` (aggregated) · `ACCT ?` (roster not loaded, or an
id not in the registry). An unresolved roster must never fall back to the ALL
face: "I am looking at every account" and "I do not know which account this is"
are different facts.

**Live is a word, never a colour.** The live account's sheet row carries the
literal token `LIVE`, and the face says `LIVE` above the digits — the owner
reads red and green as one thing, so hue cannot be the only carrier on the most
consequential row.

### iOS Safari constraint (non-negotiable)

`position: fixed` / `sticky` **plus** `backdrop-filter` makes WebKit paint the
element at a stale scroll offset — the footer, sidebar and FAB were all drifting
into the middle of the viewport at *different* offsets. Any pinned element uses
`.glass-fixed`: no blur, `transform: translateZ(0)`, `will-change: transform`.
And `@supports (-webkit-touch-callout: none)` drops the blur from `.glass-panel`
entirely.

**Rule: nothing pinned may carry `backdrop-filter`.**

---

## 9 · Motion

Small, purposeful, and skippable.

- Transitions only on `button, a, [role="button"], summary`.
- List insert/remove via `useAutoAnimate({ duration: 160 })`.
- Numbers that change under the reader's eye use `NumberFlow` — headline
  figures only, never a whole column.
- Route changes use `viewTransition` on `NavLink`.
- Action failures surface as a `sonner` toast (`richColors`, top-right, clear of
  the footer). Reads (`agentGet`) stay silent — pages poll on timers and would
  otherwise spam.
- `@media (prefers-reduced-motion: reduce)` collapses every animation and
  transition to `.01ms`, globally.

---

## 10 · Text and copy style

The words are part of the interface. They follow the same discipline as the
layout.

**Voice.** Plain, specific, unhedged. State what is true. If something is not
known, say that it is not known and why.

**Every card's caption answers two questions:** what am I looking at, and how
does it reconcile with the other cards? Examples in use:

> same trades as the ledger's Forex column, pair-level lens · rolling 7 days = the 1W row · tap a pair for TP/SL detail

> the ledger's 30D row re-sliced by strategy — each market column here sums to the 30D market cell above

> closed trades since FX day open (5pm NY) · bucketed by close time · fixed UTC windows (current DST) · sessions overlap

**Separator.** ` · ` joins facts inside one line. Never a comma-spliced
sentence, never a semicolon.

**Units and provenance ride with the number:** `held 1h 29m`, `plan 2.4:1`,
`risked $120`, `as of 14:57:03 UTC`, `last 4h ago`.

**Time.** The Performance page is **UTC throughout** — it matches the FX-day
anchor (17:00 NY) and the session windows. Any timestamp shown in a different
zone must be labelled with that zone in the same string. *(Open decision — see
§12.)*

**Caveats are first-class, not footnotes.** When the data is reference copy
rather than a live computation, the card says so in `P_WRN`:

> quadrant playbooks are the design's reference copy — the bot does not compute a live regime read yet

**Never write:** "Loading…", "N/A", "Coming soon", "Oops", exclamation marks,
or any figure the app did not actually compute.

---

## 11 · Review checklist

Before a UI PR is opened, walk this list on an iPad-mini-width viewport, in
**portrait and landscape**, in all three themes:

- [ ] Every font size comes from `--fs-body` / `--fs-head` / `--fs-h` /
      `--fs-title` — no px literal anywhere. `npx vitest run
      src/lib/type-canon.test.js` checks this, both tiers, without a browser.
- [ ] Check the 1279/1280px boundary: the type tier and the layout breakpoint
      must change together, not a viewport apart.
- [ ] No bold body text anywhere.
- [ ] No vertical gap over `12px` without a comment justifying it.
- [ ] Data rows are `padding: '1px 0'`.
- [ ] Every fractional grid track that can hold a table is `minmax(0, …)`, and
      its item has `minWidth: 0`.
- [ ] No card is crushed; no card has a large empty region; no card stretches
      to a sibling's height.
- [ ] Repeated column templates come from one shared constant.
- [ ] Every table reaches end to end or scrolls inside its own panel, with the
      identity column pinned below 1280 px.
- [ ] Every row with more to say expands, with the keyboard as well as tap.
- [ ] Expansions are one line; absent fields are omitted, not `—`.
- [ ] Loading states are skeletons.
- [ ] Empty states explain themselves and offer the next move.
- [ ] Nothing pinned carries `backdrop-filter`.
- [ ] The FAB is present at every width where the section layout is, and every
      menu entry scrolls to a real section.
- [ ] `⧉` gives both a Text and a JSON tab.
- [ ] `npm run check:no-green` passes.

---

## 12 · Open decisions

| # | Question | Status |
|---|---|---|
| 1 | **Canonical clock** — UTC everywhere (matches the ledger, FX-day anchor and session windows) or viewer-local everywhere? The Performance page is UTC; the Desk's loss review is viewer-local, and the 8-hour offset can put the same trade on a different calendar day depending on the page. | Awaiting owner |
| 2 | **Table-head hex** — currently documented Apple `systemGray6` / secondary-label values. An exact "iOS 27" hex will be used if supplied; one will not be invented. | Awaiting owner |
| 3 | **Collapse triangles on the 11 non-`Card` Performance sections** (accounts, today+open, gradients, fx-bands, strategy-matrix, crypto, winners/laggards, regime, balance, data-feed) — needs a structural JSX wrapper per section. | Not started, awaiting go |
| 4 | **What each remaining table's expansion reveals** — session rows → the individual trades in that session; strategy rows → per-symbol contributions. Proposed, not confirmed. | Awaiting owner |
