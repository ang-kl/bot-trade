// cpp-exec/src/tick_tap.hpp — the feed's raw-event tap into the tick
// recorder and the symbol workers, with the CONFIGURED universe as its gate
// (19-09-2026, checker round on the fast-monitor quotes PR).
//
// WHY A GATE. The keeper now subscribes the feed to symbols it only wants
// QUOTES for (the open monitored positions, `quoteSymbolIds` on /config).
// Without this gate every subscribed symbol reached the recorder's rawTap
// and SymbolWorkers::dispatch, which has no universe filter of its own — so
// the tick record, the shadow strategy's signals and trades, and the
// tick-validation counts built on them would have been fed from symbols the
// owner never configured. The evidence path is the configured
// `tickSymbolIds` and nothing else; a quotes-only symbol is neither recorded
// nor run through the strategy.
//
// WHY A FILE. The tap used to be a lambda in main.cpp, which the Makefile
// excludes from every test binary — the same reason tick_segment_routes and
// spot_quote_routes exist. test_tick_tap drives this exact tap.
#pragma once

#include <mutex>
#include <set>
#include <vector>

#include "spot_feed.hpp"
#include "tick_recorder.hpp"
#include "tick_workers.hpp"

namespace tick {

/** The configured tick universe. UNSET (never pushed) admits every symbol —
 *  the behaviour before the quotes-only subscriptions existed, so a sidecar
 *  the keeper has not configured yet records what it always recorded. Once
 *  set (even to an empty list), only the listed ids pass. Thread-safe:
 *  written by the HTTP thread on /config, read by the feed thread per event. */
class SymbolUniverse {
public:
  void set(const std::vector<long long>& ids) {
    std::lock_guard<std::mutex> lk(mtx_);
    ids_.clear();
    for (long long id : ids) if (id > 0) ids_.insert(id);
    configured_ = true;
  }
  bool admits(long long symbolId) const {
    std::lock_guard<std::mutex> lk(mtx_);
    return !configured_ || ids_.count(symbolId) > 0;
  }
  bool configured() const { std::lock_guard<std::mutex> lk(mtx_); return configured_; }
  size_t size() const { std::lock_guard<std::mutex> lk(mtx_); return ids_.size(); }

private:
  mutable std::mutex mtx_;
  std::set<long long> ids_;
  bool configured_ = false;
};

/** The tap main.cpp installs on the feed: every ADMITTED raw event goes to
 *  the recorder (onQuote, which counts even while recording is off) and,
 *  when workers exist, to the workers as the classified observation the
 *  recorder produced. Non-owning pointers; `workers` may be null. */
SpotRawTap makeRecorderTap(TickRecorder* rec, SymbolWorkers* workers, const SymbolUniverse* universe);

} // namespace tick
