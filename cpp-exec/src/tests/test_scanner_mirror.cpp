#include "../scanner_mirror.hpp"
#include "../tick_tap.hpp"
#include <cassert>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <chrono>
using namespace std::chrono_literals;
int main() {
  std::mutex mutex; std::condition_variable cv; bool entered=false, release=false; std::vector<jsn::Value> bodies;
  ScannerMirror mirror("demo.ctraderapi.com",11,"comparison-v1",60000,{},[&](const std::string& text){
    std::unique_lock lock(mutex); bodies.push_back(*jsn::parse(text)); entered=true;cv.notify_all();cv.wait(lock,[&]{return release;});return true;
  },4);
  tick::Record r; r.kind=tick::QUOTE;r.symbolId=7;r.recvMs=1000;r.seq=1;r.bid=100;r.ask=102;r.flags=tick::BID_PRESENT|tick::ASK_PRESENT|tick::SNAPSHOT;
  mirror.observe(r,900);
  {std::unique_lock lock(mutex);assert(cv.wait_for(lock,2s,[&]{return entered;}));}
  const auto start=std::chrono::steady_clock::now();
  for(int i=2;i<=100;i++){r.seq=i;r.recvMs=1000+i;r.flags=tick::BID_PRESENT|tick::ASK_PRESENT;mirror.observe(r,0);}
  assert(std::chrono::steady_clock::now()-start<100ms); // blocked HTTP cannot stall quote ingestion
  assert(mirror.status().get("queueDrops").asNumber()>0);
  {std::lock_guard lock(mutex);release=true;}cv.notify_all();
  const auto waitFor=[&](auto pred){const auto end=std::chrono::steady_clock::now()+2s;while(!pred()&&std::chrono::steady_clock::now()<end)std::this_thread::sleep_for(1ms);assert(pred());};
  waitFor([&]{auto s=mirror.status();return s.get("consumed").asNumber()==s.get("accepted").asNumber();});
  r.seq=101;r.recvMs=1200;mirror.observe(r,1100);
  waitFor([&]{std::lock_guard lock(mutex);for(const auto& b:bodies)for(const auto& e:b.get("records").asArray())if(e.get("sourceSequence").asNumber()==101)return true;return false;});
  {std::lock_guard lock(mutex);
    assert(bodies.front().get("feed").get("accountId").asString()=="11");
    assert(bodies.front().get("records").asArray().front().get("sourceTimestampMs").asNumber()==900);
    for(const auto& b:bodies)for(const auto& e:b.get("records").asArray())if(e.get("sourceSequence").asNumber()==101)assert(e.get("gapBefore").asBool());
  }
  {
    tick::RecorderConfig config; tick::TickRecorder recorder(config); tick::QuoteOnlyGate gate;
    gate.apply({8},{7},{});int called=0;
    auto tap=tick::makeObservedRecorderTap(&recorder,nullptr,&gate,[&](const auto& rec,long long source){
      ++called;assert(rec.symbolId==7);assert(rec.recvMs==1234);assert(source==1200);assert(rec.flags&tick::SNAPSHOT);
    });
    tap(8,true,100,true,102,1,1234,1200);assert(called==0);
    tap(7,true,100,true,102,1,1234,1200);assert(called==1);
    assert(recorder.stats().events==1); // source-identical tap does not record twice
  }
  {
    std::mutex m;std::vector<jsn::Value> seen;
    ScannerMirror broken("live.ctraderapi.com",22,"comparison-v1",60000,{},[&](const auto& text){std::lock_guard lock(m);seen.push_back(*jsn::parse(text));return seen.size()>1;});
    r.seq=1;broken.observe(r,0);
    waitFor([&]{return broken.status().get("deliveryFailures").asNumber()==1;});
    r.seq=2;broken.observe(r,0);
    waitFor([&]{return broken.status().get("delivered").asNumber()==1;});
    std::lock_guard lock(m);assert(seen.at(1).get("records").asArray().front().get("gapBefore").asBool());
    assert(seen.at(1).get("records").asArray().front().get("sourceTimestampMs").isNull());
  }
  bool refused=false;try{ScannerMirror::httpSender("file:///etc/hosts","x");}catch(const std::invalid_argument&){refused=true;}assert(refused);
  std::cout<<"bounded mirror preserves feed identity/source time, gap recovery, recorder universe and quote priority\n";
}
