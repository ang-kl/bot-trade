// cpp-exec/src/tick_tap.cpp — see tick_tap.hpp.
#include "tick_tap.hpp"

#include <chrono>

namespace tick {

SpotRawTap makeRecorderTap(TickRecorder* rec, SymbolWorkers* workers, const SymbolUniverse* universe) {
  return [rec, workers, universe](long long symbolId, bool hasBid, long long bid, bool hasAsk, long long ask, long long generation) {
    if (!rec) return;
    // The gate: a symbol subscribed for quotes only never reaches the
    // record or the strategy (tick_tap.hpp).
    if (universe && !universe->admits(symbolId)) return;
    const uint64_t recvMs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
    const Record r = rec->onQuote(symbolId, hasBid, bid, hasAsk, ask, recvMs, static_cast<uint32_t>(generation));
    if (workers) {
      WorkerEvent ev;
      ev.recvMs = r.recvMs; ev.seq = r.seq; ev.symbolId = r.symbolId; ev.bid = r.bid; ev.ask = r.ask; ev.flags = r.flags;
      workers->dispatch(ev);
    }
  };
}

} // namespace tick
