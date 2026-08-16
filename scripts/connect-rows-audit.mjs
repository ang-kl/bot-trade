// ---------------------------------------------------------------------------
// scripts/connect-rows-audit.mjs — /connect account rows, WITH accounts present.
//
//   npm run build && npx vite preview --port 4173 &
//   node scripts/connect-rows-audit.mjs
//
// WHY THIS EXISTS SEPARATELY FROM audit:ui. Owner, 16-08-2026, iPhone
// screenshot: the badge, login, ID, broker name and both chips on every
// account row painted on top of each other, unreadable. `npm run audit:ui`
// covers /connect and reported it CLEAN — ov=0 at 390px — because it renders
// with no agent, so the account list is EMPTY and the rows that break do not
// exist. Same blindness its own header warns about for the 2026-07-29 blank-app
// incident: a pass that cannot see the rows it was written for.
//
// So this stubs the agent and renders seven accounts, matching the shapes the
// owner actually has (three LIVE, four DEMO, a long broker title, watchlist
// chips).
//
// WHAT IT MEASURES, and why not the obvious thing. Sibling BOX overlap finds
// nothing here: the identity button carried `flex-1 min-w-0`, so it collapsed
// to 0-21px wide while its 191-225px of text kept painting straight over the
// chips. The boxes never overlapped; the PIXELS did. So this compares the ink
// rectangles (a Range over each child's contents) of children on the same
// visual line, which is what the eye sees and what the screenshot showed.
// ---------------------------------------------------------------------------
import { chromium } from 'playwright'

const WIDTHS = [375, 390, 820, 1024]
const ACCOUNTS = [
  { accountId: 42993489, traderLogin: 1251247, isLive: true,  balance: 55.04,    brokerTitle: 'Pepperstone' },
  { accountId: 43002148, traderLogin: 1251442, isLive: true,  balance: 0,        brokerTitle: 'Pepperstone' },
  { accountId: 43069009, traderLogin: 1252961, isLive: true,  balance: 0,        brokerTitle: 'Pepperstone' },
  { accountId: 43097342, traderLogin: 5067353, isLive: false, balance: 1824.77,  brokerTitle: 'Pepperstone' },
  { accountId: 46130058, traderLogin: 5203012, isLive: false, balance: 35319.80, brokerTitle: 'Pepperstone' },
  { accountId: 46979908, traderLogin: 5268549, isLive: false, balance: 768.17,   brokerTitle: 'Pepperstone' },
  { accountId: 47790949, traderLogin: 5306502, isLive: false, balance: 47157.93, brokerTitle: 'Pepperstone' },
]
const WL = ACCOUNTS.map((a, i) => ({
  accountId: a.accountId, symbols: [25, 25, 25, 67, 24, 226, 55][i],
  backtested: [10, 10, 10, 18, 12, 24, 19][i], untested: 5, untestedSample: ['XAUUSD'], inherited: i < 3,
}))

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
let failures = 0

for (const width of WIDTHS) {
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width, height: 900 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    localStorage.setItem('agent_url', 'http://stub.local')
    localStorage.setItem('agent_secret', `sess_${'0'.repeat(20)}`)
  })
  await page.route('**stub.local/**', (route) => {
    const u = route.request().url()
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.includes('/actions/ctrader-accounts')) return json({ accounts: ACCOUNTS, selectedAccountId: 46130058 })
    if (u.includes('/watchlist-summary')) return json({ accounts: WL })
    if (u.includes('/state/symbol-map')) return json({ map: {} })
    return json({ accounts: [] })
  })
  await page.goto('http://localhost:4173/connect', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => /Login 5203012/.test(document.body.innerText), { timeout: 20000 })
  await page.waitForTimeout(500)

  const out = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('div.flex.w-full.items-center')].filter(r => /Login \d/.test(r.textContent))
    return rows.map((r) => {
      const rb = r.getBoundingClientRect()
      const ink = [...r.children].map((c) => {
        const rng = document.createRange(); rng.selectNodeContents(c)
        const t = rng.getBoundingClientRect(); rng.detach?.()
        return { t: (c.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22),
                 l: t.left, r: t.right, y: t.top + t.height / 2 }
      })
      const collide = []
      for (let i = 0; i < ink.length; i++) for (let j = i + 1; j < ink.length; j++) {
        const a = ink[i], b = ink[j]
        if (Math.abs(a.y - b.y) > 6) continue      // different visual lines
        if (a.l < b.r - 1 && b.l < a.r - 1) collide.push(`"${a.t}" over "${b.t}"`)
      }
      const spill = Math.round(Math.max(0, Math.max(...ink.map(k => k.r)) - rb.right))
      return { collide, spill }
    })
  })

  const bad = out.filter(r => r.collide.length || r.spill > 1)
  const docOv = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth))
  console.log(`/connect @${width}  rows=${out.length}  broken=${bad.length}  docOverflow=${docOv}px`)
  for (const r of bad) for (const c of r.collide) console.log(`    !! ${c}`)
  if (bad.length || docOv > 0) failures++
  await ctx.close()
}

await browser.close()
console.log(failures ? `\nFAIL — ${failures} width(s) with overlapping account rows` : '\nOK — no account row overlaps at any width')
process.exit(failures ? 1 : 0)
