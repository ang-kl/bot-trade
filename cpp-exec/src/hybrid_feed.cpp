// Codex · №12,319 · 2026-10-09; codex-footprint: native-hybrid-profit.
#include "hybrid_feed.hpp"
#include "spot_feed.hpp"
#include "http_server.hpp"
#include <set>

namespace hybrid {
namespace {
class BrokerFeed final: public FeedHandle {
public:
  BrokerFeed(const FeedConfig& c,OwnedTick callback):
    feed_(c.host,c.clientId,c.clientSecret,c.accessToken,std::stoll(c.accountId),c.symbols,[](long long,double,double){},false,true) {
    feed_.setObservedRawTap([callback](long long symbol,bool hb,long long bid,bool ha,long long ask,long long generation,long long received,long long brokerAt){callback(symbol,hb,bid,ha,ask,generation,received,brokerAt);});
    thread_=std::thread([this]{feed_.runLoop();});
  }
  ~BrokerFeed() override {feed_.stop();if(thread_.joinable())thread_.join();}
  void refresh(const FeedConfig& c) override {feed_.updateCredentials(c.clientId,c.clientSecret,c.accessToken);feed_.ensureSymbols(c.symbols);}
  jsn::Value status() override {
    jsn::Value v(jsn::Object{});v.set("accountId",std::to_string(feed_.accountId()));v.set("connected",feed_.isConnected());v.set("ticks",feed_.tickCount());v.set("lastTickAtMs",feed_.lastTickAtMs());return v;
  }
private: SpotFeed feed_;std::thread thread_;
};
}
FeedPool::FeedPool(TickEngine& engine,FeedFactory factory):engine_(engine),factory_(std::move(factory)) {
  if(!factory_)factory_=[](const FeedConfig& c,OwnedTick cb){return std::make_unique<BrokerFeed>(c,std::move(cb));};
}
bool FeedPool::configure(const jsn::Value& body,const std::string& pinnedHost){
  const auto host=body.get("host").asString();
  // A profit feed cannot silently repoint a live executor to a demo host.
  if(host.empty()||pinnedHost.empty()||host!=pinnedHost||!body.get("accounts").isArray()||body.get("accounts").asArray().size()>32)return false;
  std::map<std::string,FeedConfig> desired;jsn::Array plans;std::set<std::string> keys;
  const auto now=clockMs();
  for(const auto& a:body.get("accounts").asArray()){
    if(!positiveId(a.get("accountId"))||!a.get("plans").isArray()||a.get("plans").asArray().empty())return false;
    FeedConfig c{host,a.get("accountId").asString(),a.get("clientId").asString(),a.get("clientSecret").asString(),a.get("accessToken").asString(),{}};
    if(c.clientId.empty()||c.clientSecret.empty()||c.accessToken.empty()||desired.count(c.accountId))return false;
    std::set<long long> symbols;
    for(const auto& v:a.get("plans").asArray()){
      Spec s;long long symbol=0;
      if(!decodeSpec(v,host,now,s)||s.accountId!=c.accountId||!positiveId(v.get("symbolId"),&symbol)||!keys.insert(s.key).second)return false;
      symbols.insert(symbol);plans.push_back(v);
    }
    c.symbols.assign(symbols.begin(),symbols.end());desired.emplace(c.accountId,std::move(c));
  }
  std::lock_guard<std::mutex> lock(mutex_);
  if(!engine_.configure(jsn::Value(plans),host))return false;
  for(auto it=feeds_.begin();it!=feeds_.end();){if(!desired.count(it->first))it=feeds_.erase(it);else ++it;}
  for(const auto& [account,c]:desired){
    auto found=feeds_.find(account);
    if(found!=feeds_.end()){found->second->refresh(c);continue;}
    // Capture THIS authenticated subscription's host/account, never a shared
    // symbol-name lookup or whichever account the gateway calls primary.
    feeds_[account]=factory_(c,[this,host,accountId=std::stoll(account)](long long symbol,bool hb,long long bid,bool ha,long long ask,long long generation,long long received,long long brokerAt){engine_.onTick(host,accountId,symbol,hb,bid,ha,ask,generation,received,brokerAt);});
  }
  return true;
}
jsn::Value FeedPool::status(){std::lock_guard<std::mutex> lock(mutex_);jsn::Array a;for(const auto& [id,f]:feeds_)a.push_back(f->status());return a;}
void registerRoutes(HttpServer& server,TickEngine& engine,FeedPool& feeds,const std::string& pinnedHost){
  server.route("POST","/hybrid-profit/config",[&feeds,pinnedHost](const HttpRequest& req)->HttpResponse{
    auto body=jsn::parse(req.body);if(!body||!feeds.configure(*body,pinnedHost))return {409,"{\"error\":\"hybrid configuration or storage unavailable\"}"};
    return {200,"{\"configured\":true}"};
  });
  server.route("GET","/hybrid-profit/events",[&engine](const HttpRequest& req)->HttpResponse{
    const int wait=queryParam(req.query,"wait")=="1"?4000:0;auto out=engine.events(wait);
    return {out.get("ready").asBool()?200:503,jsn::dump(out)};
  });
  server.route("POST","/hybrid-profit/ack",[&engine](const HttpRequest& req)->HttpResponse{
    auto body=jsn::parse(req.body);if(!body||!engine.acknowledge(body->get("eventId").asString()))return {409,"{\"acknowledged\":false}"};
    return {200,"{\"acknowledged\":true}"};
  });
  server.route("GET","/hybrid-profit/status",[&engine,&feeds](const HttpRequest&)->HttpResponse{auto s=engine.status();s.set("feeds",feeds.status());return {200,jsn::dump(s)};});
}
}
