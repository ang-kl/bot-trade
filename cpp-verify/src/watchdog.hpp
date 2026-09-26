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
  long long repeatMs = 3600000;
  // V3 CV-2 (OD-10): the muted soak. Not configurable from the environment:
  // a knob that shortens the soak is a knob that skips it.
  long long soakMs = 86400000;
  jsn::Value accountGraceMs{jsn::Object{}};
};
// Pure clock-injected incident state. No broker methods and no Node database.
// The process wrapper serializes access and persists BEFORE attempting delivery.
class WatchState {
public:
  explicit WatchState(WatchPolicy policy = {}) : policy_(policy) {}
  bool restore(const jsn::Value& state);
  jsn::Value snapshot() const;
  void probe(const std::string& service, bool reachable, const jsn::Value& contract, long long now);
  void protection(const jsn::Value& report, long long now);
  void evaluate(long long now);
  jsn::Value nextDelivery(long long now) const;
  // V3 CV-2 (OD-10) — the delivery gate. MUTED BY DEFAULT: a fresh state, and
  // a state restored from a build before CV-2, starts muted with a 24 h soak
  // beginning at its first beginSoak(). Delivery is open only when the soak
  // has ended AND the verifier-local mute was lifted explicitly; the soak's
  // end alone never unmutes. The run loop asks releasable(), never
  // nextDelivery(), so a muted verifier sends nothing whatever Node's policy,
  // the deployment switch or the credentials say.
  void beginSoak(long long now);
  bool deliveryOpen(long long now) const;
  jsn::Value releasable(long long now) const;
  // Returns "" when applied, else the refusal reason ("soak_active").
  std::string setMuted(bool muted, long long now);
  jsn::Value deliveryStatus(long long now) const;
  void delivery(const std::string& id, bool accepted, const std::string& messageId,
                long long retryAfterMs, long long now);
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
  void enqueue(const std::string& id, jsn::Value& record, const std::string& transition, long long now);
  WatchPolicy policy_;
  std::map<std::string, jsn::Value> services_, incidents_, outbox_;
  long long dropped_ = 0;
  bool muted_ = true;
  long long mutedAtMs_ = 0, unmutedAtMs_ = 0, soakStartedAtMs_ = 0, soakEndsAtMs_ = 0;
  // Would-send counters: every outbox item created while delivery is closed,
  // by severity — the soak's would-send rate (OD-10: urgent alerts only).
  long long wouldSendUrgent_ = 0, wouldSendWarning_ = 0, wouldSendInfo_ = 0, wouldSendSinceMs_ = 0;
  jsn::Value nodeEntryDiagnostics_;
  long long nodeEntryDiagnosticsAtMs_ = 0;
};
bool watchAllowsNotification(const jsn::Value& snapshot, const jsn::Value& delivery, long long now);
// The Telegram text for one outbox delivery. Its `blocker:` line reads the
// incident detail's `blocker` STRING — Node's entry_activity item sends it as
// a string (cpp-verify/src/tests/fixtures/node-entry-activity.json pins the
// shape from both sides).
std::string watchNotificationText(const jsn::Value& delivery, long long now);

class Watchdog {
public:
  explicit Watchdog(std::function<jsn::Value()> protection);
  ~Watchdog();
  void start();
  jsn::Value status();
  // Verifier-local mute (POST /watchdog/mute). Works with Node down. Returns
  // {ok, error?, delivery}. Unmuting is refused during the soak.
  jsn::Value setMuted(bool muted);
private:
  void run(std::stop_token stop);
  bool persist();
  std::function<jsn::Value()> protection_;
  WatchState state_;
  std::mutex mutex_;
  std::jthread worker_;
  std::string path_, error_;
  bool enabled_ = false, writable_ = false, master_ = false, owner_ = false;
  int lockFd_ = -1;
};
}
