#include "scanner_mirror.hpp"
#include "log.hpp"
#include <curl/curl.h>
#include <openssl/rand.h>
#include <chrono>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
namespace {
long long clockMs() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
bool safe(const std::string& s) { return !s.empty() && s.size() <= 128 && std::all_of(s.begin(), s.end(), [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.'; }); }
std::string epoch() { unsigned char bytes[16]; if (RAND_bytes(bytes, sizeof bytes) != 1) throw std::runtime_error("mirror_epoch_unavailable"); std::string s; const char* h="0123456789abcdef"; for (auto b:bytes) { s+=h[b>>4];s+=h[b&15]; } return s; }
// The reply is bounded at 64 KiB as before; its first 512 bytes are kept so a
// refusal's cause can be named (the scanner's 429 body is a few dozen bytes).
struct ReplyHead { size_t used=0; std::string head; };
size_t boundedBody(char* data, size_t size, size_t count, void* ptr) {
  const auto n=size*count; auto& reply=*static_cast<ReplyHead*>(ptr); if(n>65536-reply.used)return 0; reply.used+=n;
  if(reply.head.size()<512)reply.head.append(data,std::min(n,512-reply.head.size()));
  return n;
}
}
ScannerMirror::ScannerMirror(std::string host, long long account, std::string config, long long ttl,
                            tick::StrategyParams profile, Send send, size_t queueCapacity)
  : host_(std::move(host)), account_(std::to_string(account)), config_(std::move(config)), epoch_(epoch()), ttl_(ttl),
    profile_(*jsn::parse(profile.canonicalJson())), profileHash_(profile.profileHash()), send_(std::move(send)), queue_(queueCapacity) {
  if ((host_!="demo.ctraderapi.com" && host_!="live.ctraderapi.com") || account<=0 || !safe(config_) || ttl_<1 || ttl_>3600000 || !send_)
    throw std::invalid_argument("mirror_identity_or_policy_invalid");
  worker_=std::jthread([this](std::stop_token stop){
    try { run(stop); }
    catch (...) { workerFailed_.store(true, std::memory_order_release); }
  });
}
ScannerMirror::~ScannerMirror() { worker_.request_stop(); worker_.join(); }
void ScannerMirror::observe(const tick::Record& r,long long sourceTime) noexcept {
  if(r.kind!=tick::QUOTE)return;
  if(workerFailed_.load(std::memory_order_acquire)){
    failed_.fetch_add(1,std::memory_order_relaxed);
    return;
  }
  Event e{r,sourceTime,dropped_.load(std::memory_order_relaxed)};
  lastInput_.store(r.recvMs,std::memory_order_relaxed);
  if(queue_.push(e))accepted_.fetch_add(1,std::memory_order_relaxed);
  else dropped_.fetch_add(1,std::memory_order_relaxed);
}
void ScannerMirror::run(std::stop_token stop) {
  struct Stream { uint64_t sequence=0, losses=0; bool uncertain=true; };
  std::map<uint32_t,Stream> streams;
  while(!stop.stop_requested()) {
    std::map<uint32_t,jsn::Array> batches;
    for(size_t i=0;i<256;i++) {
      const auto e=queue_.pop(); if(!e)break;
      consumed_.fetch_add(1,std::memory_order_relaxed);
      auto found=streams.find(e->record.symbolId);
      if(found==streams.end() && streams.size()>=512){failed_.fetch_add(1);continue;}
      auto& s=streams[e->record.symbolId];
      if(s.sequence>=UINT32_MAX){failed_.fetch_add(1);continue;}
      const bool gap=s.uncertain || e->losses!=s.losses; s.losses=e->losses;s.uncertain=false;
      const auto& r=e->record;
      batches[r.symbolId].push_back(jsn::Value(jsn::Object{{"sequence",static_cast<long long>(++s.sequence)},
        {"sourceSequence",static_cast<long long>(r.seq)},{"receivedAtMs",static_cast<long long>(r.recvMs)},
        {"sourceTimestampMs",e->sourceTime>0?jsn::Value(e->sourceTime):jsn::Value()},
        {"bid",(r.flags&tick::BID_PRESENT)?jsn::Value(static_cast<long long>(r.bid)):jsn::Value()},
        {"ask",(r.flags&tick::ASK_PRESENT)?jsn::Value(static_cast<long long>(r.ask)):jsn::Value()},
        {"flags",r.flags},{"gapBefore",gap}}));
    }
    if(batches.empty()){std::this_thread::sleep_for(std::chrono::milliseconds(5));continue;}
    size_t pending=0;for(const auto& [symbol,records]:batches)pending+=records.size();
    pending_.store(pending);
    for(auto& [symbol,records]:batches) {
      if(stop.stop_requested())return;
      auto body=jsn::Value(jsn::Object{{"schemaVersion",1},{"purpose","mirror"},
        {"feed",jsn::Object{{"provider","ctrader"},{"host",host_},{"accountId",account_},{"symbolId",std::to_string(symbol)}}},
        {"feedEpoch",epoch_},{"configVersion",config_},{"profileHash",profileHash_},{"profile",profile_},
        {"candidateTtlMs",ttl_},{"records",records}});
      // Keep the same bytes, epoch and sequence until delivery is acknowledged
      // or this bounded retry window ends. Do not pop later records meanwhile.
      // An ambiguous acknowledgement can be replayed: scanner admission dedupes.
      const auto payload=jsn::dump(body);
      Delivery result=Delivery::Retryable;
      for(unsigned attempt=0;attempt<maxDeliveryAttempts;++attempt) {
        if(stop.stop_requested())return;
        if(attempt){retries_.fetch_add(1);retryRecords_.fetch_add(records.size());}
        attempts_.fetch_add(1);
        try{result=send_(payload);}catch(...){result=Delivery::Retryable;}
        if(result!=Delivery::Retryable || attempt+1==maxDeliveryAttempts)break;
        // Stop-aware backoff; only this optional mirror consumer ever waits.
        for(unsigned ms=0;ms<(5u<<attempt)&&!stop.stop_requested();++ms)
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      if(result==Delivery::Accepted){delivered_.fetch_add(records.size());lastDelivered_.store(clockMs());}
      else{
        failed_.fetch_add(records.size());streams[symbol].uncertain=true;
        (result==Delivery::Retryable?exhausted_:rejected_).fetch_add(records.size());
      }
      pending_.fetch_sub(records.size());
    }
  }
}
jsn::Value ScannerMirror::status() const {
  return jsn::Value(jsn::Object{{"mode","mirror"},{"orderAuthority",false},{"feedEpoch",epoch_},
    {"accountId",account_},{"host",host_},{"configVersion",config_},{"profileHash",profileHash_},
    {"workerFailed",workerFailed_.load()},
    {"accepted",static_cast<long long>(accepted_.load())},{"consumed",static_cast<long long>(consumed_.load())},
    {"queueDrops",static_cast<long long>(dropped_.load())},{"deliveryFailures",static_cast<long long>(failed_.load())},
    {"deliveryAttempts",static_cast<long long>(attempts_.load())},{"retryAttempts",static_cast<long long>(retries_.load())},
    {"retriedRecords",static_cast<long long>(retryRecords_.load())},{"pendingRecords",static_cast<long long>(pending_.load())},
    {"retryExhaustedRecords",static_cast<long long>(exhausted_.load())},{"rejectedRecords",static_cast<long long>(rejected_.load())},
    {"maxDeliveryAttempts",static_cast<long long>(maxDeliveryAttempts)},
    {"delivered",static_cast<long long>(delivered_.load())},{"lastInputAtMs",lastInput_.load()},
    {"lastDeliveredAtMs",lastDelivered_.load()},{"queueCapacity",static_cast<long long>(queue_.capacity()-1)}});
}
std::string ScannerMirror::refusalCause(std::string_view body) {
  static constexpr std::string_view key="\"cause\":\"";
  const auto at=body.find(key); if(at==std::string_view::npos)return {};
  const auto start=at+key.size(); auto end=start;
  while(end<body.size()&&end-start<=40&&((body[end]>='a'&&body[end]<='z')||body[end]=='_'))++end;
  if(end==start||end-start>40||end>=body.size()||body[end]!='"')return {};
  return std::string(body.substr(start,end-start));
}
std::string ScannerMirror::phaseSummary(long long lookupUs,long long connectUs,long long firstByteUs,long long totalUs) {
  const auto ms=[](long long us){return std::to_string(us<0?0:us/1000);};
  return "; phases lookup "+ms(lookupUs)+" ms, connect "+ms(connectUs)+" ms, first byte "+ms(firstByteUs)+" ms, total "+ms(totalUs)+" ms";
}
ScannerMirror::Send ScannerMirror::httpSender(const std::string& url,const std::string& secret,Report report) {
  if((!url.starts_with("http://")&&!url.starts_with("https://")) || secret.empty()
      || secret.find_first_of("\r\n")!=std::string::npos)throw std::invalid_argument("mirror_endpoint_or_secret_invalid");
  static const int initialized=curl_global_init(CURL_GLOBAL_DEFAULT);
  if(initialized!=CURLE_OK || !(curl_version_info(CURLVERSION_NOW)->features&CURL_VERSION_ASYNCHDNS))throw std::runtime_error("bounded_dns_unavailable");
  struct Diagnostics { std::mutex mutex; bool reported=false, unhealthy=false; std::chrono::steady_clock::time_point last; };
  auto diagnostics=std::make_shared<Diagnostics>();
  if(!report)report=[](const std::string& message,bool recovery){
    if(recovery)sidecar_log::logInfo("[tick-scanner-mirror]",message);
    else sidecar_log::logError("[tick-scanner-mirror]",message);
  };
  // 03-10-2026 (§10,725·C·2): one handle per sender, reused. A fresh handle
  // per delivery resolved the scanner's name twice on EVERY request (about
  // 40 lookups a second per gateway in the US session, measured in the DNS
  // flow logs); a kept handle caches the answer. curl_easy_reset clears the
  // options, never the DNS cache. The sender serialises on the handle: each
  // mirror worker owns one sender, and a shared one would not corrupt it.
  struct Handle { std::mutex mutex; CURL* curl=nullptr; ~Handle(){ if(curl)curl_easy_cleanup(curl); } };
  auto handle=std::make_shared<Handle>();
  return [url,secret,report,diagnostics,handle](const std::string& body) {
    std::lock_guard keep(handle->mutex);
    if(!handle->curl)handle->curl=curl_easy_init();
    CURL* c=handle->curl;if(!c)return Delivery::Retryable;
    curl_easy_reset(c);
    curl_slist* headers=nullptr;headers=curl_slist_append(headers,("Authorization: Bearer "+secret).c_str());headers=curl_slist_append(headers,"Content-Type: application/json");
    ReplyHead received;
    curl_easy_setopt(c,CURLOPT_URL,url.c_str());curl_easy_setopt(c,CURLOPT_HTTPHEADER,headers);
    curl_easy_setopt(c,CURLOPT_POSTFIELDS,body.data());curl_easy_setopt(c,CURLOPT_POSTFIELDSIZE,static_cast<long>(body.size()));
    curl_easy_setopt(c,CURLOPT_TIMEOUT_MS,2000L);curl_easy_setopt(c,CURLOPT_CONNECTTIMEOUT_MS,1000L);curl_easy_setopt(c,CURLOPT_NOSIGNAL,1L);
    curl_easy_setopt(c,CURLOPT_FOLLOWLOCATION,0L);curl_easy_setopt(c,CURLOPT_PROTOCOLS_STR,"http,https");
    curl_easy_setopt(c,CURLOPT_WRITEFUNCTION,boundedBody);curl_easy_setopt(c,CURLOPT_WRITEDATA,&received);
    const auto rc=curl_easy_perform(c);long status=0;curl_easy_getinfo(c,CURLINFO_RESPONSE_CODE,&status);
    curl_off_t lookupUs=0,connectUs=0,firstByteUs=0,totalUs=0;
    curl_easy_getinfo(c,CURLINFO_NAMELOOKUP_TIME_T,&lookupUs);curl_easy_getinfo(c,CURLINFO_CONNECT_TIME_T,&connectUs);
    curl_easy_getinfo(c,CURLINFO_STARTTRANSFER_TIME_T,&firstByteUs);curl_easy_getinfo(c,CURLINFO_TOTAL_TIME_T,&totalUs);
    curl_slist_free_all(headers);
    // Never log the URL, headers, credentials or quote payload. Repeated
    // rejection used to be silent; at half-second ingress it must also not
    // flood the logs. Diagnostics cannot alter delivery or retry semantics.
    const bool accepted=rc==CURLE_OK&&status==202;
    std::string message;
    {
      std::lock_guard lock(diagnostics->mutex);
      const auto now=std::chrono::steady_clock::now();
      if(accepted&&diagnostics->unhealthy){message="delivery recovered (HTTP 202)";diagnostics->unhealthy=false;}
      if(!accepted&&(!diagnostics->reported||now-diagnostics->last>=std::chrono::seconds(60))){
        diagnostics->reported=true;diagnostics->unhealthy=true;diagnostics->last=now;
        message="delivery failed: HTTP "+std::to_string(status)+", transport code "+std::to_string(static_cast<int>(rc));
        if(const auto cause=refusalCause(received.head);!cause.empty())message+="; cause "+cause;
        if(status==404)message+="; verify TICK_SCANNER_MIRROR_URL targets /feed";
        message+=phaseSummary(lookupUs,connectUs,firstByteUs,totalUs);
      }
    }
    if(!message.empty()){try{report(message,accepted);}catch(...){/* diagnostics never change delivery */}}
    if(rc!=CURLE_OK)return Delivery::Retryable;
    if(status==202)return Delivery::Accepted;
    if(status==408 || status==429 || status>=500)return Delivery::Retryable;
    return Delivery::Rejected;
  };
}
