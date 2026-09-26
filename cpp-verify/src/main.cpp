// cpp-verify/src/main.cpp — the verifier's HTTP surface. Read-only AT THE
// BROKER; the one thing it writes is its own verdict journal.
//
// READ-ONLY BROKER ROUTES:
//   GET  /health   public (Railway's probe sends no headers)
//   POST /connect  bearer; adds or refreshes a broker session FOR A HOST
//   POST /verify   bearer; re-fetches a position's deals and answers a verdict
//   GET  /protection-status bearer; independently checked open SL/TP coverage
//   GET  /watchdog-status bearer; incidents, outbox, the delivery gate (CV-2)
//   POST /watchdog/mute bearer; the verifier-local delivery mute (CV-2) —
//        touches only the watchdog state file, never a broker
//
// There is no route that writes to a broker because there is no code in this
// binary that can: the Makefile links verify_session.cpp and verdict.cpp, not
// cpp-exec's engine.
//
// CTRADER_HOST IS NOT READ HERE, DELIBERATELY. cpp-exec and cpp-acct each pin
// one host from that variable. The owner's requirement is ONE verifier for
// demo and live, so the host arrives per request and sessions are held in a
// map keyed by host. If CTRADER_HOST is set on this service it is ignored,
// and /health says so, because a silently-ignored variable is worse than a
// refused one.
#include <algorithm>
#include <cstdlib>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "http_server.hpp"
#include "json.hpp"
#include "journal.hpp"
#include "log.hpp"
#include "verdict.hpp"
#include "verify_session.hpp"
#include "protection_watch.hpp"
#include "watchdog.hpp"

namespace {

// SHARED, NOT UNIQUE, AND THE LOCK IS NOT HELD ACROSS THE FETCH. /verify
// can sit on a broker socket for tens of seconds per page; holding g_mtx for
// that would block GET /health, whose whole job is to answer Railway's probe
// in time. So the handler copies the shared_ptr under the lock and releases
// it before any network call — and the pointer must be SHARED, because a
// concurrent /connect replacing the map entry would otherwise free the
// session out from under a fetch in progress. That is the same use-after-free
// shape the cpp-exec /connect audit found (PR-AD's predecessor), avoided here
// by construction rather than by hoping the two never overlap.
std::mutex g_mtx;
std::map<std::string, std::shared_ptr<verify::VerifySession>> g_sessions;  // host -> session
std::map<std::string, std::vector<long long>> g_accounts;                  // host -> authorized

std::string env(const char* k, const std::string& dflt = "") {
  const char* v = std::getenv(k);
  return (v && *v) ? std::string(v) : dflt;
}

long long i64(const jsn::Value& v) {
  if (v.isNumber()) return static_cast<long long>(v.asNumber(0));
  if (v.isString()) { try { return std::stoll(v.asString()); } catch (...) { return 0; } }
  return 0;
}

// A keeper field that is ABSENT stays absent — it is never read as 0. This
// one helper is why: `Number(null) === 0` is the JS shape of the same bug and
// it has cost this project three separate defects (lot-size-registry.js).
std::optional<double> optNum(const jsn::Value& o, const std::string& key) {
  const auto& v = o.get(key);
  if (v.isNumber()) return v.asNumber(0);
  if (v.isString() && !v.asString().empty()) {
    try { return std::stod(v.asString()); } catch (...) { return std::nullopt; }
  }
  return std::nullopt;
}

template <typename T>
std::optional<T> optAs(const jsn::Value& o, const std::string& key) {
  auto d = optNum(o, key);
  if (!d) return std::nullopt;
  return static_cast<T>(*d);
}

HttpResponse jsonRes(int status, const std::string& body) { return {status, body}; }

HttpResponse errRes(int status, const std::string& msg) {
  jsn::Value o{jsn::Object{}};
  o.set("error", msg);
  return {status, jsn::dump(o)};
}

} // namespace

int main() {
  const int port = std::atoi(env("PORT", "8080").c_str());
  const std::string secret = env("EXEC_SECRET");
  if (secret.empty()) {
    sidecar_log::logError("[verify]", "EXEC_SECRET not set — refusing to start");
    return 2;
  }
  const bool hostPinIgnored = !env("CTRADER_HOST").empty();

  // THE VERIFIER KEEPS ITS OWN RECORD. A verdict written only into the
  // agent's database is a finding held by the party being audited; this is
  // the copy the agent cannot reach. Off when unset, and it proves it can
  // write at boot rather than discovering otherwise on the first verdict.
  verify::journal().open(env("VERIFY_JOURNAL_DIR"));

  // "READ-ONLY" IS A CLAIM ABOUT THE BROKER, AND IT MUST SAY SO.
  //
  // The bare word was accurate until this service grew a verdict journal, and
  // then the very next boot line read "journal UNWRITABLE ... mkdir:
  // Permission denied" — a service announcing it is read-only and, one line
  // later, that it failed to write. A reader is entitled to conclude one of
  // the two lines is lying.
  //
  // Neither is. The guarantee is that it never PLACES, AMENDS OR CANCELS
  // anything at the broker — enforced structurally by the link line, which
  // pulls in no order-writing code (see the Makefile and sidecar-pins.test.js).
  // It was never a claim that the process writes no bytes anywhere. So the
  // scope is stated rather than left to be inferred, and what it DOES write is
  // named in the same breath.
  sidecar_log::logInfoF("[verify]",
               "cpp-verify starting on :%d — READ-ONLY AT THE BROKER: "
               "app auth, account auth, trader, deals and reconcile; it never places, amends or "
               "cancels. It writes its verdict journal and, when configured, watchdog state. "
               "Sessions are per host%s",
               port, hostPinIgnored ? "; CTRADER_HOST is set and IGNORED" : "");
  if (!verify::journal().configured()) {
    sidecar_log::logInfo("[verify]", "journal OFF — VERIFY_JOURNAL_DIR not set; verdicts are returned but not kept here");
  } else if (verify::journal().writable()) {
    sidecar_log::logInfoF("[verify]", "journal WRITABLE at %s", verify::journal().dir().c_str());
  } else {
    // Loud, because a mounted volume this process cannot write to looks
    // exactly like a working one until someone reads the trail and finds
    // nothing in it.
    sidecar_log::logErrorF("[verify]", "journal UNWRITABLE at %s — %s",
                 verify::journal().dir().c_str(), verify::journal().lastError().c_str());
  }

  verify::ProtectionWatch protection;
  protection.start();
  verify::Watchdog watchdog([&] { return protection.status(); });
  watchdog.start();
  HttpServer server(port, secret);
  server.route("GET", "/watchdog-status", [&](const HttpRequest&) {
    return jsonRes(200, jsn::dump(watchdog.status()));
  });
  // V3 CV-2: the verifier-local mute, behind the same bearer as every route
  // but /health, and answered with Node down. {"muted": true} always applies;
  // {"muted": false} is refused (409) until the 24 h soak has ended. It
  // gates delivery only: incidents, the outbox and the would-send counters
  // keep running either way.
  server.route("POST", "/watchdog/mute", [&](const HttpRequest& req) {
    auto body = jsn::parse(req.body);
    if (!body || !body->isObject() || !body->get("muted").isBool()) return errRes(400, "body must be {\"muted\": true|false}");
    const auto result = watchdog.setMuted(body->get("muted").asBool());
    return jsonRes(result.get("ok").asBool() ? 200 : 409, jsn::dump(result));
  });
  server.route("GET", "/protection-status", [&](const HttpRequest&) {
    return jsonRes(200, jsn::dump(protection.status()));
  });

  server.route("GET", "/health", [&](const HttpRequest&) {
    std::lock_guard<std::mutex> lk(g_mtx);
    jsn::Value o{jsn::Object{}};
    o.set("ok", true);
    o.set("service", std::string("cpp-verify"));
    // Scoped, not bare: `readOnly` means AT THE BROKER. `writes` names every
    // byte this service puts on disk, so the payload cannot drift from the
    // truth the way a lone boolean did.
    o.set("readOnly", true);
    o.set("readOnlyScope", std::string("broker: never places, amends or cancels"));
    jsn::Array writes;
    writes.push_back(jsn::Value(std::string("verdict journal")));
    const auto watch = watchdog.status();
    if (watch.get("enabled").asBool()) writes.push_back(jsn::Value("watchdog incidents and outbox"));
    o.set("writes", jsn::Value(std::move(writes)));
    o.set("watchdog", jsn::Value(jsn::Object{{"enabled", watch.get("enabled")},
      {"durable", watch.get("durable")}, {"error", watch.get("error")},
      {"effectivePolicyAllowsUrgent", watch.get("effectivePolicyAllowsUrgent")},
      // V3 CV-2: the soak on the health probe too, so Railway's own check
      // shows whether a message could leave.
      {"deliveryMuted", watch.get("delivery").get("muted")}, {"deliveryOpen", watch.get("delivery").get("open")},
      {"soakActive", watch.get("delivery").get("soakActive")}, {"soakEndsAtMs", watch.get("delivery").get("soakEndsAtMs")}}));
    o.set("hostPinIgnored", hostPinIgnored);
    jsn::Value j{jsn::Object{}};
    j.set("configured", verify::journal().configured());
    j.set("writable", verify::journal().writable());
    if (verify::journal().configured()) j.set("dir", verify::journal().dir());
    if (!verify::journal().lastError().empty()) j.set("lastError", verify::journal().lastError());
    j.set("written", static_cast<double>(verify::journal().written()));
    o.set("journal", j);
    jsn::Array hosts;
    for (const auto& [host, sess] : g_sessions) {
      jsn::Value h{jsn::Object{}};
      h.set("host", host);
      h.set("open", sess->isOpen());
      jsn::Array accts;
      for (long long id : g_accounts[host]) accts.push_back(jsn::Value(static_cast<double>(id)));
      h.set("accounts", jsn::Value(std::move(accts)));
      hosts.push_back(h);
    }
    o.set("sessions", jsn::Value(std::move(hosts)));
    return jsonRes(200, jsn::dump(o));
  });

  server.route("POST", "/connect", [&](const HttpRequest& req) {
    auto body = jsn::parse(req.body);
    if (!body || !body->isObject()) return errRes(400, "body must be a JSON object");
    const std::string host = body->get("host").asString();
    const std::string purpose = body->get("purpose").asString();
    if (!purpose.empty() && purpose != "history" && purpose != "protection") return errRes(400, "unknown session purpose");
    if (host.empty()) return errRes(400, "host is required — this service holds no default");

    std::vector<long long> want;
    long long primary = i64(body->get("accountId"));
    if (primary) want.push_back(primary);
    for (const auto& v : body->get("accountIds").asArray()) {
      long long id = i64(v);
      if (id && std::find(want.begin(), want.end(), id) == want.end()) want.push_back(id);
    }
    if (want.empty()) return errRes(400, "no account ids");

    // BUILT AND AUTHORIZED OUTSIDE THE LOCK. Each account auth is a broker
    // round trip with a 20 s ceiling, so authorizing four accounts under
    // g_mtx could hold it for over a minute — long enough for Railway's
    // /health probe to time out and restart a service that is working fine.
    // The session is installed into the map only once it is ready.
    //
    // A new session per /connect for this host: credentials may have been
    // rotated, and this service holds no open orders or subscriptions, so a
    // rebuild costs nothing. (cpp-exec cannot say that — a feed rebuild there
    // costs a recorder gap, which is what PR-AB/PR-AD were about.)
    auto slot = std::make_shared<verify::VerifySession>(host,
                                                        body->get("clientId").asString(),
                                                        body->get("clientSecret").asString(),
                                                        body->get("accessToken").asString());
    std::vector<long long> ok;
    jsn::Array results;
    for (long long id : want) {
      bool good = slot->connect(id);
      if (good) ok.push_back(id);
      jsn::Value r{jsn::Object{}};
      r.set("accountId", static_cast<double>(id));
      r.set("authorized", good);
      if (!good) r.set("error", slot->lastError());
      results.push_back(r);
    }
    if (purpose == "protection") {
      protection.replace(host, slot, ok);
    } else {
      std::lock_guard<std::mutex> lk(g_mtx);
      g_sessions[host] = slot;
      g_accounts[host] = ok;
    }

    jsn::Value o{jsn::Object{}};
    o.set("host", host);
    o.set("authorized", static_cast<double>(ok.size()));
    o.set("requested", static_cast<double>(want.size()));
    o.set("accounts", jsn::Value(std::move(results)));
    return jsonRes(ok.empty() ? 502 : 200, jsn::dump(o));
  });

  server.route("POST", "/verify", [&](const HttpRequest& req) {
    auto body = jsn::parse(req.body);
    if (!body || !body->isObject()) return errRes(400, "body must be a JSON object");
    const std::string host = body->get("host").asString();
    long long accountId = i64(body->get("accountId"));
    long long fromMs = i64(body->get("fromMs"));
    long long toMs = i64(body->get("toMs"));
    const auto& rj = body->get("record");
    if (host.empty() || !accountId || !fromMs || !toMs || !rj.isObject()) {
      return errRes(400, "host, accountId, fromMs, toMs and record are all required");
    }

    verify::KeeperRecord rec;
    rec.positionId = i64(rj.get("positionId"));
    if (!rec.positionId) return errRes(400, "record.positionId is required");
    rec.symbolId = optAs<long long>(rj, "symbolId");
    rec.tradeSide = optAs<int>(rj, "tradeSide");
    // A DOUBLE, because position_history.volume is REAL. Reading it as
    // long long truncated 9.4 units to 9 and then disputed the difference
    // against the broker's own 9.4 — the verifier manufacturing a finding
    // out of its own narrowing.
    rec.volume = optNum(rj, "volume");
    // The symbol's lotSize (broker cents of units per lot), from the keeper's
    // registry of the broker's own declaration. Optional: absent means the
    // volume goes uncompared, not scaled by a guess (contract 3).
    rec.lotSize = optNum(rj, "lotSize");
    rec.entryPrice = optNum(rj, "entryPrice");
    rec.exitPrice = optNum(rj, "exitPrice");
    rec.netPnl = optNum(rj, "netPnl");
    rec.openedAtMs = optAs<long long>(rj, "openedAtMs");
    rec.closedAtMs = optAs<long long>(rj, "closedAtMs");

    std::shared_ptr<verify::VerifySession> session;
    {
      std::lock_guard<std::mutex> lk(g_mtx);
      auto it = g_sessions.find(host);
      if (it == g_sessions.end()) return errRes(409, "no session for host " + host + " — POST /connect first");
      const auto& authed = g_accounts[host];
      if (std::find(authed.begin(), authed.end(), accountId) == authed.end()) {
        // I17: never answer for an account this session was not authorized
        // on. Reading one account's history under another's authorization is
        // the leak this check exists to make impossible.
        return errRes(403, "account " + std::to_string(accountId) + " is not authorized on " + host);
      }
      session = it->second;
    }
    // g_mtx released. The session serializes its own requests internally.
    verify::DealFetch fetch = session->deals(accountId, fromMs, toMs);
    fetch.moneyDigits = session->moneyDigits(accountId);

    verify::Verdict v = verify::judge(rec, fetch);
    auto o = jsn::parse(verify::verdictJson(v));
    jsn::Value out = o ? *o : jsn::Value{jsn::Object{}};
    out.set("host", host);
    out.set("accountId", static_cast<double>(accountId));
    out.set("positionId", static_cast<double>(rec.positionId));
    out.set("fetchPages", static_cast<double>(fetch.pages));
    out.set("fetchComplete", fetch.complete);

    // EVERY verdict is journalled, not just disagreements. A trail that keeps
    // only disputes cannot answer "was this record ever checked, and when" —
    // which is the question an audit actually asks.
    const std::string dumped = jsn::dump(out);
    if (verify::journal().configured() && !verify::journal().append(dumped)) {
      // Never fails the response: the caller asked for a verdict and the
      // verdict is sound. But it does not pass silently either.
      sidecar_log::logErrorF("[verify]", "journal append FAILED for position %lld — %s",
                   rec.positionId, verify::journal().lastError().c_str());
    }
    return jsonRes(200, dumped);
  });

  if (!server.run()) {
    sidecar_log::logErrorF("[verify]", "bind/listen failed on :%d", port);
    return 1;
  }
  return 0;
}
