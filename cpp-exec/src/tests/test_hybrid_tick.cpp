// Codex · №12,322 · 2026-10-09; codex-footprint: native-hybrid-profit.
#include "../hybrid_tick.hpp"
#include <cassert>
#include <atomic>
#include <chrono>
#include <csignal>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sys/resource.h>
#include <unistd.h>
using namespace hybrid;
const long long NOW=1791478800000LL;
struct Temp {std::string dir,path;Temp(){char p[]="/tmp/hybrid-tick-XXXXXX";auto d=mkdtemp(p);assert(d);dir=d;path=dir+"/journal";}~Temp(){std::filesystem::remove_all(dir);}};
jsn::Value spec(const std::string& host,const std::string& account="42",const std::string& symbol="22",const std::string& side="BUY",char key='a'){
  jsn::Value s(jsn::Object{});s.set("key",std::string(64,key));s.set("host",host);s.set("accountId",account);s.set("symbolId",symbol);s.set("positionId","33");s.set("tradeId",7);s.set("side",side);s.set("trigger",side=="BUY"?120:80);s.set("expiresAtMs",NOW+90000);return s;
}
void emit(TickEngine& e,const std::string& h,const std::string& side,long long account=42,long long symbol=22,long long at=NOW,long long broker=NOW){e.onTick(h,account,symbol,true,side=="BUY"?12000000:7990000,true,side=="BUY"?12010000:8000000,1,at,broker);}
int main(int argc,char** argv){
  // Optional cross-language fixture: consume an actual Node-derived spec,
  // retain an actual native trigger, and give that record to the Node reader.
  if(argc==4&&std::string(argv[1])=="--emit"){
    std::ifstream input(argv[2]);std::string raw((std::istreambuf_iterator<char>(input)),{});auto v=jsn::parse(raw);assert(v);
    const auto now=static_cast<long long>(v->get("now").asNumber());const auto s=v->get("spec");const auto host=s.get("host").asString();
    TickEngine e(argv[3],[=]{return now;});assert(e.configure(jsn::Array{s},host));
    e.onTick(host,std::stoll(s.get("accountId").asString()),std::stoll(s.get("symbolId").asString()),true,
      static_cast<long long>(v->get("bid").asNumber()*100000),true,static_cast<long long>(v->get("ask").asNumber()*100000),1,now,now);
    assert(e.flushOne());std::cout<<jsn::dump(e.events().get("events").asArray().at(0))<<"\n";return 0;
  }
  int checks=0;
  for(const std::string host:{"live.ctraderapi.com","demo.ctraderapi.com"})for(const std::string side:{"BUY","SELL"}){
    Temp t;std::string eventId;
    {
      TickEngine e(t.path,[]{return NOW;});assert(e.status().get("ready").asBool());assert(e.configure(jsn::Array{spec(host,"42","22",side)},host));
      emit(e,host,side);assert(e.events().get("events").asArray().empty()); // queued is NOT durable
      assert(e.flushOne());auto rows=e.events().get("events").asArray();assert(rows.size()==1);
      auto r=rows[0];eventId=r.get("eventId").asString();assert(r.get("accountId").asString()=="42");assert(r.get("host").asString()==host);
      assert(r.get("symbolId").asString()=="22"&&r.get("side").asString()==side);assert(r.get("brokerAtMs").asNumber()==NOW);
      emit(e,host,side);assert(!e.flushOne());assert(e.events().get("events").asArray().size()==1);
    }
    {
      TickEngine e(t.path,[]{return NOW;});assert(e.events().get("events").asArray().size()==1);
      assert(e.configure(jsn::Array{spec(host,"42","22",side)},host));emit(e,host,side);assert(!e.flushOne());
      assert(e.acknowledge(eventId));assert(e.events().get("events").asArray().empty());
    }
    {TickEngine e(t.path,[]{return NOW;});assert(e.status().get("ready").asBool());assert(e.events().get("events").asArray().empty());}
    checks++;
  }
  {
    Temp t;TickEngine e(t.path,[]{return NOW;});const std::string h="live.ctraderapi.com";
    assert(e.configure(jsn::Array{spec(h),spec(h,"43","99","BUY",'b')},h));
    emit(e,h,"BUY",43,22);emit(e,h,"BUY",42,99);emit(e,"demo.ctraderapi.com","BUY");assert(!e.flushOne());
    emit(e,h,"BUY",43,99);assert(e.flushOne());auto rows=e.events().get("events").asArray();assert(rows.size()==1&&rows[0].get("accountId").asString()=="43");checks++;
  }
  {
    Temp t;std::atomic<long long> now{NOW};TickEngine e(t.path,[&]{return now.load();});const std::string h="live.ctraderapi.com";
    assert(e.configure(jsn::Array{spec(h)},h));emit(e,h,"BUY",42,22,NOW,NOW-6000);emit(e,h,"BUY",42,22,NOW,0);emit(e,h,"BUY",42,22,NOW,NOW+3000);assert(!e.flushOne());
    e.onTick(h,42,22,true,12000000,false,0,1,NOW,NOW);assert(!e.flushOne());
    e.onTick(h,42,22,false,0,true,12010000,2,NOW,NOW);assert(!e.flushOne()); // generation cleared bid
    now=NOW+6000;e.onTick(h,42,22,true,12000000,false,0,2,now,now);assert(!e.flushOne()); // ask now stale
    e.onTick(h,42,22,false,0,true,12010000,2,now,now);assert(e.flushOne());checks++;
  }
  {
    Temp t;std::atomic<long long> now{NOW};TickEngine e(t.path,[&]{return now.load();});auto s=spec("live.ctraderapi.com");
    auto bad=s;bad.set("accountId",true);assert(!e.configure(jsn::Array{bad},"live.ctraderapi.com"));
    s=spec("live.ctraderapi.com");assert(e.configure(jsn::Array{s},"live.ctraderapi.com"));now=NOW+90001;emit(e,"live.ctraderapi.com","BUY",42,22,now,now);assert(!e.flushOne());checks++;
  }
  {
    Temp t;TickEngine e(t.dir+"/missing/journal",[]{return NOW;});assert(!e.status().get("ready").asBool());
    assert(!e.configure(jsn::Array{spec("live.ctraderapi.com")},"live.ctraderapi.com"));emit(e,"live.ctraderapi.com","BUY");assert(!e.flushOne());checks++;
  }
  {
    Temp t;struct rlimit old{},small{};assert(getrlimit(RLIMIT_FSIZE,&old)==0);
    {
      TickEngine e(t.path,[]{return NOW;});assert(e.configure(jsn::Array{spec("live.ctraderapi.com")},"live.ctraderapi.com"));
      small=old;small.rlim_cur=std::filesystem::file_size(t.path)+10;
      auto handler=std::signal(SIGXFSZ,SIG_IGN);assert(setrlimit(RLIMIT_FSIZE,&small)==0);
      emit(e,"live.ctraderapi.com","BUY");assert(!e.flushOne());assert(!e.status().get("ready").asBool());assert(e.events().get("events").asArray().empty());
      assert(setrlimit(RLIMIT_FSIZE,&old)==0);std::signal(SIGXFSZ,handler);
    }
    {TickEngine e(t.path,[]{return NOW;});assert(!e.status().get("ready").asBool());assert(e.status().get("error").asString()=="journal_incomplete_tail");}checks++;
  }
  {
    Temp t;TickEngine e(t.path,[]{return NOW;});TickEngine second(t.path,[]{return NOW;});
    assert(!second.status().get("ready").asBool());assert(e.configure(jsn::Array{spec("live.ctraderapi.com")},"live.ctraderapi.com"));
    std::filesystem::rename(t.path,t.path+".retained");std::ofstream(t.path)<<"replacement\n";
    emit(e,"live.ctraderapi.com","BUY");assert(!e.flushOne());assert(e.status().get("error").asString()=="journal_identity_changed");checks++;
  }
  {
    Temp t;{TickEngine e(t.path,[]{return NOW;});assert(e.status().get("ready").asBool());}
    std::ofstream(t.path,std::ios::app)<<"{\"kind\":\"ack\",\"eventId\":\"missing\",\"atMs\":1}\n";
    TickEngine e(t.path,[]{return NOW;});assert(!e.status().get("ready").asBool());assert(e.status().get("error").asString()=="journal_ack_invalid");checks++;
  }
  {
    Temp t;TickEngine e(t.path,[]{return NOW;});assert(e.configure(jsn::Array{spec("live.ctraderapi.com")},"live.ctraderapi.com"));e.start();
    std::thread a([&]{for(int i=0;i<2000;i++)emit(e,"live.ctraderapi.com","BUY");});
    std::thread b([&]{for(int i=0;i<2000;i++)emit(e,"live.ctraderapi.com","BUY");});
    a.join();b.join();auto rows=e.events(1000).get("events").asArray();assert(rows.size()==1);e.stop();
    auto n=rows[0].get("decisionNs").asNumber();std::cout<<"measured initial decision nanoseconds: "<<n<<" (no broker latency claim)\n";checks++;
  }
  std::cout<<checks<<" native hybrid tick/storage scenarios passed\n";
}
