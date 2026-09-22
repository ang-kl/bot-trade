// cpp-verify/src/tests/test_deal_paging.cpp — the page walk, against a
// scripted loopback broker (cpp-exec's FakeBroker, reused unchanged).
//
// WHY THIS TEST EXISTS. `fetchDeals` in agent/lib/broker-history-import.js
// sends maxRows 500 and never reads `hasMore` (measured 17-09-2026), while
// agent/services/entry-ledger.js:550 in the same repo pages correctly. The
// verifier is the component that must not inherit the first shape, so the
// walk is pinned here — including the two ways it can go wrong quietly:
// stopping early and looping forever.
#include <atomic>
#include <memory>
#include <cassert>
#include <cstdio>
#include <string>

#include "fake_broker.hpp"
#include "../verify_session.hpp"

namespace {

constexpr int kAppAuthReq = 2100;
constexpr int kAppAuthRes = 2101;
constexpr int kAccountAuthReq = 2102;
constexpr int kAccountAuthRes = 2103;
constexpr int kDealListReq = 2133;
constexpr int kDealListRes = 2134;
constexpr int kErrorRes = 2142;

int failures = 0;
void check(bool cond, const std::string& what) {
  if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what.c_str()); ++failures; }
}

int typeOf(const jsn::Value& f) { return static_cast<int>(f.get("payloadType").asNumber(-1)); }

jsn::Value deal(long long id, long long pos, long long ts, double price, bool closing) {
  jsn::Value d{jsn::Object{}};
  d.set("dealId", static_cast<double>(id));
  d.set("positionId", static_cast<double>(pos));
  d.set("symbolId", 22396.0);
  d.set("volume", 10000.0);
  d.set("tradeSide", closing ? 2.0 : 1.0);
  d.set("executionPrice", price);
  d.set("executionTimestamp", static_cast<double>(ts));
  d.set("commission", -1.0);
  if (closing) {
    jsn::Value c{jsn::Object{}};
    c.set("grossProfit", 100.0);
    c.set("swap", 0.0);
    c.set("balance", 10100.0);
    d.set("closePositionDetail", c);
  }
  return d;
}

jsn::Value dealPage(jsn::Array deals, bool hasMore) {
  jsn::Value p{jsn::Object{}};
  p.set("deal", jsn::Value(std::move(deals)));
  p.set("hasMore", hasMore);
  return p;
}

// App auth + account auth, which every scenario needs.
bool handleAuth(FakeBroker& b, const jsn::Value& f) {
  int t = typeOf(f);
  if (t == kAppAuthReq) { b.reply(f, kAppAuthRes, jsn::Value{jsn::Object{}}); return true; }
  if (t == kAccountAuthReq) { b.reply(f, kAccountAuthRes, jsn::Value{jsn::Object{}}); return true; }
  // Paging scenarios do not supply a money scale. Answer explicitly instead
  // of making every fixture wait 20 seconds for this unrelated metadata.
  if (t == 2121) { b.reply(f, 2122, jsn::Value{jsn::Object{}}); return true; }
  return false;
}

// VerifySession holds a mutex, so it is neither copyable nor movable —
// the helper hands back a pointer rather than a value.
std::unique_ptr<verify::VerifySession> openSession(FakeBroker& b) {
  auto s = std::make_unique<verify::VerifySession>("unused.example", "cid", "csecret", "token");
  s->setLoopbackTransportForTests(b.port());
  return s;
}

void aTwoPageWalkFollowsHasMoreToExhaustion() {
  std::atomic<int> pages{0};
  FakeBroker broker([&pages](FakeBroker& b, const jsn::Value& f) {
    if (handleAuth(b, f)) return;
    if (typeOf(f) != kDealListReq) return;
    int n = pages.fetch_add(1);
    if (n == 0) {
      b.reply(f, kDealListRes, dealPage({deal(1, 500, 1000, 1.0, false),
                                         deal(2, 500, 2000, 1.1, true)}, true));
    } else {
      // The second page REPEATS deal 2: the cursor lands ON the last
      // timestamp rather than past it, precisely so nothing sharing that
      // millisecond is skipped. The overlap must be dropped by dealId.
      b.reply(f, kDealListRes, dealPage({deal(2, 500, 2000, 1.1, true),
                                         deal(3, 600, 3000, 2.0, false)}, false));
    }
  });
  check(broker.port() > 0, "fake broker bound");

  auto s = openSession(broker);
  check(s->connect(4242), "session connects and authorizes");
  auto f = s->deals(4242, 500, 9000);
  check(f.ok && f.complete, "the walk completes");
  check(f.pages == 2, "two pages were requested");
  check(f.deals.size() == 3, "the repeated deal is deduped, nothing is skipped");
  check(f.deals[0].dealId == 1 && f.deals[2].dealId == 3, "deals come back in execution order");
  check(f.deals[1].hasClose && f.deals[1].grossProfit == 100.0, "close detail is carried");
  check(f.deals[0].commission == -1.0,
        "the OPENING deal's commission is read from the top-level field");
}

void aStalledWalkReportsIncompleteRatherThanLoopingOrLying() {
  // hasMore stays set and the page never advances — a broker bug, a clock
  // problem, whatever. The two wrong answers are "spin forever" and "return
  // what we have and call it complete". Neither is taken.
  FakeBroker broker([](FakeBroker& b, const jsn::Value& f) {
    if (handleAuth(b, f)) return;
    if (typeOf(f) != kDealListReq) return;
    b.reply(f, kDealListRes, dealPage({deal(1, 500, 1000, 1.0, false)}, true));
  });

  auto s = openSession(broker);
  check(s->connect(4242), "session connects");
  auto f = s->deals(4242, 500, 9000);
  check(!f.complete, "a stalled walk is never complete");
  check(!f.ok, "and never ok");
  check(f.error.find("stalled") != std::string::npos, "and says it stalled: " + f.error);
  check(f.pages == 2, "it stops at the first non-advancing page, not at the page cap");
}

void aBrokerErrorMidWalkIsUnknownNotEmpty() {
  std::atomic<int> pages{0};
  FakeBroker broker([&pages](FakeBroker& b, const jsn::Value& f) {
    if (handleAuth(b, f)) return;
    if (typeOf(f) != kDealListReq) return;
    if (pages.fetch_add(1) == 0) {
      b.reply(f, kDealListRes, dealPage({deal(1, 500, 1000, 1.0, false)}, true));
    } else {
      jsn::Value e{jsn::Object{}};
      e.set("errorCode", std::string("REQUEST_FREQUENCY_EXCEEDED"));
      e.set("description", std::string("slow down"));
      b.reply(f, kErrorRes, e);
    }
  });

  auto s = openSession(broker);
  check(s->connect(4242), "session connects");
  auto f = s->deals(4242, 500, 9000);
  check(!f.ok && !f.complete, "an error mid-walk leaves the fetch unknown");
  check(f.error.find("REQUEST_FREQUENCY_EXCEEDED") != std::string::npos,
        "the broker's own error code is carried: " + f.error);
  // The partial rows are still there for a human to look at — but `complete`
  // is what any caller must key on, and it is false.
  check(f.deals.size() == 1, "the partial page is kept, flagged incomplete");
}

void anEmptyWindowIsRefusedBeforeAnySocketTraffic() {
  FakeBroker broker([](FakeBroker& b, const jsn::Value& f) { handleAuth(b, f); });
  auto s = openSession(broker);
  check(s->connect(4242), "session connects");
  size_t before = broker.receivedCount();
  auto f = s->deals(4242, 5000, 5000);
  check(!f.ok && f.error == "empty window", "an empty window is refused");
  check(broker.receivedCount() == before, "and costs the broker no request");
}

} // namespace

int main() {
  aTwoPageWalkFollowsHasMoreToExhaustion();
  aStalledWalkReportsIncompleteRatherThanLoopingOrLying();
  aBrokerErrorMidWalkIsUnknownNotEmpty();
  anEmptyWindowIsRefusedBeforeAnySocketTraffic();

  if (failures) { std::fprintf(stderr, "test_deal_paging: %d failure(s)\n", failures); return 1; }
  std::fprintf(stderr, "test_deal_paging: all passed\n");
  return 0;
}
