#include "../scanner_mirror.hpp"
#include "../tick_tap.hpp"
#include <cassert>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <chrono>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
using namespace std::chrono_literals;
using Delivery = ScannerMirror::Delivery;
int main() {
  std::mutex mutex; std::condition_variable cv; bool entered=false, release=false; std::vector<jsn::Value> bodies;
  ScannerMirror mirror("demo.ctraderapi.com",11,"comparison-v1",60000,{},[&](const std::string& text){
    std::unique_lock lock(mutex); bodies.push_back(*jsn::parse(text)); entered=true;cv.notify_all();cv.wait(lock,[&]{return release;});return Delivery::Accepted;
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
    ScannerMirror broken("live.ctraderapi.com",22,"comparison-v1",60000,{},[&](const auto& text){std::lock_guard lock(m);seen.push_back(*jsn::parse(text));return seen.size()>1?Delivery::Accepted:Delivery::Rejected;});
    r.seq=1;broken.observe(r,0);
    waitFor([&]{return broken.status().get("deliveryFailures").asNumber()==1;});
    r.seq=2;broken.observe(r,0);
    waitFor([&]{return broken.status().get("delivered").asNumber()==1;});
    std::lock_guard lock(m);assert(seen.at(1).get("records").asArray().front().get("gapBefore").asBool());
    assert(seen.at(1).get("records").asArray().front().get("sourceTimestampMs").isNull());
    assert(broken.status().get("rejectedRecords").asNumber()==1);
    assert(broken.status().get("retryAttempts").asNumber()==0);
  }
  {
    std::mutex m;std::vector<std::string> seen;
    ScannerMirror retry("live.ctraderapi.com",22,"comparison-v1",60000,{},[&](const auto& text){
      std::lock_guard lock(m);seen.push_back(text);
      if(seen.size()==1)throw std::runtime_error("ambiguous transport failure");
      return seen.size()<3?Delivery::Retryable:Delivery::Accepted;
    });
    r.seq=1;retry.observe(r,900);
    waitFor([&]{return retry.status().get("retryAttempts").asNumber()>=1;});
    r.seq=2;retry.observe(r,901);
    waitFor([&]{return retry.status().get("delivered").asNumber()==2;});
    const auto s=retry.status();assert(s.get("deliveryFailures").asNumber()==0);
    assert(s.get("retryAttempts").asNumber()==2);assert(s.get("retriedRecords").asNumber()==2);
    assert(s.get("pendingRecords").asNumber()==0);assert(s.get("accepted").asNumber()==s.get("delivered").asNumber());
    std::lock_guard lock(m);assert(seen.size()==4);assert(seen[0]==seen[1]&&seen[1]==seen[2]);
    const auto later=jsn::parse(seen[3])->get("records").asArray().front();
    assert(later.get("sequence").asNumber()==2);assert(later.get("sourceSequence").asNumber()==2);
    assert(!later.get("gapBefore").asBool()); // retry is not a fabricated gap
  }
  {
    std::atomic<bool> recover{false};std::mutex m;std::vector<jsn::Value> delivered;
    ScannerMirror saturated("live.ctraderapi.com",22,"comparison-v1",60000,{},[&](const auto& text){
      if(!recover.load())return Delivery::Retryable;
      std::lock_guard lock(m);delivered.push_back(*jsn::parse(text));return Delivery::Accepted;
    },4);
    r.seq=1;saturated.observe(r,0);
    waitFor([&]{return saturated.status().get("retryExhaustedRecords").asNumber()==1;});
    auto s=saturated.status();assert(s.get("deliveryAttempts").asNumber()==ScannerMirror::maxDeliveryAttempts);
    assert(s.get("deliveryFailures").asNumber()==1);assert(s.get("delivered").asNumber()==0);
    recover.store(true);r.seq=2;saturated.observe(r,0);
    waitFor([&]{return saturated.status().get("delivered").asNumber()==1;});
    s=saturated.status();assert(s.get("accepted").asNumber()==s.get("delivered").asNumber()+s.get("deliveryFailures").asNumber());
    std::lock_guard lock(m);assert(delivered.front().get("records").asArray().front().get("gapBefore").asBool());
  }
  bool refused=false;try{ScannerMirror::httpSender("file:///etc/hosts","x");}catch(const std::invalid_argument&){refused=true;}assert(refused);
  {
    // Actual loopback HTTP: the gateway retains a 429 batch byte-for-byte,
    // then delivers later source sequences only after the acknowledgement.
    const int listener=socket(AF_INET,SOCK_STREAM,0);assert(listener>=0);
    sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    assert(bind(listener,reinterpret_cast<sockaddr*>(&address),sizeof address)==0);
    socklen_t length=sizeof address;assert(getsockname(listener,reinterpret_cast<sockaddr*>(&address),&length)==0);
    assert(listen(listener,4)==0);
    std::vector<std::string> received;
    std::jthread server([&]{
      for(const auto status:{429,202,202,403,503,408}) {
        const int client=accept(listener,nullptr,nullptr);assert(client>=0);
        timeval timeout{5,0};setsockopt(client,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof timeout);
        std::string request;char buffer[4096];size_t boundary=std::string::npos, bodySize=0;
        do {
          const auto n=recv(client,buffer,sizeof buffer,0);assert(n>0);request.append(buffer,n);
          boundary=request.find("\r\n\r\n");
          if(boundary!=std::string::npos){const auto h=request.find("Content-Length: ");assert(h!=std::string::npos);bodySize=std::stoul(request.substr(h+16));}
        } while(boundary==std::string::npos || request.size()<boundary+4+bodySize);
        received.push_back(request.substr(boundary+4,bodySize));
        const auto response="HTTP/1.1 "+std::to_string(status)+" Result\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
        assert(send(client,response.data(),response.size(),0)==static_cast<ssize_t>(response.size()));close(client);
      }
    });
    const auto sender=ScannerMirror::httpSender("http://127.0.0.1:"+std::to_string(ntohs(address.sin_port))+"/feed","fixture");
    {
      ScannerMirror http("demo.ctraderapi.com",11,"comparison-v1",60000,{},sender);
      r.seq=1;http.observe(r,900);
      waitFor([&]{return http.status().get("delivered").asNumber()==1;});
      r.seq=2;http.observe(r,901);
      waitFor([&]{return http.status().get("delivered").asNumber()==2;});
      assert(http.status().get("deliveryFailures").asNumber()==0);
      assert(http.status().get("retryAttempts").asNumber()==1);
    }
    assert(sender("{}") == Delivery::Rejected);
    assert(sender("{}") == Delivery::Retryable);
    assert(sender("{}") == Delivery::Retryable);
    server.join();close(listener);
    assert(received.size()==6);assert(received[0]==received[1]);
    assert(jsn::parse(received[2])->get("records").asArray().front().get("sequence").asNumber()==2);
  }
  std::cout<<"bounded mirror preserves feed identity/source time, gap recovery, recorder universe and quote priority\n";
}
