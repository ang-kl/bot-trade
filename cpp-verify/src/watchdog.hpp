#pragma once
#include "json.hpp"
#include <functional>
#include <map>
#include <mutex>
#include <thread>

namespace verify {
struct WatchPolicy {
  long long probeMs = 15000, serviceGraceMs = 60000;
  long long managementGraceMs = 60000, scannerGraceMs = 120000, noOrdersMs = 300000;
  // The repeat clock of an incident that stays active: its `serial` advances
  // once per repeatMs while it is open (a record of how long it has stood,
  // not a message schedule — nothing is sent, see `delivery` in status()).
  long long repeatMs = 3600000;
  // C·3 (03-10-2026): a single stream silent this long in an OPEN market is a
  // WARNING; feed liveness (any stream on the feed ticking within the role's
  // grace) is the urgent question. The strategy's own `quoteMaxAgeMs` (60 s
  // by default) is its gap rule, not a liveness threshold: judged per stream
  // it raised 244 urgent incidents on quiet symbols in a week.
  long long streamQuoteSilenceMs = 600000;
  jsn::Value accountGraceMs{jsn::Object{}};
};
// Pure clock-injected incident state. No broker methods and no Node database.
// The process wrapper serializes access and persists after every cycle.
//
// A RECORD, NOT A CHANNEL (owner, 03-10-2026: "remove all three"). The
// Telegram delivery this state once fed — the outbox, the modelled sender,
// the mute and its 24 h soak — never delivered a message: no credentials were
// ever set on the service, and the mute could not be lifted over a backlog
// nobody could dispose of. It is gone. What remains is the ledger: probes of
// the five services, the incidents they raise, the protection watch's
// findings and the entry-diagnostics relay, served read-only on
// GET /watchdog-status and relayed into Node's heartbeats.
class WatchState {
public:
  explicit WatchState(WatchPolicy policy = {}) : policy_(policy) {}
  // Tolerates a state file written by the build before the channel was
  // removed: its `outbox`, `delivery` and `dropped` keys are ignored, and the
  // next snapshot() carries only services and incidents (that is what
  // disposes of the backlog on the volume).
  bool restore(const jsn::Value& state);
  jsn::Value snapshot() const;
  void probe(const std::string& service, bool reachable, const jsn::Value& contract, long long now);
  void protection(const jsn::Value& report, long long now);
  void evaluate(long long now);
  jsn::Value status(long long now) const;
  long long probeIntervalMs() const { return policy_.probeMs; }
  long long serviceGraceMs() const { return policy_.serviceGraceMs; }
  // Node's entryDiagnostics from the latest valid Node contract, for the
  // relay on /watchdog-status. IN MEMORY ONLY: probe() strips the block from
  // the contract it stores, so the state file fsynced on every probe never
  // carries it (up to 32 KiB each 15 s), and restore() strips any copy an
  // older build persisted. After a restart it is absent until Node's next
  // contract arrives, and the relay says so.
  const jsn::Value& nodeEntryDiagnostics() const { return nodeEntryDiagnostics_; }
  long long nodeEntryDiagnosticsAtMs() const { return nodeEntryDiagnosticsAtMs_; }
private:
  void incident(const std::string& id, bool bad, const std::string& severity,
                const jsn::Value& detail, long long now, bool once = false);
  WatchPolicy policy_;
  std::map<std::string, jsn::Value> services_, incidents_;
  // Incidents refused by the 2,048 bound (not stored). Nothing else counts here.
  long long dropped_ = 0;
  jsn::Value nodeEntryDiagnostics_;
  long long nodeEntryDiagnosticsAtMs_ = 0;
};

class Watchdog {
public:
  explicit Watchdog(std::function<jsn::Value()> protection);
  ~Watchdog();
  void start();
  jsn::Value status();
private:
  void run(std::stop_token stop);
  bool persist();
  std::function<jsn::Value()> protection_;
  WatchState state_;
  std::mutex mutex_;
  std::jthread worker_;
  std::string path_, error_;
  bool enabled_ = false, writable_ = false;
  int lockFd_ = -1;
};
}
