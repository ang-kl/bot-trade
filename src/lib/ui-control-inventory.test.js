// PR-F (owner principle 6): docs/ui-control-inventory.md is derived from
// HEAD by scripts/ui-control-inventory.mjs. This test re-parses the generated
// table and re-checks it against agent/ and src/ independently of the
// generator's own logic, so the doc cannot drift from the code without a
// red test — and so the generator's judgement columns are themselves held
// to the source (CLAUDE.md failure mode #3: a guard whose trigger is out of
// reach of what it guards).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { strip, collect, decorativeControls, DECORATIVE_ALLOWLIST } from '../../scripts/ui-control-inventory.mjs'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const ROOT = new URL('../../', import.meta.url).pathname
const doc = readFileSync(join(ROOT, 'docs/ui-control-inventory.md'), 'utf8')
const gen = doc.slice(doc.indexOf('<!-- generated:start -->'), doc.indexOf('<!-- generated:end -->'))

const rows = gen.split('\n').filter(l => /^\| \d+ \|/.test(l)).map(l => {
  const c = l.split('|').map(s => s.trim())
  return { n: +c[1], site: c[2].replace(/`/g, ''), label: c[3], route: c[4].replace(/`/g, ''), backend: c[5], readback: c[6], cls: c[7] }
})
const getRows = gen.split('\n').filter(l => /^\| `\/state\//.test(l)).map(l => {
  const c = l.split('|').map(s => s.trim())
  return { route: c[1].replace(/`/g, ''), served: c[2] }
})

const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) { if (!/node_modules/.test(f)) walk(p, out) }
    else if (/\.(jsx?|mjs)$/.test(f)) out.push(p)
  }
  return out
}
const agentFiles = walk(join(ROOT, 'agent')).filter(f => !/\.test\.js$/.test(f))
const agentSrc = agentFiles.map(f => [f, strip(readFileSync(f, 'utf8'))])
const actions = strip(readFileSync(join(ROOT, 'agent/routes/actions.js'), 'utf8'))
const state = strip(readFileSync(join(ROOT, 'agent/routes/state.js'), 'utf8'))
const routeDeclared = (text, method, path) => {
  if (text.includes(`router.${method}('${path}'`)) return true
  // :param routes — compare segment by segment against every declared path.
  const declared = [...text.matchAll(new RegExp(`router\\.${method}\\('([^']+)'`, 'g'))].map(m => m[1])
  return declared.some(d => new RegExp('^' + d.replace(/:[^/]+/g, '[^/]+') + '$').test(path))
}

describe('docs/ui-control-inventory.md — generated block', () => {
  it('has rows and the generator agrees it is current', () => {
    expect(rows.length).toBeGreaterThan(50)
    expect(gen).toMatch(/Derived by `node scripts\/ui-control-inventory\.mjs` at HEAD `[0-9a-f]+`/)
  })

  it('every listed route is declared in agent/routes/actions.js (POST, or the /actions GET catalogue)', () => {
    const missing = rows.filter(r => r.route.startsWith('/actions')).filter(r => {
      const path = r.route.replace(/^\/actions/, '').replace(/\$\{[^}]*\}/g, ':p')
      return !(routeDeclared(actions, 'post', path) || routeDeclared(actions, 'get', path))
    })
    expect(missing.map(r => `${r.site} ${r.route}`)).toEqual([])
  })

  it('every listed state key is read somewhere in agent/ other than the route that writes it (comment-stripped)', () => {
    const unread = []
    for (const r of rows) {
      for (const m of r.backend.matchAll(/`([a-z0-9_:]+)` ([✓✗])/g)) {
        const key = m[1]
        // A reader is any agent line naming the key — quoted, or as the
        // suffix of a per-account template (`acct:${id}:key`) — that is not
        // itself a setState of that key.
        const readerRe = new RegExp(`('${key}'|"${key}"|:${key}\`)`)
        const readers = agentSrc.filter(([, t]) => t.split('\n').some(l => readerRe.test(l) && !/setState\(db, '/.test(l)))
        if (!readers.length || m[2] === '✗') unread.push(`${r.route} ${key} (${m[2]})`)
      }
    }
    expect(unread).toEqual([])
  })

  it('every "/actions/…" literal in src/ (outside tests and the READ_ONLY_POSTS list) has a row at its file:line', () => {
    const srcFiles = walk(join(ROOT, 'src')).filter(f => !/\.test\.jsx?$/.test(f))
    const wanted = []
    for (const f of srcFiles) {
      const rel = f.slice(ROOT.length)
      strip(readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (/^\s*['`]\/actions\/[^'`]+['`],?\s*$/.test(line)) return
        for (const m of line.matchAll(/['`](\/actions\/[A-Za-z0-9_\-/:$.{}()]+)['`]/g)) wanted.push(`${rel}:${i + 1} ${m[1]}`)
      })
    }
    const routeRows = rows.filter(r => r.route.startsWith('/actions'))
    const have = new Set(routeRows.map(r => `${r.site} ${r.route}`))
    expect(wanted.filter(w => !have.has(w))).toEqual([])
    // and the doc lists nothing that is not in src/ any more
    const wantedSet = new Set(wanted)
    expect(routeRows.map(r => `${r.site} ${r.route}`).filter(x => !wantedSet.has(x))).toEqual([])
  })

  it('after PR-F there is no HALF and no DECORATIVE control; every ALLOWED row is a live, named exception', () => {
    expect(rows.filter(r => r.cls !== 'WIRED' && r.cls !== 'ALLOWED').map(r => `${r.site} ${r.route} ${r.cls}`)).toEqual([])
    expect(gen).toMatch(/Classes: WIRED \d+ · HALF 0 · DECORATIVE 0 · ALLOWED \d+/)
    const allowed = rows.filter(r => r.cls === 'ALLOWED')
    expect(allowed.length).toBe(DECORATIVE_ALLOWLIST.length)
    for (const a of DECORATIVE_ALLOWLIST) {
      const src = strip(readFileSync(join(ROOT, a.file), 'utf8'))
      expect(a.tag.test(src), `stale allowlist entry: ${a.file}`).toBe(true)
      expect(allowed.some(r => r.site.startsWith(a.file + ':')), `allowlist entry not in the table: ${a.file}`).toBe(true)
    }
  })

  // Checker M2: "DECORATIVE 0" must be falsifiable on controls with NO route
  // literal. A probe page with a handler-less Close titled "queues for next
  // open", a bare-disabled Modify and a local-state-only toggle is scanned
  // through the same collect(); each must come back DECORATIVE.
  it('a probe page with three decorative controls and no route literal turns DECORATIVE non-zero', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ui-inv-probe-'))
    try {
      writeFileSync(join(dir, 'Probe.jsx'), `
import { useState } from 'react'
export default function Probe() {
  const [armed, setArmed] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setArmed(a => !a)}>Arm</button>
      <button title="queues for next open" style={{ color: 'red' }}>Close</button>
      <button type="button" disabled className="w-full">Modify</button>
      <button type="button" onClick={() => window.alert('x')}>Real</button>
    </div>
  )
}
`)
      const { rows: probe } = collect({ srcDirs: [dir] })
      const dec = probe.filter(r => r.cls === 'DECORATIVE')
      expect(dec.map(r => r.backend)).toEqual([
        'toggles local state `armed` that nothing in the file reads',
        'title claims what nothing performs: "queues for next open"',
        'permanently disabled — a bare `disabled` attribute, no condition',
      ])
      expect(probe.filter(r => r.cls === 'WIRED')).toEqual([])
      // and the doc's own generator would have printed DECORATIVE 3 for it
      expect(dec).toHaveLength(3)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('decorativeControls ignores real controls: a submit button, a conditional disabled, a template title mentioning "disabled", a lib setter', () => {
    const ok = `
const [x, setX] = useState(1)
<Button type="submit">Set</Button>
<button type="button" disabled={busy} onClick={go}>Go</button>
<button type="button" onClick={() => onAcct?.(id)} title={\`Show \${n}'s matrix\${t.enabled ? '' : ', disabled in the registry'}\`}>Show</button>
<button type="button" onClick={() => setPollPaused(true)}>Pause</button>
<button type="button" onClick={() => setX(2)}>Two {x}</button>
`
    expect(decorativeControls(strip(ok), ok)).toEqual([])
  })

  it('heuristic read-backs are labelled as such', () => {
    const heuristic = rows.filter(r => /reload|the reply|poll/.test(r.readback))
    expect(heuristic.length).toBeGreaterThan(0)
    for (const r of heuristic) expect(r.readback, r.site).toMatch(/\(heuristic\)/)
  })

  it('every read-back that names a /state route points at a route state.js declares, and every listed GET read is served', () => {
    const named = rows.flatMap(r => [...r.readback.matchAll(/`(\/state\/[^`]+)`/g)].map(m => m[1]))
    const bad = named.filter(p => !routeDeclared(state, 'get', p.replace(/^\/state/, '').replace(/\/$/, '')) && !p.endsWith('/'))
    expect(bad).toEqual([])
    expect(getRows.length).toBeGreaterThan(30)
    expect(getRows.filter(g => g.served !== 'yes').map(g => g.route)).toEqual([])
  })
})

describe('the PR-F controls named in the doc exist in the code (the doc cannot outlive the fix)', () => {
  it('names each replacement file and the file exists', () => {
    for (const f of ['src/cockpit/CockpitActions.jsx', 'src/cockpit/cockpit-session.js', 'src/lib/position-guard-form.js', 'src/lib/arm-benchmarks.js', 'src/pages/Reasons.jsx', 'agent/loop-confluence-filters.test.js']) {
      expect(doc, f).toContain(f)
      expect(() => statSync(join(ROOT, f))).not.toThrow()
    }
  })
})
