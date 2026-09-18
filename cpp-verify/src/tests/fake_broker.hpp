// cpp-exec/src/tests/fake_broker.hpp — P2b-2: a scripted local WebSocket
// broker for the async-session tests. Plain TCP on 127.0.0.1 (the engine's
// loopback transport seam), the RFC 6455 upgrade, masked client frames in,
// unmasked server frames out. The SCRIPT is the handler: it sees every text
// frame the engine sends and answers — at once, later, out of order, never —
// or pushes frames of its own (unsolicited events, id-less errors) and drops
// the connection. Test-only; nothing in src/ includes it.
#pragma once

#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "../json.hpp"
#include "../ws_client.hpp"

class FakeBroker {
public:
  using Handler = std::function<void(FakeBroker&, const jsn::Value& frame)>;

  explicit FakeBroker(Handler handler) : handler_(std::move(handler)) {
    listenFd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = 0; // ephemeral
    if (::bind(listenFd_, reinterpret_cast<sockaddr*>(&addr), sizeof addr) != 0) { port_ = -1; return; }
    socklen_t len = sizeof addr;
    getsockname(listenFd_, reinterpret_cast<sockaddr*>(&addr), &len);
    port_ = ntohs(addr.sin_port);
    ::listen(listenFd_, 4);
    acceptThread_ = std::thread([this] { acceptLoop(); });
  }

  ~FakeBroker() {
    stop_.store(true);
    dropClient();
    if (listenFd_ >= 0) { ::shutdown(listenFd_, SHUT_RDWR); ::close(listenFd_); }
    if (acceptThread_.joinable()) acceptThread_.join();
    std::vector<std::thread> delayed;
    { std::lock_guard<std::mutex> lk(delayedMtx_); delayed.swap(delayed_); }
    for (auto& t : delayed) if (t.joinable()) t.join();
  }

  int port() const { return port_; }
  int connections() const { return connections_.load(); }
  int heartbeats() const { return heartbeats_.load(); }
  bool clientConnected() const { return clientFd_.load() >= 0; }

  // Every text frame received, parsed (a copy).
  std::vector<jsn::Value> received() {
    std::lock_guard<std::mutex> lk(recvMtx_);
    return received_;
  }
  size_t receivedCount() { std::lock_guard<std::mutex> lk(recvMtx_); return received_.size(); }

  bool waitForConnection(int timeoutMs) {
    std::unique_lock<std::mutex> lk(recvMtx_);
    return recvCv_.wait_for(lk, std::chrono::milliseconds(timeoutMs), [this] { return clientFd_.load() >= 0; });
  }
  bool waitForFrames(size_t n, int timeoutMs) {
    std::unique_lock<std::mutex> lk(recvMtx_);
    return recvCv_.wait_for(lk, std::chrono::milliseconds(timeoutMs), [this, n] { return received_.size() >= n; });
  }

  // A frame to the connected client (any thread). False when nobody is connected.
  bool send(const jsn::Value& frame) { return sendText(jsn::dump(frame)); }
  bool sendText(const std::string& text) {
    std::lock_guard<std::mutex> lk(sendMtx_);
    const int fd = clientFd_.load();
    if (fd < 0) return false;
    auto bytes = wsframe::encodeFrame(wsframe::TEXT, text, nullptr); // a server frame is unmasked
    return writeAll(fd, bytes.data(), bytes.size());
  }
  void sendAfter(int delayMs, jsn::Value frame) {
    std::lock_guard<std::mutex> lk(delayedMtx_);
    delayed_.emplace_back([this, delayMs, frame = std::move(frame)] {
      std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
      if (!stop_.load()) send(frame);
    });
  }
  // The broker's reply to `req`: echoes its clientMsgId under `payloadType`.
  bool reply(const jsn::Value& req, int payloadType, jsn::Value payload) {
    return send(replyFrame(req, payloadType, std::move(payload)));
  }
  void replyAfter(int delayMs, const jsn::Value& req, int payloadType, jsn::Value payload) {
    sendAfter(delayMs, replyFrame(req, payloadType, std::move(payload)));
  }
  static jsn::Value replyFrame(const jsn::Value& req, int payloadType, jsn::Value payload) {
    jsn::Value f{jsn::Object{}};
    const std::string id = req.get("clientMsgId").asString();
    if (!id.empty()) f.set("clientMsgId", id);
    f.set("payloadType", payloadType);
    f.set("payload", std::move(payload));
    return f;
  }
  // An id-less frame the broker pushes on its own (an unsolicited event, a
  // session-level error).
  static jsn::Value pushFrame(int payloadType, jsn::Value payload) {
    jsn::Value f{jsn::Object{}};
    f.set("payloadType", payloadType);
    f.set("payload", std::move(payload));
    return f;
  }

  // The broker hangs up on the client (a half-close; the serve loop then
  // closes the descriptor). The listener stays up for a reconnect.
  void dropClient() {
    const int fd = clientFd_.load();
    if (fd >= 0) ::shutdown(fd, SHUT_RDWR);
  }

private:
  static bool writeAll(int fd, const uint8_t* data, size_t len) {
    size_t off = 0;
    while (off < len) {
      ssize_t n = ::send(fd, data + off, len - off, MSG_NOSIGNAL);
      if (n <= 0) return false;
      off += static_cast<size_t>(n);
    }
    return true;
  }

  void acceptLoop() {
    while (!stop_.load()) {
      sockaddr_in peer{};
      socklen_t plen = sizeof peer;
      int fd = ::accept(listenFd_, reinterpret_cast<sockaddr*>(&peer), &plen);
      if (fd < 0) break;
      int one = 1;
      setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
      serveClient(fd);
    }
  }

  void serveClient(int fd) {
    // HTTP upgrade.
    std::string req;
    char tmp[4096];
    while (req.find("\r\n\r\n") == std::string::npos) {
      ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
      if (n <= 0) { ::close(fd); return; }
      req.append(tmp, static_cast<size_t>(n));
    }
    std::string lower = req;
    for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    const size_t kp = lower.find("sec-websocket-key:");
    if (kp == std::string::npos) { ::close(fd); return; }
    const size_t vs = req.find(':', kp) + 1;
    const size_t ve = req.find("\r\n", vs);
    std::string key = req.substr(vs, ve - vs);
    key.erase(0, key.find_first_not_of(" \t"));
    key.erase(key.find_last_not_of(" \t") + 1);
    const std::string resp =
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Accept: " + wsAcceptFor(key) + "\r\n"
        "\r\n";
    if (!writeAll(fd, reinterpret_cast<const uint8_t*>(resp.data()), resp.size())) { ::close(fd); return; }
    {
      std::lock_guard<std::mutex> lk(recvMtx_);
      clientFd_.store(fd);
      connections_.fetch_add(1);
    }
    recvCv_.notify_all();

    std::vector<uint8_t> buf;
    bool open = true;
    while (open && !stop_.load()) {
      auto f = wsframe::decodeFrame(buf, /*fromClient=*/true);
      if (!f) {
        ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
        if (n <= 0) break;
        buf.insert(buf.end(), tmp, tmp + n);
        continue;
      }
      buf.erase(buf.begin(), buf.begin() + static_cast<long>(f->bytesConsumed));
      switch (f->opcode) {
        case wsframe::TEXT: {
          auto msg = jsn::parse(f->payload);
          if (!msg || !msg->isObject()) break;
          const int type = static_cast<int>(msg->get("payloadType").asNumber(-1));
          if (type == 51) { heartbeats_.fetch_add(1); break; }
          {
            std::lock_guard<std::mutex> lk(recvMtx_);
            received_.push_back(*msg);
          }
          recvCv_.notify_all();
          if (handler_) handler_(*this, *msg);
          break;
        }
        case wsframe::PING: {
          std::lock_guard<std::mutex> lk(sendMtx_);
          auto pong = wsframe::encodeFrame(wsframe::PONG, f->payload, nullptr);
          writeAll(fd, pong.data(), pong.size());
          break;
        }
        case wsframe::CLOSE: {
          std::lock_guard<std::mutex> lk(sendMtx_);
          auto close = wsframe::encodeFrame(wsframe::CLOSE, "", nullptr);
          writeAll(fd, close.data(), close.size());
          open = false;
          break;
        }
        default:
          open = false;
          break;
      }
    }
    {
      std::lock_guard<std::mutex> lk(sendMtx_);
      clientFd_.store(-1);
      ::close(fd);
    }
    recvCv_.notify_all();
  }

  Handler handler_;
  int listenFd_ = -1;
  int port_ = -1;
  std::atomic<bool> stop_{false};
  std::atomic<int> clientFd_{-1};
  std::atomic<int> connections_{0};
  std::atomic<int> heartbeats_{0};
  std::thread acceptThread_;
  std::mutex sendMtx_;
  std::mutex recvMtx_;
  std::condition_variable recvCv_;
  std::vector<jsn::Value> received_;
  std::mutex delayedMtx_;
  std::vector<std::thread> delayed_;
};
