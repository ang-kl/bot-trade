// Codex · №12,319 · 2026-10-09; codex-footprint: native-hybrid-profit.
#pragma once
#include "hybrid_tick.hpp"
#include <memory>
#include <vector>
class HttpServer;
namespace hybrid {
struct FeedConfig { std::string host, accountId, clientId, clientSecret, accessToken; std::vector<long long> symbols; };
using OwnedTick = std::function<void(long long,bool,long long,bool,long long,long long,long long,long long)>;
class FeedHandle {
public:
  virtual ~FeedHandle() = default;
  virtual void refresh(const FeedConfig&) = 0;
  virtual jsn::Value status() = 0;
};
using FeedFactory = std::function<std::unique_ptr<FeedHandle>(const FeedConfig&,OwnedTick)>;
class FeedPool {
public:
  explicit FeedPool(TickEngine& engine, FeedFactory factory = {});
  bool configure(const jsn::Value& body,const std::string& pinnedHost);
  jsn::Value status();
private:
  TickEngine& engine_;
  FeedFactory factory_;
  std::mutex mutex_;
  std::map<std::string,std::unique_ptr<FeedHandle>> feeds_;
};
void registerRoutes(HttpServer& server,TickEngine& engine,FeedPool& feeds,const std::string& pinnedHost);
}
