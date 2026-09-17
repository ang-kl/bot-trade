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
