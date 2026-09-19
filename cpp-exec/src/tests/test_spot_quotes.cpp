// cpp-exec/src/tests/test_spot_quotes.cpp — 19-09-2026: the fast monitor's
// quotes come from the sidecar. What it proves:
//
//  - a spot event updates the feed's latest-quote table: the carried bid/ask
//    (a one-sided frame keeps the other side), the event's own timestamp
//    when it carried one, and a local receipt time;
//  - GET /quotes, on a REAL HttpServer over a REAL socket, serves that table
//    with the field names the keeper reads (feed, generation, count, quotes
//    [symbolId, bid, ask, tsMs, recvMs]), a side never seen as null;
//  - `?ids=` filters, and an empty/absent filter is every symbol;
//  - a sidecar with NO feed answers feed:"absent", count 0 — the keeper's
//    signal to fall back to the broker — and a feed with no events yet
//    answers feed:"up", count 0;
//  - the bearer gate: no header, a wrong secret, and an unconfigured secret
//    all refuse 401;
//  - `nowMs` (the sidecar's clock at answer time) rides on the body, so the
//    keeper ages a quote on one clock;
//  - after a RECONNECT a bid-only first frame keeps the slot's ask from the
//    previous connection (the carry is per slot, not per connection).
//
// The feed runs on its own thread against the fake broker while the HTTP
// thread copies the table, which is why this file is in TSAN_TESTS.
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <thread>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include "../http_server.hpp"
#include "../json.hpp"
#include "../spot_feed.hpp"
#include "../spot_quote_routes.hpp"
#include "fake_broker.hpp"

using namespace std::chrono;

namespace {
constexpr int kAppAuthReq = 2100, kAppAuthRes = 2101, kAccountAuthReq = 2102, kAccountAuthRes = 2103;
constexpr int kSubscribeSpotsReq = 2127, kSubscribeSpotsRes = 2128, kSpotEvent = 2131;

int typeOf(const jsn::Value& f) { return static_cast<int>(f.get("payloadType").asNumber(-1)); }

void handshake(FakeBroker& b, const jsn::Value& f) {
  const int type = typeOf(f);
  jsn::Value p{jsn::Object{}};
  if (type == kAppAuthReq) { b.reply(f, kAppAuthRes, p); return; }
  if (type == kAccountAuthReq) { p.set("ctidTraderAccountId", f.get("payload").get("ctidTraderAccountId")); b.reply(f, kAccountAuthRes, p); return; }
  if (type == kSubscribeSpotsReq) { p.set("ctidTraderAccountId", f.get("payload").get("ctidTraderAccountId")); b.reply(f, kSubscribeSpotsRes, p); return; }
}

jsn::Value spot(long long symbolId, long long bid, long long ask, long long ts = 0) {
  jsn::Value p{jsn::Object{}};
  p.set("symbolId", static_cast<double>(symbolId));
  if (bid > 0) p.set("bid", static_cast<double>(bid));
  if (ask > 0) p.set("ask", static_cast<double>(ask));
  if (ts > 0) p.set("timestamp", static_cast<double>(ts));
  return FakeBroker::pushFrame(kSpotEvent, p);
}

bool waitTicks(const SpotFeed& feed, long long n, int timeoutMs) {
  const auto deadline = steady_clock::now() + milliseconds(timeoutMs);
  while (steady_clock::now() < deadline) {
    if (feed.tickCount() >= n) return true;
    std::this_thread::sleep_for(milliseconds(10));
  }
  return false;
}

struct HttpReply { int status = 0; std::string body; };

HttpReply httpGet(int port, const std::string& target, const std::string& bearer, bool sendAuth = true) {
  HttpReply out;
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  assert(fd >= 0);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(static_cast<uint16_t>(port));
  addr.sin_addr.s_addr = inet_addr("127.0.0.1");
  timeval tv{};
  tv.tv_sec = 10;
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) != 0) { ::close(fd); return out; }
  std::string req = "GET " + target + " HTTP/1.1\r\nHost: 127.0.0.1\r\n";
  if (sendAuth) req += "Authorization: Bearer " + bearer + "\r\n";
  req += "Connection: close\r\n\r\n";
  size_t off = 0;
  while (off < req.size()) {
    const ssize_t n = ::send(fd, req.data() + off, req.size() - off, 0);
    if (n <= 0) break;
    off += static_cast<size_t>(n);
  }
  std::string raw;
  char buf[8192];
  for (;;) {
    const ssize_t n = ::recv(fd, buf, sizeof buf, 0);
    if (n <= 0) break;
    raw.append(buf, static_cast<size_t>(n));
  }
  ::close(fd);
  const size_t sp = raw.find(' ');
  if (sp != std::string::npos) out.status = std::atoi(raw.c_str() + sp + 1);
  const size_t sep = raw.find("\r\n\r\n");
  if (sep != std::string::npos) out.body = raw.substr(sep + 4);
  return out;
}

jsn::Value bodyOf(const HttpReply& r) {
  auto parsed = jsn::parse(r.body);
  assert(parsed && parsed->isObject());
  return *parsed;
}

int startServer(HttpServer& server, int port, const std::string& secret) {
  std::thread([&server] { server.run(); }).detach();
  for (int i = 0; i < 200; ++i) {
    if (httpGet(port, "/quotes", secret).status != 0) break;
    std::this_thread::sleep_for(milliseconds(10));
  }
  return port;
}

// The feed's routes read from the process through this seam in main.cpp;
// the test hands it the same shape.
QuoteFeedReader readerFor(SpotFeed* feed) {
  return [feed]() -> QuoteFeedView {
    QuoteFeedView v;
    if (!feed) return v;
    v.present = true;
    v.connected = feed->isConnected();
    v.generation = feed->reconnects() + 1;
    v.accountId = feed->accountId();
    v.quotes = feed->latestQuotes();
    return v;
  };
}

const jsn::Value* quoteFor(const jsn::Value& body, long long symbolId) {
  for (const auto& q : body.get("quotes").asArray())
    if (static_cast<long long>(q.get("symbolId").asNumber(0)) == symbolId) return &q;
  return nullptr;
}
} // namespace

static void test_quotes_update_and_the_route_serves_them() {
  FakeBroker broker(handshake);
  assert(broker.port() > 0);
  SpotFeed feed("127.0.0.1", "ci", "cs", "tok", 4002, /*symbolIds=*/{41, 42}, /*onTick=*/nullptr, false);
  feed.setLoopbackTransportForTests(broker.port());
  std::thread t([&feed] { feed.runLoop(); });
  assert(broker.waitForConnection(5000));
  // the handshake's three frames (app auth, account auth, subscribe)
  assert(broker.waitForFrames(3, 5000));
  for (int i = 0; i < 200 && !feed.isConnected(); ++i) std::this_thread::sleep_for(milliseconds(10));
  assert(feed.isConnected());

  const std::string secret = "quotes-secret";
  const int port = 20000 + static_cast<int>(::getpid() % 9000);
  HttpServer server(port, secret);
  registerSpotQuoteRoutes(server, readerFor(&feed), secret);
  startServer(server, port, secret);

  // a live feed with no events yet: up, empty
  {
    jsn::Value b = bodyOf(httpGet(port, "/quotes", secret));
    assert(b.get("feed").asString() == "up");
    assert(b.get("generation").asNumber(0) == 1);
    assert(b.get("accountId").asNumber(0) == 4002); // the feed's account: the id space of the table
    assert(b.get("count").asNumber(-1) == 0);
    assert(b.get("quotes").isArray() && b.get("quotes").asArray().empty());
    std::puts("  live feed, no events: feed up, count 0");
  }

  const long long beforeMs = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
  // 41: both sides, with the broker's own timestamp; 42: bid only
  assert(broker.send(spot(41, 110000, 110020, 1758240000000LL)));
  assert(broker.send(spot(42, 250000, 0)));
  assert(waitTicks(feed, 2, 5000));
  {
    const auto all = feed.latestQuotes();
    assert(all.size() == 2);
    assert(all[0].symbolId == 41 && all[1].symbolId == 42);
    assert(all[0].bid == 1.1 && all[0].ask == 1.1002);
    assert(all[0].tsMs == 1758240000000LL);
    assert(all[0].recvMs >= beforeMs);
    assert(all[1].bid == 2.5 && all[1].ask == 0); // ask never seen
    assert(all[1].tsMs == all[1].recvMs);          // no broker timestamp → receipt time
    std::puts("  latestQuotes(): both symbols, descaled, timestamps as documented");
  }
  {
    jsn::Value b = bodyOf(httpGet(port, "/quotes", secret));
    assert(b.get("feed").asString() == "up");
    assert(b.get("count").asNumber(-1) == 2);
    // nowMs: the sidecar's own clock at answer time, at or after every recvMs
    assert(b.get("nowMs").asNumber(0) >= static_cast<double>(beforeMs));
    for (const auto& q : b.get("quotes").asArray()) assert(b.get("nowMs").asNumber(0) >= q.get("recvMs").asNumber(0));
    const jsn::Value* q41 = quoteFor(b, 41);
    const jsn::Value* q42 = quoteFor(b, 42);
    assert(q41 && q42);
    assert(q41->get("bid").asNumber(0) == 1.1 && q41->get("ask").asNumber(0) == 1.1002);
    assert(q41->get("tsMs").asNumber(0) == 1758240000000.0);
    assert(q41->get("recvMs").asNumber(0) >= static_cast<double>(beforeMs));
    assert(q42->get("bid").asNumber(0) == 2.5);
    assert(q42->get("ask").isNull()); // never 0
    std::puts("  GET /quotes: the table, a never-seen side as null");
  }
  // the carry: a second one-sided frame for 42 fills its ask and keeps the bid
  assert(broker.send(spot(42, 0, 250040)));
  assert(waitTicks(feed, 3, 5000));
  {
    jsn::Value b = bodyOf(httpGet(port, "/quotes?ids=42", secret));
    assert(b.get("count").asNumber(-1) == 1);
    const jsn::Value* q42 = quoteFor(b, 42);
    assert(q42 && q42->get("bid").asNumber(0) == 2.5 && q42->get("ask").asNumber(0) == 2.5004);
    assert(quoteFor(b, 41) == nullptr);
    std::puts("  a one-sided frame carries the other side; ?ids= filters");
  }
  // a fresh event replaces, never appends
  assert(broker.send(spot(41, 110100, 110120)));
  assert(waitTicks(feed, 4, 5000));
  {
    jsn::Value b = bodyOf(httpGet(port, "/quotes?ids=41,42,99", secret));
    assert(b.get("count").asNumber(-1) == 2);
    const jsn::Value* q41 = quoteFor(b, 41);
    assert(q41 && q41->get("bid").asNumber(0) == 1.101 && q41->get("ask").asNumber(0) == 1.1012);
    assert(feed.latestQuotes().size() == 2);
    std::puts("  a new event replaces the slot; unknown ids in the filter are ignored");
  }
  // reconnect: the broker hangs up, the feed comes back on generation 2, and
  // a bid-only first frame for 41 keeps its ask from before the drop
  broker.dropClient();
  for (int i = 0; i < 500 && feed.reconnects() < 1; ++i) std::this_thread::sleep_for(milliseconds(10));
  assert(broker.waitForConnection(5000));
  for (int i = 0; i < 500 && !feed.isConnected(); ++i) std::this_thread::sleep_for(milliseconds(10));
  assert(feed.isConnected());
  assert(broker.send(spot(41, 110200, 0)));
  assert(waitTicks(feed, 5, 5000));
  {
    jsn::Value b = bodyOf(httpGet(port, "/quotes?ids=41", secret));
    assert(b.get("generation").asNumber(0) == 2);
    const jsn::Value* q41 = quoteFor(b, 41);
    assert(q41 && q41->get("bid").asNumber(0) == 1.102 && q41->get("ask").asNumber(0) == 1.1012);
    std::puts("  after a reconnect a one-sided frame keeps the slot's other side");
  }
  // the gate
  assert(httpGet(port, "/quotes", "", /*sendAuth=*/false).status == 401);
  assert(httpGet(port, "/quotes", "wrong-secret").status == 401);
  std::puts("  bearer: no header and a wrong secret refuse 401");

  feed.stop();
  t.join();
}

static void test_no_feed_is_absent_and_an_unconfigured_secret_refuses() {
  const std::string secret = "quotes-secret";
  {
    const int port = 20000 + static_cast<int>((::getpid() + 1) % 9000);
    HttpServer server(port, secret);
    registerSpotQuoteRoutes(server, readerFor(nullptr), secret);
    startServer(server, port, secret);
    jsn::Value b = bodyOf(httpGet(port, "/quotes", secret));
    assert(b.get("feed").asString() == "absent");
    assert(b.get("generation").asNumber(-1) == 0);
    assert(b.get("accountId").isNull());
    assert(b.get("count").asNumber(-1) == 0);
    assert(b.get("quotes").isArray() && b.get("quotes").asArray().empty());
    std::puts("  no feed object: feed absent, count 0");
  }
  {
    const int port = 20000 + static_cast<int>((::getpid() + 2) % 9000);
    HttpServer server(port, "");
    registerSpotQuoteRoutes(server, readerFor(nullptr), "");
    std::thread([&server] { server.run(); }).detach();
    for (int i = 0; i < 200; ++i) {
      if (httpGet(port, "/quotes", "").status != 0) break;
      std::this_thread::sleep_for(milliseconds(10));
    }
    assert(httpGet(port, "/quotes", "").status == 401);        // "Bearer " passes the server gate, the route refuses
    assert(httpGet(port, "/quotes", "", false).status == 401); // no header at all
    std::puts("  unconfigured secret: the route refuses on its own");
  }
}

int main() {
  test_quotes_update_and_the_route_serves_them();
  test_no_feed_is_absent_and_an_unconfigured_secret_refuses();
  std::puts("test_spot_quotes: all passed");
  return 0;
}
