// PR-F (owner principle 6): the cockpit header's Manage / Close were dead
// buttons and the closed-market pill animated a hard-coded "opens in 4h 23m".
// These pin the replacements — a static render of the header actions (no
// hooks, so react-dom/server suffices), the session label from the real
// next-open timestamp, and a comment-stripped source pin on TradeCockpit
// itself so the dead buttons and the fabricated countdown cannot come back.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import CockpitActions from './CockpitActions.jsx'
import { sessionLabel, opensIn, sendClose, CLOSED_MARKET_CLOSE_TITLE, NO_ACCOUNT_CLOSE_TITLE } from './cockpit-session.js'

const fs = n => n
const position = { sym: 'EURUSD', side: 'LONG', lots: 0.5 }

describe('CockpitActions', () => {
  it('renders nothing when no position is bound — the demo cockpit has nothing to manage or close', () => {
    expect(renderToStaticMarkup(<CockpitActions fs={fs} position={null} tradeId={null} />)).toBe('')
    expect(renderToStaticMarkup(<CockpitActions fs={fs} position={position} tradeId={null} />)).toBe('')
  })
  it('open market: both buttons are live, Close names symbol / side / volume', () => {
    const html = renderToStaticMarkup(<CockpitActions fs={fs} position={position} tradeId="123" onManage={() => {}} onClosePosition={() => {}} />)
    expect(html).toMatch(/<button type="button"[^>]*>Manage<\/button>/)
    expect(html).toMatch(/<button type="button"[^>]*title="Close EURUSD LONG 0\.5 lots at market"[^>]*>Close<\/button>/)
    expect(html).not.toMatch(/ disabled=""/)
    expect(html).toMatch(/aria-disabled="false"/)
    expect(html).not.toMatch(/queues for next open/)
  })
  it('closed market: Close is disabled with the honest broker reason, Manage stays available', () => {
    const html = renderToStaticMarkup(<CockpitActions fs={fs} position={position} tradeId="123" marketClosed onManage={() => {}} onClosePosition={() => {}} />)
    expect(html).toContain(`title="${CLOSED_MARKET_CLOSE_TITLE}"`)
    expect(html).toMatch(/<button type="button"[^>]*disabled=""[^>]*aria-disabled="true"[^>]*>Close<\/button>/)
    expect(html).toMatch(/<button type="button" title="Manage EURUSD[^"]*"[^>]*>Manage<\/button>/)
    expect(html).not.toMatch(/queues/)
  })
})

describe('sessionLabel / opensIn — next-open from the symbol-hours source only', () => {
  const now = new Date('2026-09-11T10:00:00Z')
  // Checker M3: two different offsets, neither the reference's 4h 23m, so a
  // hard-coded duration cannot satisfy both.
  it('a served nextOpenAt yields the device-time label and the real remaining time (1h 05m, 27h 00m)', () => {
    const at1 = new Date('2026-09-11T11:05:00Z').toISOString()
    expect(opensIn(at1, now)).toBe('1h 5m')
    expect(sessionLabel({ position: { sym: 'EURUSD' }, state: 'closed', nextOpenAt: at1, now })).toMatch(/^MARKET CLOSED · opens \(\d\d \d\d:\d\d\) · in 1h 5m$/)
    const at2 = new Date('2026-09-12T13:00:00Z').toISOString()
    expect(opensIn(at2, now)).toBe('27h 0m')
    expect(sessionLabel({ position: { sym: 'EURUSD' }, state: 'closed', nextOpenAt: at2, now })).toMatch(/· in 27h 0m$/)
    expect(opensIn(new Date('2026-09-11T14:23:00Z').toISOString(), now)).toBe('4h 23m')
  })
  it('a PAST nextOpenAt is plain "MARKET CLOSED" — no negative or stale countdown', () => {
    expect(sessionLabel({ position: { sym: 'EURUSD' }, state: 'closed', nextOpenAt: '2026-09-11T09:00:00Z', now })).toBe('MARKET CLOSED')
  })
  it('no nextOpenAt → "MARKET CLOSED", no countdown, no digits', () => {
    expect(opensIn(null, now)).toBeNull()
    expect(sessionLabel({ position: { sym: 'EURUSD' }, state: 'closed', nextOpenAt: null, now })).toBe('MARKET CLOSED')
    expect(sessionLabel({ position: { sym: 'EURUSD', exchange: 'nyse' }, state: 'halted', nextOpenAt: null, now })).toBe('NYSE HALTED')
  })
  it('a past or unparseable timestamp is not counted down', () => {
    expect(opensIn('2026-09-11T09:00:00Z', now)).toBeNull()
    expect(opensIn('garbage', now)).toBeNull()
  })
  it('the demo route names the reference exchange and never a countdown', () => {
    expect(sessionLabel({ position: null, state: 'closed', now })).toBe('HKEX CLOSED')
  })
})

describe('TradeCockpit source pin (comment-stripped)', () => {
  const src = readFileSync(new URL('./TradeCockpit.jsx', import.meta.url), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
  it('renders the wired actions, not bare buttons; no fabricated countdown; no mock fleet affordance', () => {
    expect(src).toMatch(/<CockpitActions[\s\S]*onManage=\{[\s\S]*onClosePosition=\{closePosition\}/)
    expect(src).toMatch(/post: agentPost/)
    expect(src).toMatch(/<PositionManager p=\{managed\}/)
    expect(src).not.toMatch(/4 \* 60 \+ 23/)
    expect(src).not.toMatch(/queues for next open/)
    expect(src).not.toMatch(/\(mock\)/)
    expect(src).not.toMatch(/tc-fleet-chip" role="button"/)
    // Every closed-market label goes through sessionLabel (the symbol-hours source).
    expect(src).toMatch(/sessionLabel\(\{ position, state: sess, nextOpenAt \}\)/)
    // The demo flight overlays are gated on the demo chart.
    expect(src.match(/chart\?\.status === 'synthetic'/g)?.length).toBeGreaterThanOrEqual(3)
    expect(src).toMatch(/v\.chart\?\.status === 'empty' && /)
  })
})

// Checker M4: wiring pinned by INVOKING the handlers, not by reading text.
// CockpitActions has no hooks, so calling it as a function yields the real
// element tree; the Close <button>'s props are the real onClick/disabled.
function closeButtonOf(props) {
  const tree = CockpitActions({ fs, ...props })
  if (!tree) return null
  const kids = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
  return kids.find(k => k && k.props && String(k.props.children).startsWith('Clos')) || null
}
describe('CockpitActions handlers fire (invoked, not grepped)', () => {
  it('Close calls onClosePosition exactly once per click on an open market', () => {
    let n = 0
    const btn = closeButtonOf({ position, tradeId: '123', onManage: () => {}, onClosePosition: () => { n += 1 } })
    expect(btn.props.disabled).toBe(false)
    btn.props.onClick(); btn.props.onClick()
    expect(n).toBe(2)
    expect(btn.props.onClick).not.toBeUndefined()
  })
  it('is inert (disabled) while busy, on a closed market, and when the cockpit names a refusal — the handler is still the wired one', () => {
    let n = 0
    const fire = () => { n += 1 }
    for (const extra of [{ busy: true }, { marketClosed: true }, { closeReason: NO_ACCOUNT_CLOSE_TITLE }]) {
      const btn = closeButtonOf({ position, tradeId: '123', onManage: () => {}, onClosePosition: fire, ...extra })
      expect(btn.props.disabled).toBe(true)
      expect(btn.props['aria-disabled']).toBe(true)
    }
    expect(n).toBe(0)
    const html = renderToStaticMarkup(<CockpitActions fs={fs} position={position} tradeId="1" closeReason={NO_ACCOUNT_CLOSE_TITLE} onManage={() => {}} onClosePosition={fire} />)
    expect(html).toContain(`title="${NO_ACCOUNT_CLOSE_TITLE}"`)
  })
  it('Manage calls onManage', () => {
    let n = 0
    const tree = CockpitActions({ fs, position, tradeId: '1', onManage: () => { n += 1 }, onClosePosition: () => {} })
    const manage = tree.props.children.find(k => k?.props?.children === 'Manage')
    manage.props.onClick()
    expect(n).toBe(1)
  })
})

describe('sendClose — the cockpit close as a pure decision + post (checker M1/M4)', () => {
  const managed = { positionId: '123', symbol: 'EURUSD', side: 'BUY', lots: 0.5 }
  const stub = () => { const calls = []; return { calls, post: async (path, body) => { calls.push([path, body]); return { ok: true } } } }
  it('posts /actions/position-close with { positionId, account } after a confirm naming symbol / side / volume', async () => {
    const { calls, post } = stub()
    const asked = []
    const r = await sendClose({ managed, accountId: '46979908', confirm: m => { asked.push(m); return true }, post })
    expect(r.sent).toBe(true)
    expect(calls).toEqual([['/actions/position-close', { positionId: '123', account: '46979908' }]])
    expect(asked[0]).toMatch(/^Close EURUSD BUY 0\.5 lots at market\?/)
    expect(asked[0]).toMatch(/account …9908/)
  })
  it('refuses — and posts nothing — without an account, on a closed market, while in flight, when not confirmed, without a position', async () => {
    const { calls, post } = stub()
    const yes = () => true
    expect((await sendClose({ managed, accountId: null, confirm: yes, post })).reason).toBe(NO_ACCOUNT_CLOSE_TITLE)
    expect((await sendClose({ managed, accountId: '1', marketClosed: true, confirm: yes, post })).reason).toBe(CLOSED_MARKET_CLOSE_TITLE)
    expect((await sendClose({ managed, accountId: '1', closing: true, confirm: yes, post })).reason).toMatch(/in flight/)
    expect((await sendClose({ managed, accountId: '1', confirm: () => false, post })).reason).toBe('not confirmed')
    expect((await sendClose({ managed: null, accountId: '1', confirm: yes, post })).reason).toBe('no position bound')
    expect(calls).toEqual([])
  })
  it('TradeCockpit wires sendClose with agentPost as the post, the deep-link account, and refuses Close without it (source pin)', () => {
    const src = readFileSync(new URL('./TradeCockpit.jsx', import.meta.url), 'utf8')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    expect(src).toMatch(/sendClose\(\{ managed, accountId: closeAccountId, marketClosed, closing: false, confirm: [^,]+, post: agentPost \}\)/)
    expect(src).toMatch(/const closeAccountId = urlIdentity\(\)\.accountId/)
    expect(src).toMatch(/closeReason = managed && !closeAccountId \? NO_ACCOUNT_CLOSE_TITLE : null/)
    expect(src).toMatch(/closeReason=\{closeReason\}/)
    // a second click while closing must not post: the guard is the first line
    expect(src).toMatch(/if \(closing\) return\s*\n\s*setClosing\(true\)/)
    expect(src).not.toMatch(/agentPost\('\/actions\/position-close'/)
  })
})
