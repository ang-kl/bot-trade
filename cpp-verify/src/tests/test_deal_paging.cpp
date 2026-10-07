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
#include "../verdict.hpp"

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
  // Codex · №11,920 · 2026-10-07; codex-footprint: executed-volume-contract.
  d.set("filledVolume", 10000.0);
  d.set("dealStatus", 2.0);
  d.set("tradeSide", closing ? 2.0 : 1.0);
  d.set("executionPrice", price);
  d.set("executionTimestamp", static_cast<double>(ts));
  d.set("commission", -1.0);
  if (closing) {
    jsn::Value c{jsn::Object{}};
    c.set("grossProfit", 100.0);
    c.set("swap", 0.0);
    c.set("balance", 10100.0);
    c.set("closedVolume", 10000.0);
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

// Codex · №11,920 · 2026-10-07; codex-footprint: executed-volume-contract.
void actualQuantitiesDecodeStrictlyWithoutSentFallback() {
  FakeBroker broker([](FakeBroker& b, const jsn::Value& frame) {
    if (handleAuth(b, frame)) return;
    if (typeOf(frame) != kDealListReq) return;
    jsn::Array rows;
    const std::vector<jsn::Value> values{jsn::Value(700), jsn::Value(std::string("700")),
      jsn::Value(), jsn::Value(true), jsn::Value(700.5), jsn::Value(std::string("700suffix")),
      jsn::Value(std::string(" ")), jsn::Value(std::string("9223372036854775808")),
      jsn::Value(9007199254740992.0), jsn::Value(0)};
    for (size_t i = 0; i < values.size(); ++i) {
      auto d = deal(static_cast<long long>(i + 1), 500, static_cast<long long>(1000 + i), 1.1, true);
      d.set("filledVolume", values[i]);
      d.set("dealStatus", i == 0 ? jsn::Value(std::string("FILLED")) : jsn::Value(std::string("PARTIALLY_FILLED")));
      d.set("tradeSide", std::string("SELL"));
      auto c = d.get("closePositionDetail"); c.set("closedVolume", values[i]);
      d.set("closePositionDetail", c);
      rows.push_back(d);
    }
    // Unknown status and money remain unknown, rather than inheriting enum0
    // or a numeric-prefix/zero monetary default.
    auto invalid = deal(100, 600, 1100, 1.2, true);
    invalid.set("dealStatus", std::string("2suffix"));
    invalid.set("commission", jsn::Value());
    auto close = invalid.get("closePositionDetail"); close.set("grossProfit", std::string("100suffix"));
    invalid.set("closePositionDetail", close); rows.push_back(invalid);
    b.reply(frame, kDealListRes, dealPage(std::move(rows), false));
  });
  auto s = openSession(broker); check(s->connect(4242), "actual-volume decode session connects");
  auto f = s->deals(4242, 500, 9000);
  check(f.ok && f.complete && f.deals.size() == 11, "actual-volume page retained complete");
  if (f.deals.size() != 11) return;
  for (size_t i = 0; i < 2; ++i) {
    check(f.deals[i].filledVolume == 700 && f.deals[i].closedVolume == 700,
      "both exact JSON number/string actual quantities decode");
    check(f.deals[i].volume == 10000 && f.deals[i].tradeSide == 2,
      "sent quantity remains separate and side enum name decodes");
    check(f.deals[i].dealStatus == static_cast<int>(i + 2), "executed enum names decode explicitly");
  }
  for (size_t i = 2; i < 9; ++i) {
    check(!f.deals[i].filledVolume && !f.deals[i].closedVolume,
      "absent/boolean/fraction/prefix/overflow actual quantity stays unknown " + std::to_string(i));
  }
  check(f.deals[9].filledVolume == 0 && f.deals[9].closedVolume == 0,
    "a reported zero remains present for the judge to reject as a fill");
  check(!f.deals[10].dealStatus && !f.deals[10].commissionKnown && !f.deals[10].closingMoneyKnown,
    "malformed status and missing/prefix cost are not fabricated facts");
}

// Codex · №11,920 · 2026-10-07; codex-footprint: executed-volume-contract.
void conflictingDuplicateReceiptsNeverCertifyTheFirstCopy() {
  for (const bool acrossPages : {false, true}) {
   for (const int change : {0, 1, 2, 3}) {
    std::atomic<int> page{0};
    FakeBroker broker([&](FakeBroker& b, const jsn::Value& frame) {
      if (handleAuth(b, frame)) return;
      if (typeOf(frame) != kDealListReq) return;
      auto opening = deal(1, 500, 1000, 1.0, false);
      auto closing = deal(2, 500, 2000, 1.1, true);
      // jsn::Value copies share object storage: construct a separate wire
      // receipt so changing the duplicate never mutates the original.
      auto changed = deal(2, 500, 2000, 1.1, true);
      if (change == 0) {
        changed.set("filledVolume", 5000.0);
        auto c = changed.get("closePositionDetail"); c.set("closedVolume", 5000.0);
        changed.set("closePositionDetail", c);
      } else if (change == 1) changed.set("positionId", 501.0);
      else if (change == 2) changed.set("dealStatus", 3.0);
      else changed.set("commission", false);
      if (acrossPages) {
        b.reply(frame, kDealListRes, page.fetch_add(1) == 0
          ? dealPage({opening, closing}, true) : dealPage({changed}, false));
      } else b.reply(frame, kDealListRes, dealPage({opening, closing, changed}, false));
    });
    auto s = openSession(broker); check(s->connect(4242), "conflicting duplicate session connects");
    auto fetch = s->deals(4242, 500, 9000); fetch.moneyDigits = 2;
    verify::KeeperRecord rec;
    rec.positionId = 500; rec.symbolId = 22396; rec.tradeSide = 1;
    rec.volume = 100; rec.lotSize = 100; rec.entryPrice = 1.0; rec.exitPrice = 1.1;
    rec.netPnl = 0.98; rec.openedAtMs = 1000; rec.closedAtMs = 2000;
    const auto v = verify::judge(rec, fetch);
    const auto scope = std::string(acrossPages ? "overlap pages" : "same page") + " change=" + std::to_string(change);
    check(!fetch.ok && !fetch.complete, std::string("conflicting receipt is an incomplete read: ") + scope);
    check(fetch.error.find("conflicting duplicate deal") != std::string::npos,
      std::string("conflicting receipt is named: ") + scope);
    check(v.state == verify::State::Unverified && !v.brokerVolume && !v.brokerNetPnl,
      std::string("actual session+judge cannot certify stale first duplicate: ") + scope);
   }
  }
}

void semanticallyIdenticalOverlapStillCertifies() {
  std::atomic<int> page{0};
  FakeBroker broker([&](FakeBroker& b, const jsn::Value& frame) {
    if (handleAuth(b, frame)) return;
    if (typeOf(frame) != kDealListReq) return;
    if (page.fetch_add(1) == 0) {
      b.reply(frame, kDealListRes, dealPage({deal(1, 500, 1000, 1.0, false), deal(2, 500, 2000, 1.1, true)}, true));
      return;
    }
    auto repeated = deal(2, 500, 2000, 1.1, true);
    repeated.set("dealId", "2"); repeated.set("positionId", "500"); repeated.set("symbolId", "22396");
    repeated.set("volume", "10000"); repeated.set("filledVolume", "10000"); repeated.set("dealStatus", "FILLED");
    repeated.set("tradeSide", "SELL"); repeated.set("executionPrice", "1.1");
    repeated.set("executionTimestamp", "2000"); repeated.set("commission", "-1");
    auto close = repeated.get("closePositionDetail");
    close.set("closedVolume", "10000"); close.set("grossProfit", "100"); close.set("swap", "0");
    repeated.set("closePositionDetail", close);
    b.reply(frame, kDealListRes, dealPage({repeated}, false));
  });
  auto s = openSession(broker); check(s->connect(4242), "identical overlap session connects");
  auto fetch = s->deals(4242, 500, 9000); fetch.moneyDigits = 2;
  verify::KeeperRecord rec;
  rec.positionId = 500; rec.symbolId = 22396; rec.tradeSide = 1;
  rec.volume = 100; rec.lotSize = 100; rec.entryPrice = 1.0; rec.exitPrice = 1.1;
  rec.netPnl = 0.98; rec.openedAtMs = 1000; rec.closedAtMs = 2000;
  check(fetch.ok && fetch.complete && fetch.deals.size() == 2,
    "equal broker int64 and enum encodings are deduped as one receipt");
  check(verify::judge(rec, fetch).state == verify::State::Verified,
    "unchanged complete lifecycle still verifies across an identical inclusive overlap");
}

} // namespace

int main() {
  aTwoPageWalkFollowsHasMoreToExhaustion();
  aStalledWalkReportsIncompleteRatherThanLoopingOrLying();
  aBrokerErrorMidWalkIsUnknownNotEmpty();
  anEmptyWindowIsRefusedBeforeAnySocketTraffic();
  actualQuantitiesDecodeStrictlyWithoutSentFallback();
  conflictingDuplicateReceiptsNeverCertifyTheFirstCopy();
  semanticallyIdenticalOverlapStillCertifies();

  if (failures) { std::fprintf(stderr, "test_deal_paging: %d failure(s)\n", failures); return 1; }
  std::fprintf(stderr, "test_deal_paging: all passed\n");
  return 0;
}
