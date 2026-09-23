#include "scanner.hpp"

namespace scan {
namespace {
tick::StrategyParams params(const jsn::Value& input) {
  if (!input.isObject()) throw std::invalid_argument("explicit_profile_required");
  tick::StrategyParams p;
  const auto whole = [&](const char* key, long long lo, long long hi) { return integer(input.get(key), lo, hi); };
  const auto real = [&](const char* key, double lo, double hi) { const auto n = input.get(key).asNumber(-1); if (!std::isfinite(n) || n < lo || n > hi) throw std::invalid_argument("invalid_profile"); return n; };
  p.rangeEvents = whole("rangeEvents", 2, 4096); p.momentumEvents = whole("momentumEvents", 1, 4096);
  p.minEfficiency = real("minEfficiency", 0, 1); p.spreadBufferMult = real("spreadBufferMult", 0, 100);
  p.confirmations = whole("confirmations", 1, 1024); p.stopVolMult = real("stopVolMult", 0, 100);
  p.minStopPrice = whole("minStopPrice", 1, 1000000000); p.priceIncrement = whole("priceIncrement", 1, 1000000000);
  p.maxSpread = whole("maxSpread", 1, 1000000000); p.maxQuoteAgeMs = whole("maxQuoteAgeMs", 1, 3600000);
  p.expiryEvents = whole("expiryEvents", 1, 1000000); p.rearmCooldownEvents = whole("rearmCooldownEvents", 0, 1000000);
  return p;
}
}
TickScanner::TickScanner(int workers, size_t queue, std::function<long long()> clock)
  : clock_(std::move(clock)), queueCapacity_(SpscRing<tick::WorkerEvent>(queue).capacity() - 1),
    pendingPerWorker_(workers > 0 ? workers : 1),
    workers_(workers, queue, [this](int, const auto& event) { consume(event); }) { workers_.start(); }
TickScanner::~TickScanner() { workers_.stop(); }
jsn::Value TickScanner::submit(const jsn::Value& batch) {
  std::unique_lock oneProducer(producer_, std::try_to_lock);
  if (!oneProducer.owns_lock()) throw std::runtime_error("ingress_busy");
  const auto ident = identity(batch); const auto p = params(batch.get("profile"));
  if (ident.profile != p.profileHash()) throw std::invalid_argument("profile_hash_mismatch");
  if (!batch.get("records").isArray() || batch.get("records").asArray().empty() || batch.get("records").asArray().size() > 512) throw std::invalid_argument("batch_bound");
  struct Input { tick::WorkerEvent event; Meta meta; };
  std::vector<Input> inputs; uint32_t previous = 0;
  const auto now = clock_();
  for (const auto& r : batch.get("records").asArray()) {
    Input in;
    in.event.seq = integer(r.get("sequence"), 1, UINT32_MAX);
    if (in.event.seq <= previous) throw std::invalid_argument("batch_out_of_order");
    previous = in.event.seq;
    in.meta.sourceSequence = integer(r.get("sourceSequence"), 1, UINT32_MAX);
    in.event.recvMs = integer(r.get("receivedAtMs"), 1, now);
    in.meta.receivedAt = in.event.recvMs;
    in.event.flags = integer(r.get("flags"), 0, 127);
    in.event.bid = r.get("bid").isNull() ? 0 : integer(r.get("bid"), 1, 1000000000000LL);
    in.event.ask = r.get("ask").isNull() ? 0 : integer(r.get("ask"), 1, 1000000000000LL);
    if (((in.event.flags & 1) != 0) != !r.get("bid").isNull() || ((in.event.flags & 2) != 0) != !r.get("ask").isNull()) throw std::invalid_argument("quote_presence_mismatch");
    in.meta.sourceTime = r.get("sourceTimestampMs");
    if (!in.meta.sourceTime.isNull()) integer(in.meta.sourceTime, 1, 9007199254740991LL);
    in.meta.gap = r.get("gapBefore").asBool(); inputs.push_back(std::move(in));
  }
  uint32_t slotId; std::shared_ptr<Slot> slot; bool newSlot = false;
  {
    std::lock_guard lock(registry_);
    auto found = ids_.find(ident.key);
    if (found == ids_.end()) {
      if (slots_.size() >= 512) throw std::runtime_error("stream_capacity; retire_or_restart_with_rewarm");
      slotId = nextId_ + 1; newSlot = true;
      slot = std::make_shared<Slot>(ident, p);
    } else { slotId = found->second; slot = slots_.at(slotId); }
  }
  size_t required = 0;
  {
    std::lock_guard lock(slot->mutex);
    if (slot->identity.ttl != ident.ttl) throw std::invalid_argument("expiry_change_requires_config_version");
    auto sourceSequence = slot->lastSourceSequence;
    for (const auto& in : inputs) if (in.event.seq > slot->lastSubmitted) {
      if (in.meta.sourceSequence <= sourceSequence) throw std::invalid_argument("source_sequence_regression_requires_epoch");
      sourceSequence = in.meta.sourceSequence; ++required;
    }
    // HTTP can refuse the entire batch for retry. Never advance identity,
    // sequence or metadata for an input the bounded worker cannot accept.
    // producer_ is held, so the consumer can only increase available space.
    if (required > queueCapacity_ - pendingPerWorker_[workers_.workerFor(slotId)].load(std::memory_order_acquire))
      throw std::runtime_error("ingress_capacity_retry_batch");
  }
  if (newSlot) {
    std::lock_guard lock(registry_);
    nextId_ = slotId; ids_[ident.key] = slotId; slots_[slotId] = slot;
  }
  pendingPerWorker_[workers_.workerFor(slotId)].fetch_add(required, std::memory_order_relaxed);
  long long accepted = 0, duplicate = 0, dropped = 0;
  for (auto& in : inputs) {
    {
      std::lock_guard lock(slot->mutex);
      if (in.event.seq <= slot->lastSubmitted) { ++duplicate; continue; }
      in.meta.gap = in.meta.gap || (slot->lastSubmitted == 0) || in.event.seq != slot->lastSubmitted + 1
        || in.meta.receivedAt < slot->lastSubmittedReceipt;
      slot->lastSubmittedReceipt = in.meta.receivedAt; slot->lastSourceSequence = in.meta.sourceSequence;
      slot->lastSubmitted = in.event.seq; slot->calendar = batch.get("calendar");
      slot->metadata[in.event.seq] = in.meta;
    }
    in.event.symbolId = slotId;
    const auto before = workers_.stats().dropped; workers_.dispatch(in.event);
    if (workers_.stats().dropped > before) { std::lock_guard lock(slot->mutex); slot->metadata.erase(in.event.seq); ++dropped; }
    else ++accepted;
  }
  return jsn::Value(jsn::Object{{"accepted", accepted}, {"duplicates", duplicate}, {"dropped", dropped}, {"orderAuthority", false}});
}
void TickScanner::consume(const tick::WorkerEvent& event) {
  struct Completion {
    std::atomic<size_t>& pending;
    ~Completion() { pending.fetch_sub(1, std::memory_order_release); }
  } completion{pendingPerWorker_[workers_.workerFor(event.symbolId)]};
  std::shared_ptr<Slot> slot;
  { std::lock_guard lock(registry_); slot = slots_.at(event.symbolId); }
  std::lock_guard lock(slot->mutex);
  auto meta = slot->metadata.at(event.seq); slot->metadata.erase(event.seq);
  tick::StrategyQuote q;
  q.seq = static_cast<uint32_t>(meta.sourceSequence); q.recvMs = event.recvMs;
  q.hasBid = event.flags & 1; q.hasAsk = event.flags & 2; q.bid = event.bid; q.ask = event.ask;
  q.snapshot = (event.flags & 16) || event.gapBefore || meta.gap; q.crossed = (event.flags & 32) || (q.hasBid && q.hasAsk && q.bid > q.ask); q.changed = !(event.flags & 64);
  if (q.snapshot) ++slot->resets;
  const auto signal = slot->strategy.onQuote(q); const auto evaluated = clock_();
  slot->lastCompleted = evaluated; slot->lastReceived = event.recvMs;
  const bool expired = static_cast<long long>(event.recvMs) + slot->identity.ttl <= evaluated;
  jsn::Value comparison(jsn::Object{{"schemaVersion", 1}, {"orderAuthority", false},
    {"feed", slot->identity.feed}, {"feedEpoch", slot->identity.epoch}, {"configVersion", slot->identity.config},
    {"profileHash", slot->identity.profile}, {"profile", *jsn::parse(slot->strategy.params().canonicalJson())},
    {"strategy", "tick_momentum_breakout"}, {"completedAtMs", evaluated}, {"receivedAtMs", static_cast<long long>(event.recvMs)},
    {"outcome", expired ? "expired" : signal ? "candidate" : "no_signal"},
    {"quote", jsn::Object{{"seq", static_cast<long long>(q.seq)}, {"recvMs", static_cast<long long>(q.recvMs)},
      {"bid", q.hasBid ? jsn::Value(static_cast<long long>(q.bid)) : jsn::Value()},
      {"ask", q.hasAsk ? jsn::Value(static_cast<long long>(q.ask)) : jsn::Value()},
      {"snapshot", q.snapshot}, {"crossed", q.crossed}, {"changed", q.changed}}}});
  if (!signal || expired) {
    if (signal && expired) ++slot->expired;
    comparisons_.push(std::move(comparison)); return;
  }
  const auto& s = *signal;
  jsn::Value result(jsn::Object{{"side", s.side}, {"directionReason", s.dirReason}, {"bid", s.bid}, {"ask", s.ask},
    {"trigger2", s.trigger2}, {"stopDistance", s.stopDistance}, {"spread", s.spread}, {"V", s.V}, {"E", s.E},
    {"D", s.D}, {"H", s.H}, {"L", s.L}, {"B", s.B}, {"setupId", s.setupId}, {"confirmations", s.confirmations}});
  comparison.set("signal", result);
  comparisons_.push(std::move(comparison));
  output_.push(candidate(slot->identity, "tick_momentum_breakout", meta.sourceSequence, event.recvMs, meta.sourceTime, evaluated, std::move(result)));
}
jsn::Value TickScanner::status() {
  jsn::Array work; const auto now = clock_();
  std::lock_guard lock(registry_);
  for (const auto& [id, slot] : slots_) {
    std::lock_guard item(slot->mutex);
    work.push_back(jsn::Value(jsn::Object{{"id", hash(slot->identity.key)}, {"role", "scanner"},
      {"accountId", slot->identity.feed.get("accountId")}, {"host", slot->identity.feed.get("host")}, {"symbolId", slot->identity.feed.get("symbolId")},
      {"calendar", slot->calendar}, {"lastCompletedAtMs", slot->lastCompleted}, {"lastQuoteAtMs", slot->lastReceived},
      {"quoteMaxAgeMs", slot->strategy.params().maxQuoteAgeMs}, {"pending", static_cast<long long>(slot->metadata.size())},
      {"nextDueMs", slot->metadata.empty() ? jsn::Value() : jsn::Value(slot->metadata.begin()->second.receivedAt)},
      {"state", slot->metadata.empty() ? "waiting_for_quote" : "queued"}, {"resets", slot->resets}, {"expiredCandidates", slot->expired}}));
  }
  const auto stats = workers_.stats();
  return jsn::Value(jsn::Object{{"schemaVersion", 1}, {"service", "cpp-scan-tick"}, {"observedAtMs", now}, {"workComplete", true}, {"work", work},
    {"processed", static_cast<long long>(stats.processed)}, {"dropped", static_cast<long long>(stats.dropped)}, {"orderAuthority", false}, {"mode", "mirror"}});
}
}
