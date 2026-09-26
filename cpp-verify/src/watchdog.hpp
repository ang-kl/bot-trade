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
  // restore() has no clock. beginSoak(now), called at every boot right after
  // it, is where a restored soak meets the clock: a start dated in the future
  // is rejected and the soak begins now, muted (fix-round nit 5).
  void beginSoak(long long now);
  bool deliveryOpen(long long now) const;
  jsn::Value releasable(long long now) const;
  // Returns "" when applied, else the refusal reason: "soak_active", or
  // "stale_backlog" while the outbox holds an item older than repeatMs (an
  // unmute would release it, oldest urgent first, ahead of any fresh alert;
  // disposing of it is the owner's step, never this call's).
  std::string setMuted(bool muted, long long now);
  // The mute alone, for a caller that must undo an unmute it could not persist.
  struct MuteGate { bool muted; long long mutedAtMs, unmutedAtMs; };
  MuteGate muteGate() const { return {muted_, mutedAtMs_, unmutedAtMs_}; }
  void restoreMuteGate(const MuteGate& g) { muted_ = g.muted; mutedAtMs_ = g.mutedAtMs; unmutedAtMs_ = g.unmutedAtMs; }
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
  // false when the 512-item bound refused the item (it is not stored).
  bool enqueue(const std::string& id, jsn::Value& record, const std::string& transition, long long now);
  // enqueue(), and a refusal counted once per would-send (V3 CV-2 fix round).
  void offer(const std::string& id, jsn::Value& record, const std::string& transition, long long now);
  // One message an open verifier would send for this incident now.
  void wouldSend(jsn::Value& record, long long now);
  // Outbox items created more than repeatMs before `now`: {count, oldestCreatedAtMs}.
  jsn::Value staleBacklog(long long now) const;
  WatchPolicy policy_;
  std::map<std::string, jsn::Value> services_, incidents_, outbox_;
  // Every item not stored: each refused offer (a refused incident is offered
  // again every probe cycle, and each offer counts), each eviction and each
  // incident over the 2,048 bound. A count of attempts, not of messages.
  long long dropped_ = 0;
  bool muted_ = true;
  long long mutedAtMs_ = 0, unmutedAtMs_ = 0, soakStartedAtMs_ = 0, soakEndsAtMs_ = 0;
  // Would-send counters (V3 CV-2 fix round): what an open verifier would have
  // SENT while delivery is closed, by severity — one per opened, escalated or
  // recovered transition and at most one still_active repeat per incident per
  // repeatMs. Kept on each incident's own schedule (`wouldSendAtMs`), apart
  // from the outbox: a refused item is never counted again, and an item held
  // pending by the mute does not hide the repeats an open verifier would have
  // sent. The soak's would-send rate (OD-10: urgent alerts only).
  long long wouldSendUrgent_ = 0, wouldSendWarning_ = 0, wouldSendInfo_ = 0, wouldSendSinceMs_ = 0;
  // Refusals by the 512-item bound, THROTTLED: one per would-send refused,
  // however many cycles its retry is refused again. The retry itself is not
  // delayed (lastQueuedAtMs stays untouched until an item is stored).
  long long refusedUrgent_ = 0, refusedWarning_ = 0, refusedInfo_ = 0;
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
  // {ok, applied, durable, error?, delivery}. Unmuting is refused during the
  // soak and while the outbox holds a stale backlog. ok is true only when the
  // change is applied AND persisted: a mute that cannot be persisted stays
  // applied in this process (nothing is selected for delivery) and answers
  // ok:false "state_not_durable"; an unmute that cannot be persisted is undone.
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
  // V3 CV-2 fix round: true only once start() owns the lock AND restored (or
  // created) the state. setMuted() persists only then: before it, path_ may
  // name a file this process does not own (lock held by another process) or
  // one it could not read (corrupt), and a write would overwrite it.
  bool started_ = false;
  int lockFd_ = -1;
};
}
