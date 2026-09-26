// UI render audit — render every page and MEASURE, rather than eyeballing a
// screenshot.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/responsive-audit.mjs /risk,/tune,/desk            # layout
//   node scripts/responsive-audit.mjs /performance --live          # + real agent
//
// THE --live PASS EXISTS BECAUSE ITS ABSENCE SHIPPED A BLANK APP. On
// 2026-07-29 a temporal-dead-zone error in Performance.jsx took down every
// route for several hours (#482 → fixed in #489). This script was run for
// that PR and reported clean, because it aborts every non-localhost request:
// with no agent, Performance returns early and never reaches the broken line.
// Tests, lint and build cannot see a render-time error either. A UI change is
// NOT verified until it has been rendered against a reachable agent, and a
// PAGE ERROR IS A FAILURE, not a footnote — so `err` is reported on every row
// and --live exits non-zero if any route throws.
//
// Reports per route x width:
//   ov        horizontal overflow in px (must be 0)
//   touch<44  interactive controls whose EFFECTIVE tap height is under the
//             44px HIG minimum — counting the ::after halo, not just the box
//   minFont   smallest font size actually painted
//   WIDE      the outermost elements sticking past the viewport edge
//
// NOTE: `NAV.flex.gap-1` is expected in the WIDE list at 390px. The tab strip
// is INSIDE a horizontally-scrolling region, so extending past the viewport
// is correct behaviour, not a bug. What was a bug — the theme button sitting
// off-screen because `ml-auto` resolves against scroll width — no longer
// appears there.
import { chromium } from 'playwright'
const ROUTES = process.argv[2].split(',')
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
// hasTouch is REQUIRED for `pointer: coarse` to match — without it the
// phone media query never applies and the audit would score the fix as a
// no-op while it works fine on a real phone.
const ctx = await b.newContext({ hasTouch: true })
// LAYOUT mode aborts every off-host request: each one otherwise sits on a
// long timeout, which stalled the first audit run, and layout must be right
// before data arrives anyway. LIVE mode lets them through, which is the only
// way to exercise the code paths that run once data is present.
const LIVE = process.argv.includes('--live')
const AGENT = process.env.AUDIT_AGENT_URL || 'https://sg-trade.up.railway.app'
// BOUND-POSITION FIXTURE (PR-F, CLAUDE.md failure mode #3). Layout mode
// aborts every off-host request, so a route carrying ?trade=… rendered the
// cockpit with NO position — the very panels principle 6 is about (the
// header actions, the chart empty state, the Manage sheet's guard fields)
// were never measured. Two agent calls are now answered from a fixture in
// BOTH modes when the route carries ?trade=: the cockpit snapshot and the
// position-guard read. Everything else keeps its mode's rule. The fixture
// is scripts/fixtures/cockpit-snapshot.json and says so in its meta.
import { readFileSync } from 'node:fs'
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/cockpit-snapshot.json', import.meta.url), 'utf8'))
// UI-3 (26-09 plan §8 item 3): the blockers card's own 15-row viewport
// (scroll, never squash) can only be measured against ROWS — a `/performance`
// pass with no agent renders the card empty, same blind spot the bound-
// position fixture above fixed for the cockpit. Answered in BOTH modes so a
// layout-only run still exercises it, the same treatment `?trade=` already
// gets.
const BLOCKER_FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/blocker-report.json', import.meta.url), 'utf8'))
const FIXTURE_AGENT = 'http://fixture-agent.invalid'
await ctx.route('**', (route) => {
  const u = route.request().url()
  if (u.includes('localhost:4173')) return route.continue()
  if (/\/state\/position\/[^/]+\/cockpit/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) })
  if (/\/actions\/position-guard-get$/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, positionId: '1', guard: { trailing: { on: true, distancePips: 12 } }, beMoved: false, monitored: true }) })
  // Every account/window/zone answers the same fixture — the audit measures
  // layout, not report identity, and BlockerReport's own identity check
  // (r.accountId === accountId, etc.) only cares that ONE consistent shape
  // comes back for whatever it asked.
  if (/\/state\/blocker-report/.test(u)) {
    let query = {}
    try { query = Object.fromEntries(new URL(u).searchParams) } catch { /* malformed query: fall through to the fixture's own accountId/from/to */ }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ...BLOCKER_FIXTURE, accountId: query.account ?? BLOCKER_FIXTURE.accountId,
      from: query.from ? Number(query.from) : BLOCKER_FIXTURE.from, to: query.to ? Number(query.to) : BLOCKER_FIXTURE.to,
    }) })
  }
  if (LIVE) return route.continue()
  return route.abort()
})
let failed = 0

for (const r of ROUTES) {
  // LIVE used to run only at 1024. That is precisely the blind spot that let a
  // DUPLICATED session strip ship to the owner's iPhone (2026-07-30): the
  // duplicate only exists below 700px AND only renders once data is present, so
  // the desktop-only live pass and the data-less phone pass each missed it from
  // opposite sides. Live now covers the same widths as layout mode.
  // 375 is the iPhone SE (2019) the owner actually carries. It was missing
  // until 05-08-2026, and its absence hid a real defect for months: the FAB
  // stack was `hidden min-[700px]:flex`, so on that phone it had never been
  // painted — and no audited width was narrow enough to be the one where a
  // FAB going missing would have shown up as a difference.
  // 768 and 740 (02-09-2026): the Performance balance-in/out header is a
  // fixed-column grid ~740px wide. It overflowed the document at every width
  // between ~700 and ~790 and NO audited width fell in that band — 820 was
  // wide enough, 390 narrow enough for other things to dominate. A defect
  // that lives between two sampled widths is invisible to a sampled audit.
  for (const w of [1024, 820, 768, 740, 390, 375]) {
    const p = await ctx.newPage()
    const errs = []
    p.on('pageerror', e => errs.push(String(e.message).slice(0, 110)))
    await p.setViewportSize({ width: w, height: 900 })
    const bound = /[?&]trade=/.test(r)
    // UI-3: any route that can mount the blockers card (today just
    // /performance) also gets the fixture host, so its OWN unrelated fetches
    // (trades, positions, risk-full, …) keep their existing behaviour —
    // still aborted, still answered by `.catch(() => null)` — while
    // /state/blocker-report specifically gets real rows to measure.
    const perfFixture = r.startsWith('/performance')
    if (LIVE || bound || perfFixture) {
      // Point the app at a real agent the way a browser would (or, in
      // layout mode, at the fixture host so the routes above answer it),
      // then reload so the pages fetch on mount.
      await p.goto('http://localhost:4173/').catch(() => {})
      await p.evaluate((u) => localStorage.setItem('agent_url', u), LIVE ? AGENT : FIXTURE_AGENT)
      // agentConfigured() needs BOTH the url and a secret; the fixture host
      // never sees the value, every request to it is answered or aborted above.
      if (!LIVE) await p.evaluate(() => localStorage.setItem('agent_secret', 'fixture'))
    }
    await p.goto('http://localhost:4173' + r).catch(() => {})
    await p.waitForTimeout(LIVE ? 8000 : (bound || perfFixture) ? 1800 : 700)
    if (bound) {
      // Open the Manage sheet so the PositionManager is measured WITH a
      // position (its guard fields answered by the fixture). A missing
      // button is a failure — that is the decorative state this exists to catch.
      const manage = await p.$('.tc-root button:has-text("Manage")')
      if (!manage) { errs.push('bound-position route rendered no Manage button in the cockpit') }
      else { await manage.click().catch(e => errs.push('Manage click failed: ' + e.message)); await p.waitForTimeout(600) }
      const sheet = await p.$('[aria-label="Manage position"]')
      if (!sheet) errs.push('Manage did not open the position sheet')
      const guard = await p.$('[data-guard-read]')
      const guardState = guard ? await guard.getAttribute('data-guard-read') : null
      if (guardState !== 'stored' && guardState !== 'reading') {
        // The Stop & Target tab is where the guard note lives; open it.
        const tab = await p.$('[role="tab"]:has-text("Stop & Target")')
        if (tab) { await tab.click().catch(() => {}); await p.waitForTimeout(300) }
      }
      const guard2 = await p.$('[data-guard-read]')
      const st = guard2 ? await guard2.getAttribute('data-guard-read') : 'absent'
      if (st !== 'stored') errs.push(`guard fields not filled from the fixture guard (data-guard-read=${st})`)
    }
    if (perfFixture) {
      // UI-3: the blockers card starts COLLAPSED (PERF-1's own default), and
      // BlockerReport only fetches while expanded — so, like the bound-
      // position Manage click above, the card must be opened before its
      // DataTable can be measured at all. The open choice PERSISTS
      // (lib/card-open.js) across the widths this loop runs through in the
      // same browser context, so a later width finds it already expanded —
      // that is success, not the "missing control" failure a truly absent
      // button would be.
      const collapseBtn = await p.$('#sec-blockers button[aria-label="Collapse this section"]')
      if (!collapseBtn) {
        const expand = await p.$('#sec-blockers button[aria-label="Expand this section"]')
        if (!expand) errs.push('the blockers card rendered no expand control (#sec-blockers)')
        else { await expand.click().catch(e => errs.push('blockers expand click failed: ' + e.message)); await p.waitForTimeout(600) }
      }
    }
    const m = await p.evaluate(() => {
      const de = document.documentElement, vw = de.clientWidth
      const wide = []
      for (const el of document.querySelectorAll('body *')) {
        const c = el.getBoundingClientRect()
        if (c.width > 0 && c.right > vw + 1 &&
            (!el.parentElement || el.parentElement.getBoundingClientRect().right <= vw + 1)) {
          wide.push((el.tagName + '.' + String(el.className || '').split(' ').slice(0, 2).join('.')).slice(0, 58))
        }
      }
      // DUPLICATE-RENDER CONTRACT. Any component that must appear at most once
      // per page carries data-once="<name>"; more than one VISIBLE element with
      // the same name is a bug. Visibility matters: a responsive pair where one
      // side is hidden is correct, two painted copies is the iPhone defect.
      // This is an explicit contract rather than a text-similarity heuristic —
      // table rows legitimately repeat, so a heuristic would be all noise.
      //
      // VISIBILITY IS NOT getBoundingClientRect HERE. The first version of this
      // check filtered on a non-zero rect and silently detected nothing — a
      // `display: contents` wrapper has NO box of its own, so its rect is
      // always 0x0 even while its children paint. Verified by restoring the
      // duplicate on purpose: the check reported clean. checkVisibility() is
      // the right question ("is this rendered, considering CSS"), with a
      // descendant-rect fallback for engines that lack it.
      // NOT checkVisibility(): Chromium returns FALSE for a `display: contents`
      // element because it generates no box of its own — even while its
      // children paint normally. Measured directly, both copies present and
      // one reported cv:false. Two wrong attempts here, both caught only by
      // deliberately restoring the duplicate and demanding the check fail:
      //   1. filter on a non-zero rect        → contents wrapper is 0x0
      //   2. gate on checkVisibility()        → contents wrapper is "invisible"
      // What "visible" actually means for this contract is "does this subtree
      // paint": display:none and visibility:hidden are definitive, everything
      // else asks the box, then the descendants.
      const isShown = (el) => {
        const st = getComputedStyle(el)
        if (st.display === 'none' || st.visibility === 'hidden') return false
        const own = el.getBoundingClientRect()
        if (own.width > 0 && own.height > 0) return true
        for (const d of el.querySelectorAll('*')) {
          const r3 = d.getBoundingClientRect()
          if (r3.width > 0 && r3.height > 0) return true
        }
        return false
      }
      const onceSeen = {}
      for (const el of document.querySelectorAll('[data-once]')) {
        if (!isShown(el)) continue
        const k = el.getAttribute('data-once')
        onceSeen[k] = (onceSeen[k] || 0) + 1
      }
      const dupes = Object.entries(onceSeen).filter(([, n]) => n > 1)
        .map(([k, n]) => `${k}x${n}`)

      // Effective TAP height = the visual box, or the ::after halo when one
      // is painted. Measuring only the box would score the fix as a no-op.
      let small = 0, total = 0
      for (const el of document.querySelectorAll('button,a[href],input,select')) {
        const c = el.getBoundingClientRect()
        if (!c.height) continue
        total++
        const after = getComputedStyle(el, '::after')
        const halo = after.content !== 'none' ? parseFloat(after.minHeight) || 0 : 0
        if (Math.max(c.height, halo) < 44) small++
      }
      // isShown, NOT computed style alone. A hidden subtree still reports a
      // fontSize, and reading it is exactly the mistake that made the 05-08
      // type audit file a display:none 15px wordmark as the live one while the
      // painted 12.5px element went unexamined. The rule the spec now states:
      // filter on a NON-ZERO BOX, never on computed style by itself.
      let minPx = 99
      for (const el of document.querySelectorAll('body *')) {
        if (!el.textContent?.trim() || el.children.length) continue
        if (!isShown(el)) continue
        const f = parseFloat(getComputedStyle(el).fontSize)
        if (f > 0 && f < minPx) minPx = f
      }
      // THE FAB STACK CONTRACT (05-08-2026). It carries the account scope —
      // "whose numbers am I looking at" — so it has to be on screen, and it
      // must not cover the bottom tab bar, which is the app's primary
      // navigation on every touch width. 'none' is legitimate: not every
      // route mounts SectionNavFab.
      let fab = 'none'
      const stack = document.querySelector('.fab-stack')
      if (stack) {
        const r = stack.getBoundingClientRect()
        const bar = document.querySelector('[data-tabbar]')
        const br = bar?.getBoundingClientRect()
        const painted = r.width > 0 && r.height > 0
        if (!painted || r.right > vw + 1 || r.bottom > de.clientHeight + 1) fab = 'OFFSCREEN'
        else if (br && br.height > 0 && r.bottom > br.top + 1) fab = 'OVERLAPS-TABBAR'
        else fab = 'ok'
      }
      // UI-3 (26-09 plan §8 item 3): common/DataTable.jsx's own contract —
      // a table with more than a 15-row viewport SCROLLS (both ways) instead
      // of its columns SQUASHING. Squash is what the plan measured before
      // this fix (columns down to 34-124px at 390px); scroll is the fix.
      // Reported for every `.data-table-viewport` painted on the page, not
      // only the blockers one, since every table this shell serves shares
      // the same contract.
      const dt = []
      for (const el of document.querySelectorAll('.data-table-viewport')) {
        if (!isShown(el)) continue
        const scrolls = el.scrollHeight > el.clientHeight + 1
        // .dt-icon-col (the Disclosure/Details column) is DELIBERATELY an
        // icon-width column, not a data column that squashed — excluded so
        // it cannot read as the same failure the plan measured (a SYMBOL or
        // REASON column crushed to 34-124px).
        let minCell = Infinity
        for (const cell of el.querySelectorAll('th:not(.dt-icon-col),td:not(.dt-icon-col)')) {
          const cw = cell.getBoundingClientRect().width
          if (cw > 0 && cw < minCell) minCell = cw
        }
        const squashed = Number.isFinite(minCell) && minCell < 30
        dt.push({ id: el.getAttribute('data-dt-viewport') || '(unnamed)', rows: el.querySelectorAll('tbody tr').length, scrolls, minCell: Number.isFinite(minCell) ? Math.round(minCell) : null, squashed })
      }
      return { ov: de.scrollWidth - de.clientWidth, wide: [...new Set(wide)].slice(0, 3), small, total, minPx, dupes, fab, dt }
    // A SWALLOWED EXCEPTION USED TO READ AS HEALTH. The old sentinel was
    // ov:0, dupes:[], fab:'none' — every one of which is a PASSING value, so a
    // crashed evaluate printed a clean line and never incremented `failed`.
    // The only tell was `0/0` in a column nobody reads. `fab:'none'` is
    // legitimate for a route that mounts no FAB, which is precisely why it
    // must not double as the error value. The sentinel now fails.
    }).catch(e => ({ ov: 0, wide: [], small: 0, total: 0, minPx: 0, dupes: [], fab: 'EVAL-FAILED', dt: [], evalError: String(e?.message || e) }))
    // bodyLen is the blank-page canary: a crashed React tree still renders the
    // skip-link and nothing else, which is ~20 characters.
    const bodyLen = await p.evaluate(() => document.body.innerText.trim().length).catch(() => 0)
    // A duplicated singleton is a FAILURE, not a footnote — same rule the
    // page-error case already follows, and for the same reason: the owner
    // found it before the tooling did.
    const dupes = m.dupes || []
    // bodyLen is only meaningful in LIVE mode — layout mode aborts every
    // off-host request, so a data-driven page renders near-empty BY DESIGN and
    // failing on it would make the layout pass permanently red.
    const fabBad = m.fab && m.fab !== 'ok' && m.fab !== 'none'
    // UI-3: squashed columns are a failure at any row count; a table that
    // OUGHT to scroll (more than the 15-row viewport) but does not is the
    // other half of the same contract. A table with 15 or fewer rows
    // legitimately shows no scrollbar — that is not a defect.
    const dtBad = (m.dt || []).filter(t => t.squashed || (t.rows > 15 && !t.scrolls))
    if (errs.length || dupes.length || fabBad || dtBad.length || (LIVE && bodyLen < 200)) failed++
    console.log(`${r} @${w} ov=${m.ov} touch<44=${m.small}/${m.total} minFont=${m.minPx} bodyLen=${bodyLen} fab=${m.fab}`
      + `${errs.length ? ' ERR: ' + errs[0] : ''}${dupes.length ? ' DUP: ' + dupes.join(',') : ''}`
      + `${m.wide.length ? ' WIDE: ' + m.wide.join(' | ') : ''}`
      + `${m.dt?.length ? ' DT: ' + m.dt.map(t => `${t.id}(rows=${t.rows},scroll=${t.scrolls},minCell=${t.minCell})`).join(',') : ''}`
      + `${dtBad.length ? ' DT-FAIL: ' + dtBad.map(t => t.id).join(',') : ''}`
      + `${m.evalError ? ' EVAL: ' + m.evalError : ''}`)
    await p.close()
  }
}
await b.close()
// Duplicate renders and page errors fail in BOTH modes; the blank-page canary
// only means something in live mode (layout mode renders empty by design).
if (failed) {
  console.error(`\nFAILED: ${failed} route/width combination(s) threw, duplicated a singleton, misplaced the FAB stack, squashed or failed to scroll a DataTable, or rendered blank.`)
  process.exit(1)
}
