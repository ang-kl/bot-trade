// UI control inventory — DERIVED from HEAD, not remembered.
//
//   node scripts/ui-control-inventory.mjs            # rewrite the generated block
//   node scripts/ui-control-inventory.mjs --check    # exit 1 if the doc is stale
//
// Every '/actions/…' literal in src/ (outside tests) is one row: where it is
// called from, the nearest label, the route, what the agent does with the
// written value, and where the site reads the effective value back. The
// three judgement columns are mechanical:
//
//   Backend reads   the state keys the route handler writes (setState(db,'k'))
//                   each marked ✓ when some other agent code reads 'k', ✗ when
//                   nothing does; or `executes` when the handler acts (broker
//                   call / table write / process control) instead of storing.
//   UI reads back   the GET /state route(s) src/ fetches whose handler reads
//                   that key; else `reload` when the call site re-reads its
//                   page data within a few lines; else `none`.
//   Class           WIRED    route exists, every key read or executes, read-back present
//                   HALF     route exists but a key is unread or nothing reads back
//                   DECORATIVE  no such route
//
// src/lib/ui-control-inventory.test.js re-parses the generated table and
// re-checks the routes and keys against agent/, so the doc cannot drift
// from the code without a red test (CLAUDE.md failure mode #3: a guard
// whose trigger is out of reach of what it guards).
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = new URL('../', import.meta.url).pathname
const DOC = join(ROOT, 'docs/ui-control-inventory.md')
const CHECK = process.argv.includes('--check')

// node_modules is skipped during the recursion, not filtered afterwards: a
// worktree set-up that symlinks agent/node_modules can leave a self-link
// agent/node_modules/node_modules -> agent/node_modules, and descending into
// it loops until stat throws ELOOP.
export const walk = (dir, out = []) => {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules') continue
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(jsx?|mjs)$/.test(f)) out.push(p)
  }
  return out
}
// One-pass comment stripper: strings and template literals are matched FIRST
// so a `/*` or `//` inside them (URLs, glob text, "/state/*") cannot open a
// comment; comments are blanked to spaces so line numbers survive.
export const strip = s => s.replace(/("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*)/g,
  m => (m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m))

const DELEGATE_RE = /\b((?:set|save|apply|write|record|store|toggle|arm|disarm|request|migrate|reset|clear|seal|resolve|backfill|copy|revoke|refresh|reconcile|sweep|import|update|register|unregister|archive|unarchive|pin|unpin|open|close|cancel|place|move|enable|disable|run|start|stop|mark|bump|schedule|queue|kill|flag|unflag|switch)[A-Z]\w*)\(db\b/g

export function collect({ srcDirs = [join(ROOT, 'src')] } = {}) {
  const srcFiles = srcDirs.flatMap(d => walk(d)).filter(f => !/\.test\.jsx?$/.test(f)).sort()
  const agentFiles = walk(join(ROOT, 'agent')).filter(f => !/\.test\.js$/.test(f) && !f.includes('node_modules'))
  const agentText = Object.fromEntries(agentFiles.map(f => [f, strip(readFileSync(f, 'utf8'))]))
  const routeFiles = ['agent/routes/actions.js', 'agent/routes/state.js'].map(f => join(ROOT, f))

  // Route handlers, by (method, path) → { file, body }
  const handlers = {}
  for (const rf of routeFiles) {
    const text = agentText[rf]
    const re = /router\.(get|post)\('([^']+)'/g
    let m
    const marks = []
    while ((m = re.exec(text))) marks.push({ method: m[1], path: m[2], at: m.index })
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].at : text.length
      handlers[`${mk.method} ${rf.endsWith('state.js') ? '/state' : '/actions'}${mk.path}`] = { file: relative(ROOT, rf), body: text.slice(mk.at, end) }
    })
  }
  const keyReadElsewhere = (key, routeFile) => {
    const re = new RegExp(`(getState\\(db, '${key}'|'${key}'\\)|"${key}"|acct:\\$\\{[^}]*\\}:${key})`)
    return agentFiles.some(f => {
      if (f.endsWith(routeFile)) return agentText[f].replace(new RegExp(`setState\\(db, '${key}'`, 'g'), '').split('\n').some(l => re.test(l) && !/setState\(/.test(l))
      return re.test(agentText[f])
    })
  }
  const stateRoutesReadInSrc = new Set()
  const srcText = {}
  for (const f of srcFiles) {
    srcText[f] = strip(readFileSync(f, 'utf8'))
    for (const m of srcText[f].replace(/\$\{[^`]*?\}/g, '\u0000').matchAll(/['`]\/state\/([A-Za-z0-9_\-/:.]+)/g)) stateRoutesReadInSrc.add('/state/' + m[1].replace(/[?].*$/, ''))
  }
  const stateRouteFor = key => Object.entries(handlers)
    .filter(([k, h]) => k.startsWith('get /state') && new RegExp(`'${key}'`).test(h.body))
    .map(([k]) => k.slice(4))
    .filter(r => stateRoutesReadInSrc.has(r) || stateRoutesReadInSrc.has(r.replace(/:\w+/g, ':p')))

  const rows = []
  for (const f of srcFiles) {
    const lines = srcText[f].split('\n')
    const raw = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/['`](\/actions\/[A-Za-z0-9_\-/:$.{}()]+)['`]/g)) {
        const literal = m[1]
        const route = literal.replace(/\$\{[^}]*\}/g, ':p')
        const label = findLabel(raw, i)
        // Read-back evidence at the call site, three shapes:
        //   consumed  `const r = await agentPost(…)` / `.then(…)` — the route's
        //             reply (the stored/effective value) is what the UI renders
        //   reload    a page re-read (`load()`, `onDone()`, …) within the same
        //             handler, or through a wrapper (`run(…)`, `toggle(…)`,
        //             `save(…)`) whose body re-reads — resolved transitively
        const ctx = raw.slice(i, i + 30).join('\n')
        // A bare list entry (`'/actions/chart',` in READ_ONLY_POSTS) is not a control.
        if (/^\s*['`]\/actions\/[^'`]+['`],?\s*$/.test(line)) continue
        const consumed = /(const|let|var)\s+\w+\s*=\s*await\s+(agentPost|post)\(|\.then\(/.test(raw.slice(i, i + 8).join(' '))
        const near = raw.slice(Math.max(0, i - 20), i + 1).join(' ')
        const wrapper = /\b(act|run|toggle|save|apply|write|setFlag|call|send|post|submit|commit|persist)\(\s*/.exec(near)?.[1]
        const callOffset = lines.slice(0, i).join('\n').length
        const reloadsVia = (name, depth = 0, before = callOffset) => {
          if (!name || depth > 3) return false
          // The NEAREST definition above the call — Tune.jsx has several
          // components with their own `run` / `toggle`.
          const defs = [...srcText[f].matchAll(new RegExp(`(?:const|function)\\s+${name}\\b[\\s\\S]{0,900}`, 'g'))].filter(m2 => m2.index < before)
          const def = defs.length ? defs[defs.length - 1][0] : null
          if (!def) return false
          if (/\b(load\w*|reload\w*|onDone|onChanged|refresh\w*|onClose)\s*(?:\?\.)?\(/.test(def)) return true
          const inner = [...def.matchAll(/\b(act|run|toggle|save|apply|write|setFlag|call|send|post|submit|commit|persist)\(/g)].map(m2 => m2[1]).filter(n => n !== name)
          return inner.some(n => reloadsVia(n, depth + 1, before))
        }
        const reload = /\b(load\w*|reload\w*|refresh\w*|onDone|onChanged|onSaved|onChange|onClose|refetch\w*|mutate|setTimeout\(load)\s*(?:\?\.)?\(/.test(ctx) || reloadsVia(wrapper)
        rows.push({ file: relative(ROOT, f), line: i + 1, label, literal, route, reload, consumed })
      }
    })
  }
  const routeKey = r => {
    for (const method of ['post', 'get']) {
      if (handlers[`${method} ${r}`]) return `${method} ${r}`
      const cand = Object.keys(handlers).filter(k => k.startsWith(`${method} /actions`)).find(k => {
        const pat = '^' + k.slice(method.length + 1).replace(/:[^/]+/g, '[^/]+') + '$'
        return new RegExp(pat).test(r)
      })
      if (cand) return cand
    }
    return null
  }
  for (const r of rows) {
    if (r.cls === 'DECORATIVE') continue
    const hk = routeKey(r.route)
    if (!hk) { r.backend = 'no such route'; r.readback = 'none'; r.cls = 'DECORATIVE'; continue }
    const h = handlers[hk]
    r.handler = hk.replace(/^(post|get) /, '')
    r.method = hk.split(' ')[0].toUpperCase()
    const keys = [...new Set([...h.body.matchAll(/setState\(db, '([^']+)'/g)].map(x => x[1]))]
    const dyn = /setState\(db, (?!')/.test(h.body)
    const executes = /\b(exec[A-Z]\w*|closePosition|cancelOrder|placeOrder|amend\w*|ws[A-Z]\w*|INSERT INTO|UPDATE \w+ SET|DELETE FROM|process\.exit|sendTelegram|writeFileSync|runFibScan|startBacktestJob|spawn|fetch\()\b/.test(h.body)
    // A handler that hands the write to a service (setPhaseFlag(db, …),
    // setAccountPhases(db, …), setStage(db, …)) stores through that service.
    const delegates = [...new Set([...h.body.matchAll(DELEGATE_RE)].map(x => x[1]))]
    // A POST that only answers (position-guard-get, ctrader-accounts, chart,
    // screener-search) is a READ over POST: its "write" is the reply the UI
    // renders. It has no state to read back.
    const readOnly = !keys.length && !dyn && !executes && !delegates.length && /res\.json\(/.test(h.body) && !/setState\(|\.run\(|INSERT|UPDATE|DELETE/.test(h.body)
    const keyMarks = keys.map(k => `\`${k}\` ${keyReadElsewhere(k, h.file) ? '✓' : '✗'}`)
    const unread = keys.filter(k => !keyReadElsewhere(k, h.file))
    const parts = [...keyMarks]
    if (dyn) parts.push('dynamic key(s) — per-account/overlay write')
    if (delegates.length) parts.push('via ' + delegates.map(d => `${d}(db, …)`).join(', '))
    if (executes) parts.push('executes')
    if (readOnly) parts.push('read over POST — the reply is the value')
    r.backend = parts.length ? parts.join(', ') : 'reads body only (no store, no action)'
    const rb = [...new Set(keys.flatMap(stateRouteFor))]
    // Background jobs: the POST only starts work; the page collects it by
    // polling a state route. Named here and verified (the poll must exist in src).
    const JOB_POLL = { '/actions/backtest': '/state/backtest-job', '/actions/cup-screener': '/state/job/' }
    const poll = JOB_POLL[r.route] && [...stateRoutesReadInSrc].some(x => x.startsWith(JOB_POLL[r.route])) ? `poll \`${JOB_POLL[r.route]}\` (background job)` : null
    // Heuristic read-backs are marked as such (checker M2): they come from
    // call-site shape, not from a state route whose handler names the key.
    r.readback = rb.length ? rb.map(x => `\`${x}\``).join(', ') : readOnly ? 'the reply itself (heuristic)' : r.consumed ? 'the reply — route returns the effective value (heuristic)' : poll ? poll + ' (heuristic)' : r.reload ? 'reload (heuristic)' : 'none'
    const stores = keys.length || dyn || executes || delegates.length || readOnly
    r.cls = (unread.length || !stores) ? 'HALF' : (r.readback === 'none' ? 'HALF' : 'WIRED')
  }
  // SECOND PASS (checker M2): controls with NO route literal — a <button>
  // with no handler, a permanently-disabled one, one whose title claims an
  // action nothing performs, or one whose only effect is local state the
  // file never reads. These were invisible to the literal scan, so
  // "DECORATIVE 0" could not go red on exactly the buttons PR-F removed.
  for (const f of srcFiles) {
    for (const d of decorativeControls(srcText[f], readFileSync(f, 'utf8'))) {
      rows.push({ file: relative(ROOT, f), line: d.line, label: d.label, literal: '(no route)', route: null, backend: d.reason, readback: '—', cls: d.allowed ? 'ALLOWED' : 'DECORATIVE' })
    }
  }
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const getExists = r => !!handlers[`get ${r}`] || Object.keys(handlers).some(k => k.startsWith('get /state') && (new RegExp('^' + k.slice(4).replace(/:[^/]+/g, '[^/]+') + '$').test(r) || (r.endsWith('/') && k.slice(4).startsWith(r))))
  const getReads = [...stateRoutesReadInSrc].sort().map(r => ({ route: r, exists: getExists(r) }))
  return { rows, getReads }
}

// Opening-tag scan for <button …>, <Button …> and role="button" elements.
// JSX attribute values may contain `>` inside braces, so the tag end is
// found brace-aware. Returns DECORATIVE findings with a reason each.
// Named exceptions, one reason each; a stale entry (tag no longer found) is
// reported by the test so the list cannot outlive what it excuses.
export const DECORATIVE_ALLOWLIST = [
  // Empty since PR-G (#900): the Tick-momentum arm in EngineStatusPanel.jsx is
  // now `disabled={...}` on the live readiness predicate, so no control is
  // permanently disabled by design. A stale entry here fails the test.
]

export function decorativeControls(stripped, raw) {
  const out = []
  const rawLines = raw.split('\n')
  const re = /<(button|Button)\b|<[A-Za-z][\w.]*\b[^>]*?role="button"/g
  let m
  while ((m = re.exec(stripped))) {
    let j = m.index, depth = 0
    while (j < stripped.length) {
      const ch = stripped[j]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
      j++
    }
    const tag = stripped.slice(m.index, j + 1)
    // Attribute-level view: brace expressions blanked, so a word inside a
    // template title (…'disabled in the registry') cannot read as an attribute.
    const attrs = tag.replace(/\{[\s\S]*?\}/g, m2 => ' '.repeat(m2.length))
    const line = stripped.slice(0, m.index).split('\n').length
    if (/\btype="submit"/.test(attrs)) continue
    if (/\{\.\.\.(rest|props|bt|btn|attrs)\b/.test(tag)) continue // a primitive forwarding its handler
    const label = findLabel(rawLines, line - 1)
    const title = /\btitle=\{?["'`]([^"'`]*)["'`]/.exec(tag)?.[1] || ''
    const allow = DECORATIVE_ALLOWLIST.find(a => a.tag.test(tag))
    if (/\sdisabled(?=[\s/>])/.test(attrs) && !/\sdisabled=\{/.test(tag)) {
      if (allow) { out.push({ line, label, reason: `permanently disabled — ALLOWED: ${allow.why}`, allowed: allow }); continue }
      out.push({ line, label, reason: 'permanently disabled — a bare `disabled` attribute, no condition' }); continue
    }
    if (/queue[sd]? for|\(mock\)|coming soon|not wired|placeholder/i.test(title)) { out.push({ line, label, reason: `title claims what nothing performs: "${title.slice(0, 60)}"` }); continue }
    const hasHandler = /\b(onClick|onPointerDown|onMouseDown|onKeyDown|onTouchStart|onSubmit|href|to|form)=/.test(attrs)
    if (!hasHandler) { out.push({ line, label, reason: 'no handler — no onClick / href / to on the element' }); continue }
    // onClick={() => setX(…)} whose X the file never reads: local state for show.
    const only = /onClick=\{\s*\(\)\s*=>\s*\{?\s*set([A-Z]\w*)\([^)]*\)\s*;?\s*\}?\s*\}/.exec(tag)
    if (only) {
      const name = only[1][0].toLowerCase() + only[1].slice(1)
      // Only a useState pair counts as local state — a setter imported from a
      // lib or a local async function is a real action.
      const isState = new RegExp(`const \\[${name}, set${only[1]}\\] = useState`).test(stripped)
      const uses = (stripped.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length
      // one for the useState destructure; anything more is a read
      if (isState && uses <= 1) out.push({ line, label, reason: `toggles local state \`${name}\` that nothing in the file reads` })
    }
  }
  return out
}

function findLabel(raw, i) {
  const after = raw.slice(i, i + 10).join(' ')
  const before = raw.slice(Math.max(0, i - 10), i + 1).join(' ')
  const pick = [
    /<Button[^>]*>\s*([^<{]{2,60}?)\s*<\/Button>/.exec(after),
    /<button[^>]*>\s*([^<{]{2,60}?)\s*<\/button>/.exec(after),
    /\b(?:label|title)=["']([^"']{2,60})["']/.exec(before),
    /\b(?:label|title)=\{?["'`]([^"'`]{2,60})["'`]/.exec(after),
    /(?:act|toggle|run)\(\s*'([^']{2,60})'/.exec(raw[i]),
    /confirm\(`([^`$]{4,70})/.exec(after),
    /flash\('([^']{4,60})/.exec(after),
    /\b(?:const|function)\s+(\w{3,40})\s*=?\s*(?:async)?\s*\(/.exec(before.split('\n').reverse().join('\n')),
  ].find(Boolean)
  return (pick ? pick[1] : '(inline)').replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
}

export function renderBlock({ rows, getReads }) {
  const sha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return 'unknown' } })()
  const out = []
  out.push(`Derived by \`node scripts/ui-control-inventory.mjs\` at HEAD \`${sha}\` · ${rows.length} action call sites · ${getReads.length} state routes read.`)
  out.push('')
  const counts = { WIRED: 0, HALF: 0, DECORATIVE: 0, ALLOWED: 0 }
  rows.forEach(r => { counts[r.cls]++ })
  out.push(`Classes: WIRED ${counts.WIRED} · HALF ${counts.HALF} · DECORATIVE ${counts.DECORATIVE} · ALLOWED ${counts.ALLOWED} (named exceptions in DECORATIVE_ALLOWLIST, one reason each).`)
  out.push('')
  out.push('| # | File:line | Label | Route | Backend reads | UI reads back | Class |')
  out.push('|---|---|---|---|---|---|---|')
  rows.forEach((r, i) => {
    out.push(`| ${i + 1} | \`${r.file}:${r.line}\` | ${r.label} | ${r.route ? '`' + r.literal + '`' : r.literal} | ${r.backend} | ${r.readback} | ${r.cls} |`)
  })
  out.push('')
  out.push('### State routes read by src/ (GET)')
  out.push('')
  out.push('| Route | Served by agent/routes/state.js |')
  out.push('|---|---|')
  getReads.forEach(g => out.push(`| \`${g.route}\` | ${g.exists ? 'yes' : '**NO — dead read**'} |`))
  return out.join('\n')
}

const START = '<!-- generated:start -->', END = '<!-- generated:end -->'
if (import.meta.url === `file://${process.argv[1]}`) {
  const doc = readFileSync(DOC, 'utf8')
  const a = doc.indexOf(START), b = doc.indexOf(END)
  if (a < 0 || b < 0) { console.error('markers missing in', DOC); process.exit(2) }
  const block = renderBlock(collect())
  const next = doc.slice(0, a + START.length) + '\n' + block + '\n' + doc.slice(b)
  if (CHECK) {
    const same = doc.replace(/HEAD `[0-9a-f]+`/, 'HEAD X') === next.replace(/HEAD `[0-9a-f]+`/, 'HEAD X')
    console.log(same ? 'inventory up to date' : 'inventory STALE — run node scripts/ui-control-inventory.mjs')
    process.exit(same ? 0 : 1)
  }
  writeFileSync(DOC, next)
  console.log('wrote', relative(ROOT, DOC))
}
