// cpp-exec/src/event_journal.cpp — see event_journal.hpp.
#include "event_journal.hpp"

#include <chrono>
#include <random>

namespace {
long long nowMsJ() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}
std::string randomBootId() {
  std::random_device rd;
  std::mt19937_64 gen(rd());
  char buf[17];
  std::snprintf(buf, sizeof buf, "%016llx", static_cast<unsigned long long>(gen()));
  return buf;
}
constexpr int kExecutionEvent = 2126;
constexpr int kOrderErrorEvent = 2132;
constexpr int kErrorRes = 2142;
} // namespace

EventJournal::EventJournal(size_t slots, std::string bootId)
    : slots_(slots == 0 ? 1 : slots), bootId_(bootId.empty() ? randomBootId() : std::move(bootId)) {
  ring_.resize(slots_);
}

ExecutionEventRecord EventJournal::parse(const jsn::Value& frame) {
  ExecutionEventRecord r;
  r.clientMsgId = frame.get("clientMsgId").asString();
  r.payloadType = static_cast<int>(frame.get("payloadType").asNumber(0));
  const jsn::Value& p = frame.get("payload");
  r.executionType = p.get("executionType").asString();
  const jsn::Value& order = p.get("order");
  const jsn::Value& position = p.get("position");
  const auto num = [](const jsn::Value& v) { return static_cast<long long>(v.asNumber(0)); };
  r.orderId = num(order.get("orderId"));
  if (r.orderId == 0) r.orderId = num(p.get("orderId"));
  r.positionId = num(position.get("positionId"));
  if (r.positionId == 0) r.positionId = num(order.get("positionId"));
  if (r.positionId == 0) r.positionId = num(p.get("positionId"));
  r.accountId = num(p.get("ctidTraderAccountId"));
  r.symbolId = num(order.get("tradeData").get("symbolId"));
  if (r.symbolId == 0) r.symbolId = num(position.get("tradeData").get("symbolId"));
  r.errorCode = p.get("errorCode").asString();
  r.label = order.get("tradeData").get("label").asString();
  if (r.label.empty()) r.label = position.get("tradeData").get("label").asString();
  return r;
}

bool EventJournal::record(const jsn::Value& frame, bool solicited) {
  if (!frame.isObject()) return false;
  const int type = static_cast<int>(frame.get("payloadType").asNumber(0));
  if (type != kExecutionEvent && type != kOrderErrorEvent && type != kErrorRes) return false;
  ExecutionEventRecord r = parse(frame);
  r.solicited = solicited;
  r.tsMs = nowMsJ();
  std::lock_guard<std::mutex> lk(mtx_);
  r.seq = ++seq_;
  ring_[static_cast<size_t>(r.seq % static_cast<long long>(slots_))] = std::move(r);
  return true;
}

std::vector<ExecutionEventRecord> EventJournal::since(long long after) const {
  std::lock_guard<std::mutex> lk(mtx_);
  std::vector<ExecutionEventRecord> out;
  const long long oldest = seq_ > static_cast<long long>(slots_) ? seq_ - static_cast<long long>(slots_) + 1 : 1;
  for (long long s = (after + 1 > oldest ? after + 1 : oldest); s <= seq_; ++s) {
    const auto& rec = ring_[static_cast<size_t>(s % static_cast<long long>(slots_))];
    if (rec.seq == s) out.push_back(rec);
  }
  return out;
}

long long EventJournal::latestSeq() const {
  std::lock_guard<std::mutex> lk(mtx_);
  return seq_;
}

std::string EventJournal::dumpJson(long long after, const std::string& callerBootId) const {
  const long long from = callerBootId == bootId_ ? after : 0;
  jsn::Array entries;
  for (const auto& r : since(from)) {
    jsn::Value e{jsn::Object{}};
    e.set("seq", static_cast<double>(r.seq));
    e.set("tsMs", static_cast<double>(r.tsMs));
    e.set("clientMsgId", r.clientMsgId);
    e.set("payloadType", static_cast<double>(r.payloadType));
    e.set("executionType", r.executionType);
    e.set("orderId", static_cast<double>(r.orderId));
    e.set("positionId", static_cast<double>(r.positionId));
    e.set("accountId", static_cast<double>(r.accountId));
    e.set("symbolId", static_cast<double>(r.symbolId));
    e.set("errorCode", r.errorCode);
    e.set("label", r.label);
    e.set("solicited", r.solicited);
    entries.push_back(std::move(e));
  }
  jsn::Value out{jsn::Object{}};
  out.set("bootId", bootId_);
  out.set("latestSeq", static_cast<double>(latestSeq()));
  out.set("entries", jsn::Value(std::move(entries)));
  return jsn::dump(out);
}
