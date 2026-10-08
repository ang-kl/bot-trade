// Codex · №12,318 · 2026-10-09; codex-footprint: native-hybrid-profit.
#include "hybrid_tick.hpp"
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <fcntl.h>
#include <filesystem>
#include <openssl/rand.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace hybrid {
namespace {
constexpr long long maxFile = 64LL * 1024 * 1024;
constexpr size_t maxPending = 64;
bool hexKey(const std::string& s, size_t n) {
  return s.size()==n && std::all_of(s.begin(),s.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});
}
long long integer(const jsn::Value& v) {
  double n=v.asNumber(-1);
  return std::isfinite(n)&&n>0&&n<=9007199254740991.0&&std::floor(n)==n ? static_cast<long long>(n):0;
}
}
long long clockMs() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
bool positiveId(const jsn::Value& v, long long* out) {
  if (!v.isString()||v.asString().empty()||v.asString().size()>16||v.asString()[0]=='0') return false;
  long long n=0;
  for(char c:v.asString()){if(c<'0'||c>'9')return false;n=n*10+(c-'0');if(n>9007199254740991LL)return false;}
  if(n<=0)return false;
  if(out)*out=n;
  return true;
}
bool decodeSpec(const jsn::Value& v,const std::string& host,long long now,Spec& s) {
  if(host!="live.ctraderapi.com"&&host!="demo.ctraderapi.com")return false;
  if(!v.isObject()||!hexKey(v.get("key").asString(),64)||v.get("host").asString()!=host
     ||!positiveId(v.get("accountId"))||!positiveId(v.get("symbolId"))||!positiveId(v.get("positionId")))return false;
  s={v.get("key").asString(),host,v.get("accountId").asString(),v.get("symbolId").asString(),v.get("positionId").asString(),v.get("side").asString(),integer(v.get("tradeId")),integer(v.get("expiresAtMs")),v.get("trigger").asNumber(-1)};
  return (s.side=="BUY"||s.side=="SELL")&&s.tradeId>0&&s.expiresAtMs>now&&s.expiresAtMs-now<=90000&&std::isfinite(s.trigger)&&s.trigger>0;
}
TickEngine::TickEngine(std::string path,std::function<long long()> clock):path_(std::move(path)),clock_(std::move(clock)) { healthy_.store(load()); }
TickEngine::~TickEngine(){stop();if(fd_>=0)::close(fd_);}
bool TickEngine::append(const jsn::Value& record) {
  auto line=jsn::dump(record)+"\n";
  if(fd_<0||bytes_+static_cast<long long>(line.size())>maxFile){error_="journal_unavailable_or_full";healthy_=false;return false;}
  struct stat held{},named{};
  if(::fstat(fd_,&held)!=0||::lstat(path_.c_str(),&named)!=0||held.st_nlink!=1
     ||held.st_dev!=named.st_dev||held.st_ino!=named.st_ino||!S_ISREG(named.st_mode)){
    error_="journal_identity_changed";healthy_=false;return false;
  }
  size_t off=0;
  while(off<line.size()){
    auto n=::write(fd_,line.data()+off,line.size()-off);
    if(n<0&&errno==EINTR)continue;
    if(n<=0){error_="journal_write_failed";healthy_=false;return false;}
    off+=static_cast<size_t>(n);
  }
  if(::fsync(fd_)!=0){error_="journal_sync_failed";healthy_=false;return false;}
  bytes_+=static_cast<long long>(line.size());return true;
}
bool TickEngine::load() {
  fd_=::open(path_.c_str(),O_RDWR|O_APPEND|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0600);
  if(fd_<0||::flock(fd_,LOCK_EX|LOCK_NB)!=0){error_="journal_open_or_lock_failed";return false;}
  struct stat st{};
  if(::fstat(fd_,&st)!=0||!S_ISREG(st.st_mode)||st.st_size>maxFile){error_="journal_size_or_type_invalid";return false;}
  bytes_=st.st_size;
  if(bytes_==0){
    unsigned char bytes[16];if(RAND_bytes(bytes,sizeof bytes)!=1){error_="journal_identity_failed";return false;}
    constexpr char hex[]="0123456789abcdef";
    for(auto b:bytes){journalId_+=hex[b>>4];journalId_+=hex[b&15];}
    jsn::Value h(jsn::Object{});h.set("kind","header");h.set("version",1);h.set("journalId",journalId_);
    if(!append(h))return false;
    // Retain both the file entry and the new profit directory in its volume.
    const auto parent=std::filesystem::path(path_).parent_path();
    for(const auto& directory:{parent,parent.parent_path()}){
      int dir=::open(directory.c_str(),O_RDONLY|O_DIRECTORY|O_CLOEXEC);
      bool synced=dir>=0&&::fsync(dir)==0;if(dir>=0)::close(dir);
      if(!synced){error_="journal_directory_sync_failed";return false;}
    }
    return true;
  }
  std::string raw(static_cast<size_t>(bytes_),'\0');size_t off=0;
  while(off<raw.size()){auto n=::pread(fd_,raw.data()+off,raw.size()-off,off);if(n<0&&errno==EINTR)continue;if(n<=0){error_="journal_read_failed";return false;}off+=static_cast<size_t>(n);}
  if(raw.back()!='\n'){error_="journal_incomplete_tail";return false;}
  size_t pos=0;bool first=true;
  while(pos<raw.size()){
    auto end=raw.find('\n',pos);auto rec=jsn::parse(raw.substr(pos,end-pos));pos=end+1;
    if(!rec||!rec->isObject()){error_="journal_record_invalid";return false;}
    auto kind=rec->get("kind").asString();
    if(first){first=false;journalId_=rec->get("journalId").asString();if(kind!="header"||integer(rec->get("version"))!=1||!hexKey(journalId_,32)){error_="journal_header_invalid";return false;}continue;}
    if(kind=="trigger"){
      auto seq=integer(rec->get("sequence"));auto id=rec->get("eventId").asString();
      if(seq!=nextSeq_||id!=journalId_+":"+std::to_string(seq)||!hexKey(rec->get("key").asString(),64)){error_="journal_sequence_invalid";return false;}
      nextSeq_++;pending_[id]=*rec;
    } else if(kind=="ack"){
      if(integer(rec->get("atMs"))<=0||pending_.erase(rec->get("eventId").asString())!=1){error_="journal_ack_invalid";return false;}
    }
    else {error_="journal_kind_invalid";return false;}
    if(pending_.size()>maxPending){error_="journal_pending_invalid";return false;}
  }
  return true;
}
bool TickEngine::configure(const jsn::Value& values,const std::string& host){
  if(!healthy_||!values.isArray()||values.asArray().size()>64)return false;
  std::map<std::string,State> next;auto now=clock_();
  std::map<std::string,bool> ownedPositions;
  for(const auto& v:values.asArray()){
    Spec s;if(!decodeSpec(v,host,now,s)||next.count(s.key)||ownedPositions[s.accountId+":"+s.positionId])return false;
    ownedPositions[s.accountId+":"+s.positionId]=true;next.emplace(s.key,State{s,false,0});
  }
  // Always take disk before state when both are needed; the feed takes only
  // state, and the writer releases state before disk/fsync.
  std::lock_guard<std::mutex> disk(diskMtx_);
  std::lock_guard<std::mutex> state(stateMtx_);
  for(auto& [key,s]:next){
    auto old=specs_.find(key);if(old!=specs_.end()){s.pending=old->second.pending;s.eligibleAfter=old->second.eligibleAfter;}
    for(const auto& [id,e]:pending_)if(e.get("key").asString()==key)s.pending=true;
  }
  specs_=std::move(next);quotes_.clear();return true;
}
void TickEngine::onTick(const std::string& host,long long account,long long symbol,bool hasBid,long long bid,bool hasAsk,long long ask,long long generation,long long receivedAtMs,long long brokerAtMs){
  auto begin=std::chrono::steady_clock::now();auto now=clock_();
  if(!healthy_||account<=0||symbol<=0||generation<=0||receivedAtMs<=0||receivedAtMs>now||now-receivedAtMs>5000
     ||brokerAtMs<=0||brokerAtMs>now+2000||now-brokerAtMs>5000)return;
  std::lock_guard<std::mutex> lock(stateMtx_);ticks_++;
  const auto accountId=std::to_string(account),symbolId=std::to_string(symbol);
  auto& q=quotes_[host+":"+accountId+":"+symbolId];
  if(q.generation!=generation){q=Quote{};q.generation=generation;}
  if(hasBid){q.bid=bid;q.bidAt=receivedAtMs;q.bidBrokerAt=brokerAtMs;}if(hasAsk){q.ask=ask;q.askAt=receivedAtMs;q.askBrokerAt=brokerAtMs;}
  if(q.bid<=0||q.ask<q.bid||q.bidAt<=0||q.askAt<=0||now-q.bidAt>5000||now-q.askAt>5000||now-q.bidBrokerAt>5000||now-q.askBrokerAt>5000)return;
  for(auto& [key,s]:specs_){
    const auto& p=s.spec;
    if(p.host!=host||p.accountId!=accountId||p.symbolId!=symbolId||p.expiresAtMs<=now||s.pending||s.eligibleAfter>now)continue;
    const auto price=static_cast<double>(p.side=="BUY"?q.bid:q.ask)/100000.0;
    if(p.side=="BUY"?price<p.trigger:price>p.trigger)continue;
    if(queue_.size()>=maxPending){refusedQueue_++;continue;}
    auto ns=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-begin).count();
    queue_.push_back(Trigger{p,q,receivedAtMs,ns});s.pending=true;queued_++;lastDecisionNs_=ns;maxDecisionNs_=std::max(maxDecisionNs_,static_cast<long long>(ns));
  }
  workCv_.notify_one();
}
bool TickEngine::flushOne(){
  Trigger t;
  {std::lock_guard<std::mutex> lock(stateMtx_);if(queue_.empty())return false;t=queue_.front();queue_.pop_front();}
  std::lock_guard<std::mutex> disk(diskMtx_);if(!healthy_)return false;
  if(pending_.size()>=maxPending){error_="pending_capacity";healthy_=false;return false;}
  const auto& p=t.spec;jsn::Value e(jsn::Object{});
  e.set("kind","trigger");e.set("version",1);e.set("sequence",nextSeq_);e.set("eventId",journalId_+":"+std::to_string(nextSeq_));
  e.set("key",p.key);e.set("host",p.host);e.set("accountId",p.accountId);e.set("symbolId",p.symbolId);e.set("positionId",p.positionId);e.set("tradeId",p.tradeId);
  e.set("side",p.side);e.set("trigger",p.trigger);e.set("bid",static_cast<double>(t.quote.bid)/100000.0);e.set("ask",static_cast<double>(t.quote.ask)/100000.0);
  e.set("bidAtMs",t.quote.bidAt);e.set("askAtMs",t.quote.askAt);e.set("observedAtMs",std::min(t.quote.bidAt,t.quote.askAt));e.set("receivedAtMs",t.at);
  e.set("brokerAtMs",std::min(t.quote.bidBrokerAt,t.quote.askBrokerAt));e.set("bidBrokerAtMs",t.quote.bidBrokerAt);e.set("askBrokerAtMs",t.quote.askBrokerAt);
  e.set("feedGeneration",t.quote.generation);e.set("decisionNs",t.decisionNs);e.set("persistedAtMs",clock_());e.set("source","owned_native_spot_tick");
  if(!append(e))return false;
  nextSeq_++;pending_[e.get("eventId").asString()]=e;eventCv_.notify_all();return true;
}
jsn::Value TickEngine::events(int waitMs){
  std::unique_lock<std::mutex> lock(diskMtx_);
  if(pending_.empty()&&healthy_&&waitMs>0)eventCv_.wait_for(lock,std::chrono::milliseconds(std::min(waitMs,4000)),[&]{return !pending_.empty()||!healthy_;});
  jsn::Value out(jsn::Object{});jsn::Array rows;
  if(healthy_)for(const auto& [id,e]:pending_)rows.push_back(e);
  out.set("ready",healthy_.load());out.set("journalId",journalId_);out.set("events",rows);out.set("error",error_);return out;
}
bool TickEngine::acknowledge(const std::string& eventId){
  std::lock_guard<std::mutex> disk(diskMtx_);if(!healthy_)return false;
  auto it=pending_.find(eventId);if(it==pending_.end())return false;
  const auto key=it->second.get("key").asString();jsn::Value ack(jsn::Object{});ack.set("kind","ack");ack.set("eventId",eventId);ack.set("atMs",clock_());
  if(!append(ack))return false;
  pending_.erase(it);
  {std::lock_guard<std::mutex> state(stateMtx_);auto p=specs_.find(key);if(p!=specs_.end()){p->second.pending=false;p->second.eligibleAfter=clock_()+1000;}}
  return true;
}
jsn::Value TickEngine::status(){
  std::lock_guard<std::mutex> disk(diskMtx_);std::lock_guard<std::mutex> state(stateMtx_);
  jsn::Value s(jsn::Object{});s.set("ready",healthy_.load());s.set("configured",static_cast<long long>(specs_.size()));s.set("pending",static_cast<long long>(pending_.size()));
  s.set("queued",queued_);s.set("ticks",ticks_);s.set("queueRefusals",refusedQueue_);s.set("lastDecisionNs",lastDecisionNs_);s.set("maxDecisionNs",maxDecisionNs_);s.set("journalBytes",bytes_);s.set("error",error_);return s;
}
void TickEngine::start(){if(running_.exchange(true))return;worker_=std::thread([this]{while(running_){if(flushOne())continue;std::unique_lock<std::mutex> lock(stateMtx_);workCv_.wait_for(lock,std::chrono::milliseconds(100),[&]{return !running_||!queue_.empty();});}});}
void TickEngine::stop(){running_=false;workCv_.notify_all();eventCv_.notify_all();if(worker_.joinable())worker_.join();}
}
