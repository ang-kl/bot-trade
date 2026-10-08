// Codex · №12,325 · 2026-10-09; codex-footprint: real pool with controlled broker feed.
#include "../hybrid_feed.hpp"
#include <cassert>
#include <filesystem>
#include <iostream>
#include <unistd.h>
using namespace hybrid;
struct Fake: FeedHandle {
  FeedConfig config;OwnedTick tick;int& destroyed;int refreshes=0;
  Fake(const FeedConfig& c,OwnedTick cb,int& d):config(c),tick(std::move(cb)),destroyed(d){}
  ~Fake() override{destroyed++;}
  void refresh(const FeedConfig& c) override{config=c;refreshes++;}
  jsn::Value status() override{jsn::Value v(jsn::Object{});v.set("accountId",config.accountId);return v;}
};
jsn::Value account(const std::string& host,const std::string& id,const std::string& symbol,char key){
  jsn::Value s(jsn::Object{});s.set("host",host);s.set("accountId",id);s.set("symbolId",symbol);s.set("positionId","33");
  s.set("tradeId",7);s.set("side","BUY");s.set("key",std::string(64,key));s.set("trigger",120);s.set("expiresAtMs",clockMs()+90000);
  jsn::Value a(jsn::Object{});a.set("accountId",id);a.set("clientId","test");a.set("clientSecret","test");a.set("accessToken","old");a.set("plans",jsn::Array{s});return a;
}
int main(){
  for(const std::string host:{"live.ctraderapi.com","demo.ctraderapi.com"}){
    char p[]="/tmp/hybrid-feed-XXXXXX";auto path=mkdtemp(p);assert(path);int destroyed=0;
    {
      TickEngine engine(std::string(path)+"/journal");std::map<std::string,Fake*> feeds;
      FeedPool pool(engine,[&](const FeedConfig& c,OwnedTick cb){auto f=std::make_unique<Fake>(c,std::move(cb),destroyed);feeds[c.accountId]=f.get();return f;});
      jsn::Value body(jsn::Object{});body.set("host",host);body.set("accounts",jsn::Array{account(host,"42","22",'a'),account(host,"43","99",'b')});
      assert(!pool.configure(body,host=="live.ctraderapi.com"?"demo.ctraderapi.com":"live.ctraderapi.com"));assert(feeds.empty());
      assert(pool.configure(body,host));assert(feeds.size()==2);assert(feeds["42"]->config.symbols==std::vector<long long>{22});assert(feeds["43"]->config.symbols==std::vector<long long>{99});
      auto now=clockMs();feeds["43"]->tick(22,true,12000000,true,12010000,1,now,now);assert(!engine.flushOne());
      feeds["43"]->tick(99,true,12000000,true,12010000,1,now,now);assert(engine.flushOne());
      auto event=engine.events().get("events").asArray().at(0);assert(event.get("accountId").asString()=="43"&&event.get("host").asString()==host);
      auto next=account(host,"42","22",'a');next.set("accessToken","new");body.set("accounts",jsn::Array{next});
      assert(pool.configure(body,host));assert(destroyed==1);assert(feeds["42"]->refreshes==1);assert(feeds["42"]->config.accessToken=="new");
      auto bad=next;bad.set("accountId","43");body.set("accounts",jsn::Array{bad});assert(!pool.configure(body,host));assert(pool.status().asArray().size()==1);
      body.set("accounts",jsn::Array{});assert(pool.configure(body,host));assert(destroyed==2);assert(pool.status().asArray().empty());
    }
    std::filesystem::remove_all(path);
  }
  std::cout<<"live/demo owned feed routing, refresh, refusal and shutdown passed\n";
}
