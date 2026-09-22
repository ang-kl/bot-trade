#include "scanner_mirror.hpp"
#include <curl/curl.h>
#include <openssl/rand.h>
#include <chrono>
#include <map>
#include <stdexcept>
namespace {
long long clockMs() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
bool safe(const std::string& s) { return !s.empty() && s.size() <= 128 && std::all_of(s.begin(), s.end(), [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.'; }); }
std::string epoch() { unsigned char bytes[16]; if (RAND_bytes(bytes, sizeof bytes) != 1) throw std::runtime_error("mirror_epoch_unavailable"); std::string s; const char* h="0123456789abcdef"; for (auto b:bytes) { s+=h[b>>4];s+=h[b&15]; } return s; }
size_t boundedBody(char*, size_t size, size_t count, void* ptr) { const auto n=size*count; auto& used=*static_cast<size_t*>(ptr); if(n>65536-used)return 0; used+=n; return n; }
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
    for(auto& [symbol,records]:batches) {
      if(stop.stop_requested())return;
      auto body=jsn::Value(jsn::Object{{"schemaVersion",1},{"purpose","mirror"},
        {"feed",jsn::Object{{"provider","ctrader"},{"host",host_},{"accountId",account_},{"symbolId",std::to_string(symbol)}}},
        {"feedEpoch",epoch_},{"configVersion",config_},{"profileHash",profileHash_},{"profile",profile_},
        {"candidateTtlMs",ttl_},{"records",records}});
      bool ok=false;try{ok=send_(jsn::dump(body));}catch(...){/* mirror failure cannot terminate gateway */}
      if(ok){delivered_.fetch_add(records.size());lastDelivered_.store(clockMs());}
      else{failed_.fetch_add(records.size());streams[symbol].uncertain=true;}
    }
  }
}
jsn::Value ScannerMirror::status() const {
  return jsn::Value(jsn::Object{{"mode","mirror"},{"orderAuthority",false},{"feedEpoch",epoch_},
    {"accountId",account_},{"host",host_},{"configVersion",config_},{"profileHash",profileHash_},
    {"workerFailed",workerFailed_.load()},
    {"accepted",static_cast<long long>(accepted_.load())},{"consumed",static_cast<long long>(consumed_.load())},
    {"queueDrops",static_cast<long long>(dropped_.load())},{"deliveryFailures",static_cast<long long>(failed_.load())},
    {"delivered",static_cast<long long>(delivered_.load())},{"lastInputAtMs",lastInput_.load()},
    {"lastDeliveredAtMs",lastDelivered_.load()},{"queueCapacity",static_cast<long long>(queue_.capacity()-1)}});
}
ScannerMirror::Send ScannerMirror::httpSender(const std::string& url,const std::string& secret) {
  if((!url.starts_with("http://")&&!url.starts_with("https://")) || secret.empty()
      || secret.find_first_of("\r\n")!=std::string::npos)throw std::invalid_argument("mirror_endpoint_or_secret_invalid");
  static const int initialized=curl_global_init(CURL_GLOBAL_DEFAULT);
  if(initialized!=CURLE_OK || !(curl_version_info(CURLVERSION_NOW)->features&CURL_VERSION_ASYNCHDNS))throw std::runtime_error("bounded_dns_unavailable");
  return [url,secret](const std::string& body) {
    CURL* c=curl_easy_init();if(!c)return false;
    curl_slist* headers=nullptr;headers=curl_slist_append(headers,("Authorization: Bearer "+secret).c_str());headers=curl_slist_append(headers,"Content-Type: application/json");
    size_t received=0;
    curl_easy_setopt(c,CURLOPT_URL,url.c_str());curl_easy_setopt(c,CURLOPT_HTTPHEADER,headers);
    curl_easy_setopt(c,CURLOPT_POSTFIELDS,body.data());curl_easy_setopt(c,CURLOPT_POSTFIELDSIZE,static_cast<long>(body.size()));
    curl_easy_setopt(c,CURLOPT_TIMEOUT_MS,2000L);curl_easy_setopt(c,CURLOPT_CONNECTTIMEOUT_MS,1000L);curl_easy_setopt(c,CURLOPT_NOSIGNAL,1L);
    curl_easy_setopt(c,CURLOPT_FOLLOWLOCATION,0L);curl_easy_setopt(c,CURLOPT_PROTOCOLS_STR,"http,https");
    curl_easy_setopt(c,CURLOPT_WRITEFUNCTION,boundedBody);curl_easy_setopt(c,CURLOPT_WRITEDATA,&received);
    const auto rc=curl_easy_perform(c);long status=0;curl_easy_getinfo(c,CURLINFO_RESPONSE_CODE,&status);
    curl_slist_free_all(headers);curl_easy_cleanup(c);return rc==CURLE_OK&&status==202;
  };
}
