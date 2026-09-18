// agent/lib/one-account-model.test.js — PR-B invariant (owner principle 1,
// 11-09-2026): THE BOT DOES NOT DISTINGUISH DEMO FROM LIVE. An account is only
// how much is inside it. Only ROUTING (which host, which credentials, which
// sidecar) may read `is_live`; every policy gate reads balance and evidence.
//
// This test scans every non-test source file under agent/, src/ and scripts/
// (comments stripped — CLAUDE.md failure mode #2: a test must not pass, or
// fail, on prose) for the tokens a demo/live gate is built from, as REGEXES
// (the checker's counterexamples: "live" double-quoted, `.toUpperCase() ===
// 'LIVE'`, `== "live"`, `isDemo`, `row.live_flag` — all caught). A file may
// carry a token only if the allowlist names it, with an EXACT count per
// pattern: one more use in an allowlisted file fails, one fewer fails too (a
// stale permission is a hole). The allowlist is the plan's §3.1 routing list
// (docs/owner-principles-plan-2026-09-11.md) plus display badges, one reason
// each. Two behavioural gates the owner has not yet decided on live in
// RESIDUAL_GATES, apart from routing, with their reason. cpp-exec/src has no
// demo/live branch at all and is asserted so. Set ONE_ACCOUNT_MODEL_ROOT to
// scan another checkout — how this was shown RED on the tree before PR-B
// (and on the checker's evade/ files) and GREEN after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ONE_ACCOUNT_MODEL_ROOT || fileURLToPath(new URL('../../', import.meta.url))

export const PATTERNS = Object.freeze({
  is_live: /\bis_live\b/g,
  isLive: /\bisLive\b/g,
  live_str: /["']live["']/gi,
  demo_str: /["']demo["']/gi,
  environment_cmp: /environment\s*[!=]==?/g,
  isDemo: /\bisDemo\b|\bis_demo\b/g,
  live_flag: /\blive_flag\b|\bdemo_flag\b/g,
  // retired names — the gates PR-B removed; zero everywhere but the alias map
  LIVE_APPROVED: /\bLIVE_APPROVED\b/g,
  DEMO_PASSED: /\bDEMO_PASSED\b/g,
  demoOnly: /\bdemoOnly\b/g,
  confirmLive: /\bconfirmLive\b/g,
  allowLive: /\ballowLive\b|\ballow_live\b|\bautopilot_allow_live\b/g,
  exemptHandPinnedDemo: /\bexemptHandPinnedDemo\b|\bheldPinnedDemo\b/g,
  tick_live_refused: /\btick_live_refused\b/g,
  live_scope: /\blive_scope\b/g,
  momentum_account_only: /\bmomentum_account_only\b/g,
  includeLive: /\bincludeLive\b/g,
  liveEntryRefusal: /\bliveEntryRefusal\b/g,
})

/**
 * file → { reason, max: { pattern: exactCount } }. A file not listed may
 * carry NONE of the tokens; a listed file may carry exactly the counts named.
 */
export const ALLOWLIST = Object.freeze({
  // ---- schema and env ------------------------------------------------------
  'agent/db.js': { reason: 'the accounts.is_live column and the entry_intents.environment enum comment — storage, not a gate', max: { is_live: 1, live_str: 1, demo_str: 1 } },
  'agent/lib/entry-contracts.js': { reason: 'ENVIRONMENTS enum on the tick contracts (which sidecar an intent belongs to)', max: { live_str: 1, demo_str: 1 } },
  'agent/lib/ctrader-env.js': { reason: 'the CTRADER_IS_LIVE env-var alias table', max: { isLive: 1 } },
  'agent/lib/tick-segment.js': { reason: 'the recorder segment header stamps which side it was recorded on (plan §3.1: main.cpp:192)', max: { live_str: 2, demo_str: 2, environment_cmp: 1 } },
  'agent/index.js': { reason: 'boots ctrader_is_live from the env and names the side in the roster-invariant boot line', max: { isLive: 2, live_str: 1, demo_str: 1 } },
  // ---- credentials / host choice (plan §3.1: ctrader-creds.js) -------------
  'agent/lib/ctrader-creds.js': { reason: 'host choice and same-side roster for the credentials (plan §3.1 routing)', max: { is_live: 1, isLive: 5 } },
  'agent/lib/exec-engine.js': { reason: 'sidecar roster per side (plan §3.1: exec-engine.js rosters)', max: { isLive: 4 } },
  'agent/loop.js': { reason: 'host choices and same-side fan-outs (plan §3.1: loop.js), side named in logs', max: { is_live: 4, isLive: 33, live_str: 5, demo_str: 5 } },
  'agent/routes/actions.js': { reason: 'account selection writes ctrader_is_live and picks the host; creds per account (the validation-fill refusal is in RESIDUAL_GATES)', max: { is_live: 2, isLive: 27, live_str: 1, demo_str: 1 } },
  'agent/routes/state.js': { reason: 'health/roster views echo the side; the manual-order override resolves the account\'s creds', max: { is_live: 6, isLive: 4, live_str: 1, demo_str: 1 } },
  'agent/services/heartbeat.js': { reason: 'sidecar side routing (plan §3.1: heartbeat.js)', max: { is_live: 7, isLive: 28, live_str: 4, demo_str: 4 } },
  'agent/services/account-equity.js': { reason: 'cross-side equity sweep (plan §3.1)', max: { is_live: 3, isLive: 4 } },
  'agent/services/equity-snapshot.js': { reason: 'the nightly equity pass routes each account to its own host (plan §3.1); the record carries no side (the SELECT and the host pick)', max: { is_live: 2 } },
  'agent/services/acting-layer.js': { reason: 'same-side roster filter (plan §3.1)', max: { is_live: 2, isLive: 3 } },
  'agent/services/naked-position-guard.js': { reason: 'same-side roster filter (plan §3.1)', max: { is_live: 1, isLive: 3 } },
  'agent/services/entry-drain.js': { reason: 'creds per account for the drain (plan §3.1)', max: { is_live: 3, isLive: 1 } },
  'agent/services/exec-guard-sync.js': { reason: 'the side\'s roster for the guard push (plan §3.1); the tick-entry roster reads mode + STABLE only', max: { is_live: 3, isLive: 10 } },
  'agent/services/tick-permits.js': { reason: 'the side the feeder pushes to (plan §3.1); no environment strike since PR-B', max: { is_live: 1, isLive: 4 } },
  'agent/services/tick-readiness.js': { reason: 'sideFor (plan §3.1: tick-readiness.js:27) and registry ordering; the validation_stage check reads no environment', max: { is_live: 2, live_str: 1, environment_cmp: 1 } },
  'agent/services/tick-validation.js': { reason: 'which side\'s shadow signals to read (plan §3.1: tick-validation.js side)', max: { live_str: 1, environment_cmp: 1 } },
  'agent/services/tick-shadow.js': { reason: 'the side\'s accounts for the shadow book (plan §3.1: tick-shadow.js)', max: { is_live: 1 } },
  'agent/services/entry-mode.js': { reason: 'environmentOf stamps the record\'s side (routing); LEGACY_STAGE_ALIASES reads the two retired stage names back as TRADED_PASSED', max: { is_live: 4, live_str: 1, demo_str: 2, LIVE_APPROVED: 1, DEMO_PASSED: 1 } },
  'agent/services/runtime-manifest.js': { reason: 'names the two sidecar URLs in the manifest', max: { live_str: 1, demo_str: 1 } },
  'agent/services/momentum-account.js': { reason: 'passes the account\'s side to autoTrade for its creds', max: { isLive: 2 } },
  'agent/services/momentum-book.js': { reason: 'passes the account\'s side to autoTrade for its creds', max: { isLive: 2 } },
  // ---- registry plumbing: the column is written and echoed, never gated on ---
  'agent/services/account-registry.js': { reason: 'writes/echoes the is_live column; selection routing', max: { is_live: 9, isLive: 13 } },
  'agent/services/account-capabilities.js': { reason: 'echoes isLive on capability/violation rows for display', max: { is_live: 5, isLive: 3 } },
  'agent/services/broker-roster.js': { reason: 'echoes isLive on the roster view', max: { is_live: 1, isLive: 1 } },
  'agent/services/account-chrome.js': { reason: 'echoes isLive for the chrome badge', max: { is_live: 3, isLive: 1 } },
  'agent/services/account-engineering.js': { reason: 'per-side sidecar roster and the isLive badge field', max: { is_live: 4, isLive: 3 } },
  'agent/services/account-phases.js': { reason: 'echoes isLive on the phase rows', max: { is_live: 3, isLive: 1 } },
  'agent/services/account-watchlist-summary.js': { reason: 'echoes isLive on the summary rows', max: { is_live: 1, isLive: 1 } },
  'agent/services/risk-matrix.js': { reason: 'echoes isLive on the matrix rows', max: { is_live: 3, isLive: 1 } },
  'agent/services/stage-matrix.js': { reason: 'echoes isLive on the matrix account rows; the pin exemption reads no environment', max: { is_live: 3, isLive: 1 } },
  'agent/services/goal-tracker.js': { reason: 'echoes isLive on the goal rows', max: { is_live: 1, isLive: 4 } },
  'agent/services/evidence-gate.js': { reason: 'the report labels each account\'s side', max: { is_live: 2 } },
  'agent/services/telegram-control.js': { reason: 'the /accounts listing names the side; the digest mode word is unrelated', max: { is_live: 3, live_str: 3, demo_str: 1 } },
  'agent/services/telegram-digest.js': { reason: "the digest's 'live' | 'hourly' mode — unrelated to accounts", max: { live_str: 5 } },
  'agent/services/strategy-autopilot.js': { reason: "a disarm reason word ('live' = disarmed from live trading evidence) — unrelated to accounts", max: { live_str: 1 } },
  'agent/services/cockpit-snapshot.js': { reason: "a data-freshness status word ('live' | 'stale') — unrelated to accounts", max: { live_str: 2 } },
  'agent/services/cockpit-environment.js': { reason: 'a data-freshness status word — unrelated to accounts', max: { live_str: 2 } },
  'agent/services/cockpit-bars.js': { reason: 'a data-freshness status word — unrelated to accounts', max: { live_str: 1 } },
  'agent/services/cockpit-correlation.js': { reason: 'a data-freshness status word — unrelated to accounts', max: { live_str: 1 } },
  'agent/services/cockpit-explain.js': { reason: 'reads a request body\'s `environment` object (the cockpit\'s market environment) — unrelated to accounts', max: { environment_cmp: 1 } },
  // ---- scripts/: operator tooling --------------------------------------------
  'scripts/connect-rows-audit.mjs': { reason: 'a fixture of registry rows for the Connect-page responsive audit (isLive drives the badge)', max: { isLive: 7 } },
  // ---- src/: DISPLAY badges and side labels only -----------------------------
  'src/components/AccountChrome.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 2 } },
  'src/components/AccountCompare.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 3, live_str: 2, demo_str: 2 } },
  'src/components/AccountEngineering.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 2, live_str: 1, demo_str: 1 } },
  'src/components/AccountHealth.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 2, live_str: 1, demo_str: 1 } },
  'src/components/AccountPhaseSwitches.jsx': { reason: 'LIVE/DEMO badge; the mode dropdown is enabled on every row since PR-B', max: { isLive: 5, live_str: 3, demo_str: 3 } },
  'src/components/AccountSwitcher.jsx': { reason: 'LIVE/DEMO badge and the isLive field the select route needs for the host; no typed-word prompt since PR-B', max: { isLive: 6, live_str: 3, demo_str: 3 } },
  'src/components/ActiveAccountHeader.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 2, live_str: 2, demo_str: 2 } },
  'src/components/EngineStatusPanel.jsx': { reason: 'LIVE/DEMO label on the engine row', max: { live_str: 2, demo_str: 1, environment_cmp: 1 } },
  'src/components/GoalTracker.jsx': { reason: 'LIVE badge', max: { isLive: 1 } },
  'src/components/PageAccountLine.jsx': { reason: 'LIVE/DEMO label', max: { isLive: 1, live_str: 1, demo_str: 1 } },
  'src/components/PerfMacroSections.jsx': { reason: 'Live/Demo label in the account filter', max: { is_live: 1, live_str: 1, demo_str: 1 } },
  'src/components/PositionChart.jsx': { reason: "a freshness word ('live' | 'stale') on the chart dot — unrelated to accounts", max: { live_str: 2 } },
  'src/components/RiskConfigCompare.jsx': { reason: 'LIVE/DEMO badge', max: { is_live: 2, live_str: 1, demo_str: 1 } },
  'src/components/RiskMatrix.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 1 } },
  'src/components/ViewAccountPicker.jsx': { reason: 'LIVE/DEMO label', max: { isLive: 1, live_str: 1, demo_str: 1 } },
  'src/components/WorkflowAudit.jsx': { reason: "a workflow node id ('live') — unrelated to accounts", max: { live_str: 1 } },
  'src/components/common/AccountScopeFab.jsx': { reason: 'the isLive field the select route needs for the host; the confirm is neutral since PR-B', max: { isLive: 2 } },
  'src/components/watchlist/WatchlistCompare.jsx': { reason: 'LIVE/DEMO badge and label; the copy confirm is on every destination since PR-B', max: { isLive: 4, live_str: 3, demo_str: 3 } },
  'src/lib/agent-health-view.js': { reason: 'LIVE label in the roster-invariant text', max: { isLive: 1 } },
  'src/lib/hourly-order.js': { reason: '`isLive` = the hour window that is still running — unrelated to accounts', max: { isLive: 1 } },
  'src/lib/perf-aggregate.js': { reason: 'counts live vs demo cards for the header line (display)', max: { isLive: 2 } },
  'src/lib/scope-fab.js': { reason: 'LIVE/DEMO label on the scope chip', max: { is_live: 2, isLive: 2, live_str: 1, demo_str: 1 } },
  'src/lib/scope-label.js': { reason: 'the Live/Demo word in accountLabel', max: { is_live: 1, isLive: 1, live_str: 1, demo_str: 1 } },
  'src/lib/selected-account.js': { reason: 'LIVE/DEMO word in the selection label', max: { isLive: 1, live_str: 1, demo_str: 1 } },
  'src/lib/use-active-account.js': { reason: 'maps the registry column onto the row shape', max: { is_live: 1, isLive: 1 } },
  'src/pages/Accounts.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 2, live_str: 1, demo_str: 1 } },
  'src/pages/Connect.jsx': { reason: 'LIVE/DEMO badge; the isLive field the select route needs; no typed-word prompt since PR-B', max: { isLive: 5, live_str: 2, demo_str: 2 } },
  'src/pages/Desk.jsx': { reason: 'LIVE/DEMO label on the broker session', max: { isLive: 2, demo_str: 1 } },
  'src/pages/Performance.jsx': { reason: 'Live/Demo labels in the account filters; `isLive` on the hourly row means the running window', max: { is_live: 5, isLive: 5, live_str: 4, demo_str: 4 } },
  'src/pages/Risk.jsx': { reason: 'LIVE/DEMO badge', max: { isLive: 1 } },
  'src/pages/Trade.jsx': { reason: 'LIVE/DEMO label on the broker session and in the validation-fill confirm text', max: { isLive: 3, demo_str: 2 } },
  'src/pages/Tune.jsx': { reason: 'LIVE/DEMO label on the account row', max: { isLive: 2, live_str: 1, demo_str: 1 } },
})

/**
 * BEHAVIOURAL gates that remain, listed apart from routing so nobody reads
 * them as plumbing. Each: the file, the exact source it is, and how many of
 * which tokens it accounts for. Owner decision pending (11-09-2026).
 */
export const RESIDUAL_GATES = Object.freeze([
  {
    file: 'agent/routes/actions.js',
    source: /if \(getState\(db, 'ctrader_is_live'\) === 'true'\) \{\s*return refuse\(400, 'live_account: validation fill refuses to run on a LIVE account'/,
    counts: { is_live: 1 },
    reason: 'POST /actions/validation-fill refuses its 0.01 test order on a live selection — guards a deliberate test order, not trading policy; owner decision pending 11-09-2026',
  },
  {
    file: 'agent/scripts/exec-parity.js',
    source: /creds\.host\?\.includes\('live'\)\) \{ console\.error\('\[parity\] refusing --order on a LIVE host'\)/,
    counts: { live_str: 1 },
    reason: 'the parity script refuses to fire its --order on a live host — guards a deliberate test order, not trading policy; owner decision pending 11-09-2026',
  },
])

const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const s = statSync(p)
    if (s.isDirectory()) { if (name !== 'node_modules') walk(p, out) } else if (/\.(js|jsx|mjs)$/.test(name) && !/\.(test|spec)\.(js|jsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

function countAll(src) {
  const counts = {}
  for (const [name, re] of Object.entries(PATTERNS)) {
    const n = (src.match(re) || []).length
    if (n) counts[name] = n
  }
  return counts
}

export function scanOneAccountModel(root = ROOT) {
  const files = [...walk(join(root, 'agent')), ...walk(join(root, 'src')), ...walk(join(root, 'scripts'))]
  const violations = []
  const stale = []
  const residualMissing = []
  const seen = new Set()
  const residualByFile = {}
  for (const g of RESIDUAL_GATES) residualByFile[g.file] = g
  for (const f of files) {
    const rel = relative(root, f).split('\\').join('/')
    seen.add(rel)
    const raw = readFileSync(f, 'utf8')
    const src = strip(raw)
    const counts = countAll(src)
    const allow = ALLOWLIST[rel]?.max || {}
    const residual = residualByFile[rel]
    if (residual) {
      if (!residual.source.test(src)) residualMissing.push(`${rel}: the residual gate is no longer there — remove it from RESIDUAL_GATES`)
    }
    const expected = { ...allow }
    for (const [p, n] of Object.entries(residual?.counts || {})) expected[p] = (expected[p] || 0) + n
    for (const [p, n] of Object.entries(counts)) {
      const max = expected[p] || 0
      if (n > max) {
        const one = new RegExp(PATTERNS[p].source, PATTERNS[p].flags.replace('g', ''))
        const lines = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => one.test(l))
        violations.push(`${rel} [${p}] ${n} found, ${max} allowed: ${lines.slice(0, 3).map(([i, l]) => `:${i} ${l.trim().slice(0, 90)}`).join(' | ')}`)
      }
    }
    for (const [p, max] of Object.entries(expected)) {
      const n = counts[p] || 0
      if (n < max) stale.push(`${rel} [${p}] allows ${max}, only ${n} present — lower the count`)
    }
  }
  for (const rel of Object.keys(ALLOWLIST)) if (!seen.has(rel)) stale.push(`${rel}: allowlisted file does not exist`)
  for (const g of RESIDUAL_GATES) if (!seen.has(g.file)) residualMissing.push(`${g.file}: residual file does not exist`)
  return { files: files.length, violations, stale, residualMissing }
}

test('one account model: no demo/live token outside the routing + display allowlist, at exactly the counts allowed (owner principle 1)', () => {
  const { files, violations } = scanOneAccountModel()
  assert.ok(files > 0, 'the walk found the tree')
  assert.deepEqual(violations, [], `${violations.length} demo/live token(s) outside the allowlist:\n  ${violations.join('\n  ')}`)
})

test('one account model: every allowlist count is exact and every residual gate is still where it says (a stale permission is a hole)', () => {
  const { stale, residualMissing } = scanOneAccountModel()
  assert.deepEqual(stale, [], `stale allowlist entries:\n  ${stale.join('\n  ')}`)
  assert.deepEqual(residualMissing, [], residualMissing.join('\n  '))
})

test('one account model: the retired gates are ABSENT by name — RED if any one returns', () => {
  const read = (rel) => { const p = join(ROOT, rel); return existsSync(p) ? strip(readFileSync(p, 'utf8')) : '' }
  const cases = [
    ['agent/services/entry-mode.js', /tick_live_refused/, 'TICK_MOMENTUM refused on the environment'],
    ['agent/services/tick-permits.js', /is_live\) === 1 \|\| st\.environment === 'live'/, 'the live strike from the tick roster'],
    ['agent/services/exec-guard-sync.js', /environment !== 'live'/, 'the live strike from the guard roster'],
    ['agent/lib/entry-contracts.js', /LIVE_APPROVED|DEMO_PASSED/, 'the environment-tiered stages'],
    ['agent/services/tick-readiness.js', /LIVE_APPROVED|DEMO_PASSED|environment === 'live' \? st\.validationStage/, 'the two-tier validation_stage check'],
    ['agent/services/tick-validation.js', /not_a_demo_account|LIVE_APPROVED|DEMO_PASSED|approval_word_required/, 'the demo-only stage and the typed approval'],
    ['agent/services/earned-floor.js', /demoOnly|live_scope|is_live\) === 0/, 'the demo-only floor and the demo-only prior'],
    ['agent/services/stage-matrix.js', /exemptHandPinnedDemo|!isLive\[scope\]/, 'the demo-only pin exemption'],
    ['agent/services/adaptive-breaker.js', /exemptHandPinnedDemo|heldPinnedDemo/, 'the breaker\'s demo-only hold'],
    ['agent/services/edge-watchdog.js', /exemptHandPinnedDemo|heldPinnedDemo/, 'the watchdog\'s demo-only hold'],
    ['agent/services/config-controller.js', /includeLive/, 'the controller\'s live exclusion'],
    ['agent/loop.js', /includeLive|heldPinnedDemo/, 'the loop\'s live exclusion / demo-hold log'],
    ['agent/services/strategy-autopilot.js', /allowLive|autopilot_allow_live/, 'the autopilot\'s live opt-in'],
    ['agent/index.js', /autopilot_allow_live/, 'the boot force-set of the live opt-in'],
    ['agent/routes/actions.js', /allowLive|autopilot_allow_live|confirmLive|demoOnly/, 'the live opt-in, the live-entry word and the demo-only dial on the routes'],
    ['agent/routes/state.js', /allow_live|includeLive/, 'the live opt-in / exclusion on the state views'],
    ['agent/services/account-capabilities.js', /liveEntryRefusal|confirmLive/, 'the live-entry carve-out'],
    ['agent/services/account-registry.js', /liveEntryRefusal|confirmLive/, 'the live-entry carve-out'],
    ['agent/services/managed-exit.js', /demoOnly/, 'the managed-exit demo fence'],
    ['agent/services/momentum-account.js', /exclusive/, 'the one-account momentum switch'],
    ['agent/services/risk.js', /momentum_account_only|\.exclusive/, 'the one-account momentum veto'],
    ['src/components/AccountPhaseSwitches.jsx', /disabled=\{a\.isLive|confirmLive/, 'the greyed live dropdown'],
    ['src/components/AccountSwitcher.jsx', /window\.prompt|Type LIVE|confirmLive/, 'the typed LIVE prompt'],
    ['src/pages/Connect.jsx', /window\.prompt|Type LIVE/, 'the typed LIVE prompt'],
    ['src/components/common/AccountScopeFab.jsx', /window\.prompt|Type LIVE/, 'the typed LIVE prompt'],
    ['src/components/watchlist/WatchlistCompare.jsx', /dst\?\.isLive \|\|/, 'the live-only copy confirm'],
    ['src/pages/Tune.jsx', /allow_live|autopilotAllowLive/, 'the live opt-in copy'],
  ]
  const back = cases.filter(([rel, re]) => re.test(read(rel))).map(([rel, , what]) => `${rel}: ${what}`)
  assert.deepEqual(back, [], `retired gate(s) present again:\n  ${back.join('\n  ')}`)
})

test('one account model: the hardcoded-account configs declare every account', () => {
  const cfg = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))
  assert.equal(cfg('agent/config/momentum-account.json').accountId, '_all')
  assert.equal('exclusive' in cfg('agent/config/momentum-account.json'), false)
  assert.deepEqual(cfg('agent/config/tick-observation.json').accounts, { _all: 'SHADOW' })
  const pins = cfg('agent/config/strategy-pins.json')
  // Wave 1 of the first-principles audit (19-09-2026): arming follows
  // evidence. `_all` carries only what earned it; `_off` is the shadow set;
  // `_trial` is the ONE documented exception to "no ids" — one account per
  // system on trial until its dated checkpoint (07-09 P5 reconciled with P9).
  assert.ok(Array.isArray(pins._all) && pins._all.length >= 1 && pins._all.length <= 3)
  assert.ok(Array.isArray(pins._off) && pins._off.length >= 10, 'the shadow set is named')
  assert.deepEqual(Object.keys(pins).filter(k => /^\d+$/.test(k)), [], 'no account ids as keys in the pins file')
  assert.deepEqual(Object.keys(pins._trial), ['tsmom_long'])
  assert.equal(pins._trial.tsmom_long.length, 1, 'one trial account')
  assert.match(pins._trial_note, /checkpoint/)
  assert.equal('demo' in cfg('agent/config/tick-validation.json'), false)
  assert.ok('traded' in cfg('agent/config/tick-validation.json'))
})

test('one account model: the C++ sidecar has no demo/live branch — the only string literal is the recorder header stamp, and nothing compares an environment', () => {
  const dir = join(ROOT, 'cpp-exec', 'src')
  if (!existsSync(dir)) return assert.fail('cpp-exec/src not found under the scanned root')
  const stripC = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1')
  const hits = []
  for (const name of readdirSync(dir)) {
    if (!/\.(cpp|hpp|h)$/.test(name) || /^test/.test(name)) continue
    const src = stripC(readFileSync(join(dir, name), 'utf8'))
    src.split('\n').forEach((line, i) => {
      if (/"(demo|live)"/i.test(line) || /\b(environment|isLive|is_live|isDemo)\b\s*[!=]==?/.test(line)) hits.push(`${name}:${i + 1} ${line.trim().slice(0, 100)}`)
    })
  }
  assert.equal(hits.length, 1, `cpp-exec/src carries a demo/live token beyond the header stamp:\n  ${hits.join('\n  ')}`)
  assert.match(hits[0], /^main\.cpp:\d+ rc\.environment = feedHost\.find\("demo"\)/, 'the one literal is the recorder header stamp (plan §3.1: main.cpp:192)')
})
