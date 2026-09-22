// agent/services/sidecar-pins.test.js — source pins on the sidecar that no
// C++ unit test can exercise (a signal's default disposition is process
// state; the TLS write path needs a real peer). Comments are stripped before
// matching (CLAUDE.md recurring failure mode #2).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const src = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'))

test('the sidecar ignores SIGPIPE at startup — a peer hang-up under a write is EPIPE, never a silent exit (11-09-2026 demo restart loop)', () => {
  const main = src('../../cpp-exec/src/main.cpp')
  assert.match(main, /signal\(SIGPIPE, SIG_IGN\)/, 'main.cpp must ignore SIGPIPE process-wide')
  assert.match(main, /static void installCrashHandler\(\) \{[\s\S]{0,600}signal\(SIGPIPE, SIG_IGN\)/, 'installed with the crash handlers, before any thread starts')
  assert.match(main, /installCrashHandler\(\);/, 'and the installer is called')
  // the plain-TCP transport already refuses the signal per write
  assert.match(src('../../cpp-exec/src/ws_client.cpp'), /::send\(fd, [^;]*MSG_NOSIGNAL\)/)
})

test('POST /connect rebuilds the spot feed only when an input the feed reads has changed (17-09-2026 self-inflicted recorder gaps)', () => {
  // MEASURED on the demo sidecar, two restarts inside three minutes:
  //   10:01:25  credentials updated via /connect … → spot feed (re)started
  //   10:04:05  credentials updated via /connect … → spot feed (re)started
  //                                                → subscribed to 53 symbol(s)
  // The teardown was unconditional, and with a tick recorder configured that
  // is every push. A fresh SpotFeed starts at generation 1 and the recorder
  // writes a GAP on any generation change, so a credential rotation cost a
  // hole in the tick record — the record TM-40 gates tick entries on.
  //
  // No C++ unit test can pin this: the decision lives in an HTTP route
  // lambda over main()'s locals, reachable only by running the server.
  const main = src('../../cpp-exec/src/main.cpp')
  assert.match(main, /bool feedInputsChanged = !spotFeed/,
    'the restart is gated on a comparison, not taken unconditionally')
  for (const input of ['useHost != liveFeedHost', '!feedAccountStillAuthorized',
    'vpoSymbolIds != liveFeedVpoSymbolIds', 'trailTickEnabled != liveFeedTrailEnabled',
    'depthFeedEnabled != liveFeedDepthEnabled']) {
    assert.ok(main.includes(input), `a change in ${input} must still force a restart`)
  }

  // PR-AD: the PRIMARY account is NOT restart-worthy, and this is the pin that
  // says so. exec-engine.js sends `accountId: creds.accountId`, which varies by
  // call site, so comparing it rebuilt the feed on most pushes and charged the
  // recorder a gap each time (measured 17-09 13:37, three restarts in 1.2s).
  // What is restart-worthy is the feed's account losing authorization.
  assert.doesNotMatch(main, /accountId != liveFeedAccountId/,
    'the primary account must not be compared directly — that is the churn PR-AD removed')
  assert.match(main, /bool feedAccountStillAuthorized = \(liveFeedAccountId == accountId\);/,
    'authorization starts at the primary')
  assert.match(main, /for \(long long id : extraIds\) \{[\s\S]{0,120}feedAccountStillAuthorized = true;/,
    'and the union of accountIds counts too, or a non-primary feed restarts forever')
  assert.match(main, /live->updateCredentials\(clientId, clientSecret, accessToken\)/,
    'and the unchanged case refreshes credentials in place instead')
  assert.match(main, /liveFeedHost = useHost;/,
    'the remembered inputs are restamped when a feed IS built, or the next compare is against stale state')

  // CODEX P1: HttpServer runs every request on its own detached thread
  // (http_server.cpp:54), so two /connect calls race. If the comparison and
  // the unchanged path run outside connectMtx, request A can borrow
  // spotFeed.get(), release vpoMtx, and call updateCredentials() on an object
  // request B has stopped, joined and destroyed. connectMtx must be taken
  // BEFORE the comparison, and exactly once (it is not recursive).
  const lockAt = main.indexOf('std::lock_guard<std::mutex> restart(connectMtx)')
  const compareAt = main.indexOf('bool feedInputsChanged = !spotFeed')
  assert.ok(lockAt > 0 && compareAt > 0)
  assert.ok(lockAt < compareAt,
    'connectMtx is held before the live feed is inspected — otherwise a concurrent /connect is a use-after-free')
  assert.equal((main.match(/std::lock_guard<std::mutex> restart\(connectMtx\)/g) || []).length, 1,
    'and taken exactly once: connectMtx is not recursive, so a second acquire deadlocks /connect')

  // CODEX P2: the feed must be built for the SAME host the engine was given.
  // `host.empty() ? "live…" : host` sent a demo-pinned sidecar's feed to LIVE
  // whenever /connect omitted host, and caching useHost would have frozen it.
  assert.match(main, /^\s*useHost, clientId, clientSecret, accessToken, accountId,$/m,
    'the SpotFeed is constructed with useHost')
  assert.doesNotMatch(main, /host\.empty\(\) \? "live\.ctraderapi\.com" : host, clientId, clientSecret, accessToken, accountId,/,
    'and never with the raw/defaulted host, which split-brained the feed from the engine')

  // The feed must actually read the refreshed values, under the lock — a
  // setter nothing consults is the "repair that nothing calls" shape.
  const feed = src('../../cpp-exec/src/spot_feed.cpp')
  assert.match(feed, /std::lock_guard<std::mutex> lk\(credsMtx_\);[\s\S]{0,200}useClientId = clientId_/,
    'connectAuthSubscribe snapshots the credentials under credsMtx_')
  assert.match(feed, /appAuth\.set\("clientId", useClientId\)/)
  assert.match(feed, /acctAuth\.set\("accessToken", useAccessToken\)/)
  assert.doesNotMatch(feed, /acctAuth\.set\("accessToken", accessToken_\)/,
    'and never the unlocked member, which would both race and ignore a rotation')
})

test('cpp-verify never holds its session map across a broker round trip — /health must answer while a verify is in flight', () => {
  // WHY A SOURCE PIN. Same shape as the /connect pins above: the decision
  // lives in HTTP route lambdas over main()'s locals, so no C++ unit test
  // reaches it without running the server against a broker.
  //
  // THE COST IF IT REGRESSES. A /verify walks pages with a 30 s ceiling each
  // and a /connect authorizes N accounts at 20 s each. Held under the map's
  // mutex, either one blocks GET /health — Railway's probe times out and
  // restarts a service that is working perfectly. The guard out of reach of
  // what it guards, one layer up.
  const main = src('../../cpp-verify/src/main.cpp')

  assert.match(main, /std::map<std::string, std::shared_ptr<verify::VerifySession>> g_sessions/,
    'sessions are SHARED: /verify keeps its session alive while a concurrent /connect replaces the map entry')
  assert.doesNotMatch(main, /std::map<std::string, std::unique_ptr<verify::VerifySession>> g_sessions/,
    'a unique_ptr here is a use-after-free whenever the two overlap')

  // /verify: copy the pointer under the lock, fetch outside it.
  assert.match(main, /session = it->second;\s*\}\s*[\s\S]{0,200}verify::DealFetch fetch = session->deals\(/,
    'the deal fetch happens after the lock_guard scope has closed')

  // /connect: authorize outside the lock, install the ready session under it.
  assert.match(main, /for \(long long id : want\) \{[\s\S]{0,400}slot->connect\(id\)[\s\S]{0,400}std::lock_guard<std::mutex> lk\(g_mtx\);\s*g_sessions\[host\] = slot;/,
    'accounts are authorized before the map is locked, not while holding it')
})

test('cpp-verify links no order-writing code — the read-only guarantee is structural', () => {
  // The service exists so that nothing certifies its own work. That claim
  // rests entirely on what the binary contains: if the execution engine is
  // linked in, "read-only" becomes a promise about routing that any later
  // change can quietly break. CI greps the built binary for the symbols; this
  // pins the link line that produces it.
  // The Makefile's comments are `#`, which the JS/C++ stripper above leaves
  // alone — and this test caught itself on that: the comment explaining that
  // engine.cpp is absent contains the word `engine.cpp`. A source assertion
  // matching its own prose is CLAUDE.md failure mode #2, so strip properly.
  const mkStrip = (t) => t.replace(/^\s*#.*$/gm, '')
  const mk = mkStrip(readFileSync(new URL('../../cpp-verify/Makefile', import.meta.url), 'utf8'))
  // PR-AN: the vendored transport lives in src/ and is picked up by the
  // wildcard, so there is no SHARED line to read any more. WHAT IS VENDORED is
  // pinned exactly by the byte-identity test below; what must never appear is
  // still asserted here.
  assert.doesNotMatch(mk, /\.\.\/cpp-exec/,
    'nothing reaches outside this directory — that is what forced the root build context')
  assert.doesNotMatch(mk, /engine\.cpp|order_guard\.cpp|trail_engine\.cpp|vpo_dispatcher\.cpp/,
    'and never the execution engine or anything that can place, amend or close')

  // Reconcile (2124) reads open SL/TP directly for independent protection
  // checks. It is read-only; the forbidden write-message list stays intact.
  const sess = src('../../cpp-verify/src/verify_session.cpp')
  const reqTypes = [...sess.matchAll(/constexpr int k\w+Req = (\d+);/g)].map((m) => m[1]).sort()
  assert.deepEqual(reqTypes, ['2100', '2102', '2121', '2124', '2133'],
    'only app auth, account auth, trader, reconcile and deal list are allowed')

  // WHY 2121 WAS ADDED, since this list is the read-only guarantee and
  // widening it quietly would be the whole point of the guard defeated.
  //
  // ProtoOATraderReq fetches the trader record — balance, leverage and
  // `moneyDigits`. PR-AW needs the last of those: cTrader reports money as an
  // integer scaled by 10^moneyDigits, and comparing that raw against the
  // keeper's dollars disputed every record by exactly 100x (measured
  // 18-09-2026: ten verdicts, ten disputes, zero verified — a guard that
  // could not return agreement).
  //
  // It had to come from the BROKER. Taking the scale from the keeper would
  // have the verifier check a record against a number that record supplied;
  // hardcoding 100 would repeat the assumption that caused the bug. 2121 is a
  // read: it places, amends and cancels nothing.
  //
  // AND THE GUARD GETS TEETH IT DID NOT HAVE. An allowlist says what is
  // there; it cannot say what a future edit must never add. These are the
  // write messages by number, so a paste of any of them fails here even if
  // someone also updates the list above.
  for (const [type, what] of [['2106', 'NewOrder'], ['2108', 'CancelOrder'], ['2110', 'AmendOrder'],
                              ['2111', 'AmendPositionSLTP'], ['2112', 'ClosePosition']]) {
    assert.doesNotMatch(sess, new RegExp(`=\\s*${type}\\s*;`),
      `${what}Req (${type}) must never appear in a read-only verifier`)
  }
})

// ---------------------------------------------------------------------------
// PR-AM: cpp-verify declares its own build, because the repo root's config
// belongs to a different service.
//
// MEASURED 17-09-2026 19:23 UTC, and this is the whole reason the file exists.
// cpp-verify's build context must be the REPO ROOT — its Makefile borrows
// ws_client.cpp and http_server.cpp from cpp-exec (pinned above), so a context
// of /cpp-verify cannot resolve them and every build failed on
// `"/cpp-exec/src": not found`.
//
// Moving the root to `/` fixed the build and broke the deploy in a worse way:
// the repo root carries `railway.json` and `Dockerfile` belonging to the NODE
// service, so Railway built the trading agent and ran it on the verifier's
// service, where it crash-looped on `AGENT_SECRET env var is required`. A
// green build of the wrong application — CLAUDE.md failure mode #3, one layer
// down: the stage reported healthy because what it measured was never the
// thing in question.
//
// So cpp-verify carries its own config. Root is now `/cpp-verify` (PR-AN): the
// transport is vendored, so nothing reaches outside this directory and the root
// config cannot be inherited. The builder and the Dockerfile are named here.
// ---------------------------------------------------------------------------
test('cpp-verify pins its own builder and Dockerfile, not the repo root service\'s', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../cpp-verify/railway.json', import.meta.url), 'utf8'))
  assert.equal(cfg.build?.builder, 'DOCKERFILE',
    'RAILPACK auto-detection is what picked up the root Node image; the builder is stated')
  assert.equal(cfg.build?.dockerfilePath, 'Dockerfile',
    'relative to the /cpp-verify root directory — see the PR-AN test below for why')
  assert.equal(cfg.deploy?.healthcheckPath, '/health',
    'a deploy that never serves must fail the healthcheck rather than sit there')

  // PR-AM asserted here that the root config's dockerfilePath DIFFERED from
  // this one, on the reasoning that agreement meant the root was being
  // inherited. PR-AN makes that check meaningless rather than wrong: both now
  // read 'Dockerfile' because each resolves against its OWN root directory,
  // and the same basename no longer implies the same file. What actually has
  // to hold is that this service's build context is its own directory, which
  // is asserted directly in the PR-AN test below instead of inferred from a
  // string comparison.
  const root = JSON.parse(readFileSync(new URL('../../railway.json', import.meta.url), 'utf8'))
  assert.equal(root.build?.builder, 'DOCKERFILE',
    'the Node service still depends on the root config: its panel carries no builder')
})

// ---------------------------------------------------------------------------
// PR-AN: the vendored transport must stay BYTE-IDENTICAL to cpp-exec's.
//
// WHY THE COPY EXISTS AT ALL, since duplication was deliberately avoided when
// cpp-verify was built. Compiling cpp-exec's files in place forced the build
// context to be the repository ROOT — and the root carries `railway.json` and
// `Dockerfile` belonging to the NODE service, which Railway reads in
// preference to any panel setting on a fresh deploy. Measured 17-09-2026: the
// service named cpp-verify built the trading agent (crash-looping on
// AGENT_SECRET at 23:03 UTC), and then, with the root pointed elsewhere, built
// and RAN cpp-exec itself at 23:15 — an order-placing engine live on the
// read-only service. Sharing the source cost the read-only guarantee, so the
// source is vendored and the context is this directory.
//
// The cost of a copy is drift, and a drifted transport is the kind of defect
// nobody reads: the verifier would keep answering, just against a different
// framing or socket implementation than the executor uses. So drift is a RED
// TEST that names the file, not a code-review hope.
// ---------------------------------------------------------------------------
test('PR-AN: cpp-verify\'s vendored transport is byte-identical to cpp-exec\'s', () => {
  // The complete vendored set. json.hpp and the test's fake_broker.hpp are
  // here too: both were cpp-exec dependencies that the first cut of this
  // change missed, and with the build context narrowed to this directory they
  // would have failed the Docker build rather than degrading quietly.
  const files = [
    ['ws_client.cpp', 'src'], ['ws_client.hpp', 'src'],
    ['http_server.cpp', 'src'], ['http_server.hpp', 'src'],
    ['json.hpp', 'src'],
    // Wave 5 (audit §K item 17): http_server.cpp routes its lines through the
    // shared stream header, so the header is vendored with it.
    ['log.hpp', 'src'],
    ['fake_broker.hpp', 'src/tests'],
  ]
  for (const [f, dir] of files) {
    const from = dir === 'src/tests' ? 'src/tests' : 'src'
    const origin = readFileSync(new URL(`../../cpp-exec/${from}/${f}`, import.meta.url))
    const vendored = readFileSync(new URL(`../../cpp-verify/${dir}/${f}`, import.meta.url))
    assert.ok(origin.equals(vendored),
      `cpp-verify/${dir}/${f} has DRIFTED from cpp-exec/${from}/${f} — re-copy it, or if the ` +
      `divergence is intentional, say so here and explain why the verifier needs a different transport`)
  }
})

// PR-AS: "READ-ONLY" MUST NAME ITS SCOPE, because the service now writes.
//
// Observed on the live boot, 18-09-2026:
//
//   [verify] cpp-verify starting on :8080 — read-only (app auth, account
//            auth, deal list); sessions are per host
//   [verify] journal UNWRITABLE at /data/verdicts — mkdir: Permission denied
//
// Two consecutive lines, one claiming read-only and the next reporting a
// failed write. Both were true — the guarantee is about the BROKER, enforced
// by the link line — but nothing said so, and a reader is entitled to
// conclude one of them is lying. An unscoped guarantee is the same defect as
// an unscoped measurement: it invites a wrong reading and cannot be checked.
test('PR-AS: the read-only claim names its scope and what it writes', () => {
  const src = readFileSync(new URL('../../cpp-verify/src/main.cpp', import.meta.url), 'utf8')
  const code = src.replace(/^\s*\/\/.*$/gm, '')     // strip comments: no passing on prose

  assert.match(code, /READ-ONLY AT THE BROKER/,
    'the boot line must scope the claim to the broker, not assert it bare')
  assert.match(code, /never places, amends or cancels/,
    'and say what read-only actually forbids')
  assert.match(code, /It writes its verdict journal and, when configured, watchdog state/,
    'and name what it DOES write, in the same breath')

  assert.match(code, /o\.set\("readOnlyScope"/, '/health carries the scope, not just a bare boolean')
  assert.match(code, /o\.set\("writes"/, 'and enumerates what it writes, so the payload cannot drift')
})

// PR-AS: THE MISSING `USER appuser` LINE IS DELIBERATE AND LOAD-BEARING.
//
// It reads like an oversight — a service that used to drop privileges and now
// does not — so without this pin the obvious "fix" is to add it back, which
// would restore `mkdir: Permission denied` on the journal and lose every
// verdict silently. Measured 18-09-2026 03:2x UTC on the first deploy with the
// volume attached.
//
// The process still runs as uid 10001. The drop moved into the entrypoint,
// AFTER the chown that only root can perform on a Railway-mounted volume.
test('PR-AS: cpp-verify drops to uid 10001 in the entrypoint, not via USER', () => {
  const df = readFileSync(new URL('../../cpp-verify/Dockerfile', import.meta.url), 'utf8')
  const code = df.replace(/^\s*#.*$/gm, '')
  assert.doesNotMatch(code, /^\s*USER\s+appuser/m,
    'a USER line here runs the entrypoint as appuser, which cannot chown the root-owned mount')
  assert.match(code, /ENTRYPOINT\s*\[\s*"\/usr\/local\/bin\/entrypoint\.sh"/,
    'the entrypoint must be the one that prepares the volume')

  const sh = readFileSync(new URL('../../cpp-verify/entrypoint.sh', import.meta.url), 'utf8')
  const shCode = sh.replace(/^\s*#.*$/gm, '')
  assert.match(shCode, /chown -R 10001:10001/, 'the journal dir is handed to appuser')
  assert.match(shCode, /setpriv --reuid=10001 --regid=10001/,
    'and root is DROPPED before exec — a read-only verifier running as root trades one failure for a worse one')
  assert.match(shCode, /exec setpriv/, 'exec, so signals reach the service rather than a shell')
  assert.doesNotMatch(shCode, /exit 1/,
    'a journal that cannot be prepared must not become an outage: it reports unwritable and serves')
})

test('PR-AN: cpp-verify builds from its own directory, so it cannot inherit the root service\'s config', () => {
  const cfg = JSON.parse(readFileSync(new URL('../../cpp-verify/railway.json', import.meta.url), 'utf8'))
  // Relative to the /cpp-verify root directory now — NOT 'cpp-verify/Dockerfile',
  // which only resolves when the context is the repository root, which is the
  // arrangement that let the Node service's config win.
  assert.equal(cfg.build?.dockerfilePath, 'Dockerfile')
  const df = readFileSync(new URL('../../cpp-verify/Dockerfile', import.meta.url), 'utf8')
    .replace(/^\s*#.*$/gm, '')
  assert.doesNotMatch(df, /COPY\s+cpp-exec\//,
    'a COPY reaching outside this directory forces the root context back')
  assert.doesNotMatch(df, /COPY\s+cpp-verify\b/, 'same')
  assert.match(df, /COPY\s+src\s+\.\/src/, 'the sources come from this directory')
})
