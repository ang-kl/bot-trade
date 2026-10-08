// Codex · №12,331 · 2026-10-09; codex-footprint: actual source-clock subscription.
#include "../spot_feed.hpp"
#include "../hybrid_tick.hpp"
#include "fake_broker.hpp"
#include <cassert>
#include <filesystem>
#include <iostream>
using namespace hybrid;
int main(){
  for(bool enabled:{false,true}){
    std::atomic<int> subscriptions{0};
    FakeBroker broker([&](FakeBroker& b,const jsn::Value& f){
      auto type=f.get("payloadType").asNumber();jsn::Value reply(jsn::Object{});
      if(type==2100){b.reply(f,2101,reply);return;}
      if(type==2102){reply.set("ctidTraderAccountId",42);b.reply(f,2103,reply);return;}
      if(type!=2127)return;
      const auto& p=f.get("payload");
      assert(p.get("ctidTraderAccountId").asNumber()==42);
      if(enabled)assert(p.get("subscribeToSpotTimestamp").asBool());
      else assert(p.get("subscribeToSpotTimestamp").isNull());
      b.reply(f,2128,reply);subscriptions++;
      jsn::Value tick(jsn::Object{});tick.set("symbolId",22);tick.set("bid",12000000);tick.set("ask",12010000);
      if(enabled)tick.set("timestamp",clockMs());
      b.send(FakeBroker::pushFrame(2131,tick));
    });assert(broker.port()>0);
    char path[]="/tmp/hybrid-source-XXXXXX";assert(mkdtemp(path));
    {
      TickEngine engine(std::string(path)+"/journal");
      jsn::Value spec(jsn::Object{});spec.set("key",std::string(64,'a'));spec.set("host","live.ctraderapi.com");spec.set("accountId","42");spec.set("symbolId","22");spec.set("positionId","33");spec.set("tradeId",7);spec.set("side","BUY");spec.set("trigger",120);spec.set("expiresAtMs",clockMs()+90000);
      assert(engine.configure(jsn::Array{spec},"live.ctraderapi.com"));engine.start();
      SpotFeed feed("live.ctraderapi.com","fixture","fixture","fixture",42,{22},nullptr,false,enabled);
      feed.setLoopbackTransportForTests(broker.port());
      feed.setObservedRawTap([&](long long symbol,bool hb,long long bid,bool ha,long long ask,long long generation,long long received,long long source){engine.onTick("live.ctraderapi.com",42,symbol,hb,bid,ha,ask,generation,received,source);});
      std::thread worker([&]{feed.runLoop();});
      for(int n=0;n<500&&feed.tickCount()<1;n++)std::this_thread::sleep_for(std::chrono::milliseconds(10));
      assert(feed.tickCount()>=1);feed.ensureSymbols({99});
      for(int n=0;n<500&&subscriptions<2;n++)std::this_thread::sleep_for(std::chrono::milliseconds(10));
      assert(subscriptions>=2);
      auto events=engine.events(1000).get("events").asArray();assert(events.size()==(enabled?1:0));
      if(enabled){assert(events[0].get("brokerAtMs").asNumber()>0);assert(events[0].get("source").asString()=="owned_native_spot_tick");}
      feed.stop();worker.join();engine.stop();
    }
    std::filesystem::remove_all(path);
  }
  std::cout<<"actual initial/dynamic subscriptions opt in to source clocks; legacy wire unchanged; raw native trigger retained\n";
}
