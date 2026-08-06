// cpp-exec/src/tests/test_host_pin.cpp
//
// ONE SIDECAR, ONE BROKER HOST — enforced at the boundary.
//
// An ExecEngine holds one host_ for its whole life: setCredentials REPLACES it
// and tears the session down. So a live and a demo account cannot share a
// process. On 2026-08-05 they did not: all four demo accounts sat `enabled = 1`
// in the registry and absent from the single sidecar's authorised roster, every
// dispatch was short-circuited at Node's connectivity gate, and ZERO trades
// opened in twelve hours against 87 the day before.
//
// Node now routes by host and every roster consumer is side-aware. But routing
// is a property of the CALLER being correct, and the failure that matters is a
// caller being wrong: a mis-set EXEC_URL_DEMO, a hand-rolled curl, a call site
// nobody has written yet. Without a pin such a request does not fail — it
// SUCCEEDS. setCredentials tears down the session every other account is
// trading on and reconnects to the wrong broker, silently.
//
// These pin the rule that stops it. They need no socket, which is the point:
// the same reasoning as test_auth_error_policy.cpp, where an incident came from
// two handlers disagreeing about a rule that existed only as scattered ifs.
#include <cassert>
#include <cstdio>
#include <string>

#include "../engine.hpp"

static void unpinnedAllowsEverything() {
  // TODAY'S DEPLOYMENT. CTRADER_HOST unset = unpinned, and nothing changes.
  // This is the migration property the whole two-sidecar plan is built on, and
  // it is the one that must not break.
  assert(connectHostAllowed("", "live.ctraderapi.com"));
  assert(connectHostAllowed("", "demo.ctraderapi.com"));
  assert(connectHostAllowed("", ""));
  assert(connectHostAllowed("", "anything.example"));

  // And an unpinned sidecar keeps its historical default for an absent host,
  // rather than inventing a new one.
  assert(effectiveConnectHost("", "") == "live.ctraderapi.com");
  assert(effectiveConnectHost("", "demo.ctraderapi.com") == "demo.ctraderapi.com");
}

static void pinnedRefusesTheOtherSide() {
  assert(connectHostAllowed("demo.ctraderapi.com", "demo.ctraderapi.com"));
  assert(!connectHostAllowed("demo.ctraderapi.com", "live.ctraderapi.com"));
  assert(connectHostAllowed("live.ctraderapi.com", "live.ctraderapi.com"));
  assert(!connectHostAllowed("live.ctraderapi.com", "demo.ctraderapi.com"));

  // Refusal is reported as an empty host, so a caller that ignores the boolean
  // still cannot connect somewhere it was refused.
  assert(effectiveConnectHost("demo.ctraderapi.com", "live.ctraderapi.com").empty());
}

static void absentHostTakesThePinNotTheDefault() {
  // THE DANGEROUS CASE, and the reason an empty request is ALLOWED rather than
  // refused. main.cpp's historical behaviour was
  // `host.empty() ? "live.ctraderapi.com" : host`. On a sidecar pinned to demo,
  // a /connect that simply omits `host` would then have connected to the LIVE
  // broker — the exact cross-wiring the pin exists to prevent, arriving through
  // the pin's own front door.
  assert(connectHostAllowed("demo.ctraderapi.com", ""));
  assert(effectiveConnectHost("demo.ctraderapi.com", "") == "demo.ctraderapi.com");
  assert(effectiveConnectHost("live.ctraderapi.com", "") == "live.ctraderapi.com");
}

static void comparisonIsForgivingAboutFormatting() {
  // A host differing only in case or stray whitespace is the SAME host. A pin
  // that refused it would be a pin that fails closed on an operator typo, and
  // an operator whose correct config is rejected reaches for the override.
  assert(connectHostAllowed("demo.ctraderapi.com", "DEMO.CtraderAPI.com"));
  assert(connectHostAllowed("demo.ctraderapi.com", "  demo.ctraderapi.com  "));
  assert(connectHostAllowed("  Demo.CtraderAPI.com ", "demo.ctraderapi.com"));
  assert(effectiveConnectHost("  Demo.CtraderAPI.com ", "") == "demo.ctraderapi.com");

  // But it is not forgiving about being a DIFFERENT host.
  assert(!connectHostAllowed("demo.ctraderapi.com", "demo.ctraderapi.com.evil.example"));
  assert(!connectHostAllowed("demo.ctraderapi.com", "ctraderapi.com"));
}

static void pinnedProcessNormalisesWhatItServes() {
  // Whatever spelling arrives, a pinned process connects with ONE host string.
  // Two spellings reaching setCredentials would be two sessions' worth of
  // teardown for what is really one host.
  assert(effectiveConnectHost("demo.ctraderapi.com", "DEMO.CTRADERAPI.COM") == "demo.ctraderapi.com");
  assert(effectiveConnectHost("demo.ctraderapi.com", " demo.ctraderapi.com ") == "demo.ctraderapi.com");
}

int main() {
  unpinnedAllowsEverything();
  pinnedRefusesTheOtherSide();
  absentHostTakesThePinNotTheDefault();
  comparisonIsForgivingAboutFormatting();
  pinnedProcessNormalisesWhatItServes();
  std::printf("test_host_pin: OK\n");
  return 0;
}
