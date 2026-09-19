// cpp-exec/src/tick_tap.hpp — the feed's raw-event tap into the tick
// recorder and the symbol workers, with the QUOTES-ONLY symbols excluded
// (19-09-2026, checker rounds on the fast-monitor quotes PR).
//
// WHY A GATE. The keeper now subscribes the feed to symbols it only wants
// QUOTES for (the open monitored positions, `quoteSymbolIds` on /config).
// Without this gate every subscribed symbol reached the recorder's rawTap
// and SymbolWorkers::dispatch, which has no universe filter of its own — so
// the tick record, the shadow strategy's signals and trades, and the
// tick-validation counts built on them would have been fed from symbols the
// owner never configured.
//
// AN EXCLUSION, NOT AN ADMISSION (checker round 2). The feed carries more
// than tick_symbols_json — the VPO and trail symbols, "subscribed 53
// additional symbol(s)" on the demo boot — and all of it was recorded before
// this PR. Admitting only the configured list would have NARROWED the record
// and the shadow evidence on deploy, and an empty configured list with
// recording on would have recorded nothing. So the tap drops ONLY the ids
// that are quotes-only: pushed as `quoteSymbolIds`, not in `tickSymbolIds`,
// and not already subscribed for anything else before the push. The recorded
// set is unchanged by this PR; unset (no push yet) admits everything.
//
// WHY A FILE. The tap used to be a lambda in main.cpp, which the Makefile
// excludes from every test binary — the same reason tick_segment_routes and
// spot_quote_routes exist. test_tick_tap drives this exact tap and gate.
#pragma once

#include <mutex>
#include <set>
#include <vector>

#include "spot_feed.hpp"
#include "tick_recorder.hpp"
#include "tick_workers.hpp"

namespace tick {

/** The quotes-only exclusion set. Thread-safe: written by the HTTP thread on
 *  /config, read by the feed thread per event. */
class QuoteOnlyGate {
public:
  /** One /config push. `quoteIds` = quoteSymbolIds, `tickIds` =
   *  tickSymbolIds (absent → empty), `subscribedBefore` = the feed's
   *  subscription as it stood BEFORE this push's ensureSymbols — anything in
   *  it that this gate did not itself mark quotes-only earlier was
   *  subscribed for VPO, the trail or the tick list and stays recorded.
   *  An id named in tickIds is promoted out of the exclusion. */
  void apply(const std::vector<long long>& quoteIds, const std::vector<long long>& tickIds,
             const std::vector<long long>& subscribedBefore) {
    std::lock_guard<std::mutex> lk(mtx_);
    std::set<long long> tick(tickIds.begin(), tickIds.end());
    for (long long id : tickIds) quoteOnly_.erase(id);
    for (long long id : quoteIds) {
      if (id <= 0 || tick.count(id)) continue;
      bool subscribedForElse = false;
      for (long long s : subscribedBefore) if (s == id && !quoteOnly_.count(id)) { subscribedForElse = true; break; }
      if (!subscribedForElse) quoteOnly_.insert(id);
    }
  }
  bool admits(long long symbolId) const {
    std::lock_guard<std::mutex> lk(mtx_);
    return quoteOnly_.count(symbolId) == 0;
  }
  size_t quoteOnlyCount() const { std::lock_guard<std::mutex> lk(mtx_); return quoteOnly_.size(); }

private:
  mutable std::mutex mtx_;
  std::set<long long> quoteOnly_;
};

/** The tap main.cpp installs on the feed: every ADMITTED raw event goes to
 *  the recorder (onQuote, which counts even while recording is off) and,
 *  when workers exist, to the workers as the classified observation the
 *  recorder produced. Non-owning pointers; `workers` and `gate` may be null. */
SpotRawTap makeRecorderTap(TickRecorder* rec, SymbolWorkers* workers, const QuoteOnlyGate* gate);

} // namespace tick
