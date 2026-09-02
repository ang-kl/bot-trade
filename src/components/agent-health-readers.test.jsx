// The two readers added to the Agent Health popover on 02-09-2026:
// /state/log-watch (which rules fired in 24 h) and /state/protection-audit
// (the summary and the stale-account list). Both existed as routes with no
// reader. Rendered with react-dom/server; effects do not run, so the pure
// components are fed fixtures directly, and the poller's wiring is pinned
// in source with comments stripped.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { LogWatchLine, ProtectionAuditBlock, ControllerRows } from './AgentHealthPanel.jsx'

const NOW = Date.parse('2026-09-02T12:00:00Z')

describe('LogWatchLine', () => {
  it('lists the rules that fired in the last 24 h with their time, newest first', () => {
    const view = {
      installed: true,
      fired: {
        controller_stalled: '2026-09-02T09:15:00Z',
        earned_floor_admit: '2026-09-02T11:40:00Z',
        sidecar_restart: '2026-08-30T02:00:00Z', // older than 24 h — excluded
      },
    }
    const html = renderToStaticMarkup(<LogWatchLine view={view} error={null} nowMs={NOW} />)
    expect(html).toContain('log-watch fired in 24 h')
    expect(html).toContain('earned_floor_admit')
    expect(html).toContain('11:40 UTC')
    expect(html).toContain('controller_stalled')
    expect(html).toContain('09:15 UTC')
    expect(html).not.toContain('sidecar_restart')
    expect(html.indexOf('earned_floor_admit')).toBeLessThan(html.indexOf('controller_stalled'))
  })

  it('says "no log-watch alerts in 24 h" when nothing fired, in words', () => {
    const html = renderToStaticMarkup(<LogWatchLine view={{ installed: true, fired: {} }} error={null} nowMs={NOW} />)
    expect(html).toContain('no log-watch alerts in 24 h')
  })

  it('refuses to read silence as health when the watch is not installed', () => {
    const html = renderToStaticMarkup(<LogWatchLine view={{ installed: false, fired: {} }} error={null} nowMs={NOW} />)
    expect(html).toContain('no log-watch alerts in 24 h')
    expect(html).toContain('NOT installed')
  })

  it('renders NOT VERIFIABLE on a fetch error — never the quiet line', () => {
    const html = renderToStaticMarkup(<LogWatchLine view={null} error="HTTP 502" nowMs={NOW} />)
    expect(html).toContain('not verifiable')
    expect(html).toContain('HTTP 502')
    expect(html).not.toContain('no log-watch alerts')
  })

  it('renders nothing before the first read (no reading is not a failure yet)', () => {
    expect(renderToStaticMarkup(<LogWatchLine view={null} error={null} nowMs={NOW} />)).toBe('')
  })
})

describe('ProtectionAuditBlock', () => {
  const audit = (over = {}) => ({
    hasRun: true, ok: true, accounts: 3, accountsStale: 1,
    staleAccounts: [{ accountId: 8549, at: '2026-09-02T09:00:00Z', ageSec: 10800, checked: 2, naked: 0, targetless: 0, phantom: 0 }],
    at: '2026-09-02T11:58:00Z', ageSec: 120, stale: false,
    checked: 5, naked: 0, targetless: 1, phantom: 0,
    summary: '5 of 5 position(s) verified — 1 with no take profit (2 min ago) — 1 account(s) NOT audited for up to 180 min: 8549',
    ...over,
  })

  it('renders the summary and each stale account with its age', () => {
    const html = renderToStaticMarkup(<ProtectionAuditBlock audit={audit()} error={null} />)
    expect(html).toContain('Position protection audit')
    expect(html).toContain('3 accounts')
    expect(html).toContain('1 with no take profit')
    expect(html).toContain('account 8549')
    expect(html).toContain('not audited for 3h')
    expect(html).toContain('2 position(s) at last check')
  })

  it('omits the stale list when it is empty and does not invent one', () => {
    const html = renderToStaticMarkup(<ProtectionAuditBlock audit={audit({ staleAccounts: [], accountsStale: 0, summary: '5 position(s) checked, all protected (2 min ago)' })} error={null} />)
    expect(html).toContain('all protected')
    expect(html).not.toContain('<ul')
    expect(html).not.toContain('not audited for')
  })

  it('renders NOT VERIFIABLE on a fetch error — never "all protected"', () => {
    const html = renderToStaticMarkup(<ProtectionAuditBlock audit={null} error="ETIMEDOUT" />)
    expect(html).toContain('not verifiable')
    expect(html).toContain('ETIMEDOUT')
    expect(html).not.toContain('protected (')
  })

  it('renders under the protection_audit controller row when that row is listed', () => {
    const bad = [{ name: 'protection_audit', label: 'Position protection audit', status: 'failed', age_sec: 30, expected_sec: 60, last_error: 'HTTP 502' }]
    const prot = <ProtectionAuditBlock audit={audit()} error={null} />
    const html = renderToStaticMarkup(<ControllerRows bad={bad} under={{ protection_audit: prot }} />)
    // The block sits INSIDE the <li> for that controller.
    const li = html.slice(html.indexOf('<li'), html.indexOf('</li>'))
    expect(li).toContain('HTTP 502')
    expect(li).toContain('account 8549')
  })
})

describe('poller wiring (source pin, comments stripped)', () => {
  it('fetches both routes with their OWN error slot, and renders both readers in the popover', () => {
    const src = readFileSync(new URL('./AgentHealthPanel.jsx', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
    expect(src).toContain("agentGet('/state/log-watch').then(v => ({ v })).catch(e => ({ e: errText(e) }))")
    expect(src).toContain("agentGet('/state/protection-audit').then(v => ({ v })).catch(e => ({ e: errText(e) }))")
    expect(src).toMatch(/logWatchErr: lw\.e \?\? lw\.v\?\.error \?\? null/)
    expect(src).toMatch(/protAuditErr: pa\.e \?\? pa\.v\?\.error \?\? null/)
    // nowMs is the snapshot's clock, stamped in the poller — never Date.now()
    // in render.
    expect(src).toContain('<LogWatchLine view={logWatch} error={logWatchErr} nowMs={at} />')
    expect(src).toMatch(/at: Date\.now\(\),/)
    expect(src).toContain('<ProtectionAuditBlock audit={protAudit} error={protAuditErr} />')
    // The block is rendered in BOTH branches: under the row when listed,
    // standalone when not — never dropped.
    expect(src).toMatch(/under=\{listed \? \{ protection_audit: prot \} : \{\}\}/)
    expect(src).toMatch(/\{!listed && prot\}/)
  })
})
