// cpp-exec/src/ws_client.cpp
#include "ws_client.hpp"

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>

#include <cstring>

namespace wsframe {

std::vector<uint8_t> encodeFrame(uint8_t opcode, const std::string& payload,
                                 const uint8_t maskKey[4]) {
  std::vector<uint8_t> out;
  out.reserve(payload.size() + 14);
  out.push_back(static_cast<uint8_t>(0x80 | (opcode & 0x0F))); // FIN always set
  size_t n = payload.size();
  if (n < 126) {
    out.push_back(static_cast<uint8_t>(0x80 | n));
  } else if (n <= 0xFFFF) {
    out.push_back(0x80 | 126);
    out.push_back(static_cast<uint8_t>(n >> 8));
    out.push_back(static_cast<uint8_t>(n & 0xFF));
  } else {
    out.push_back(0x80 | 127);
    for (int i = 7; i >= 0; --i)
      out.push_back(static_cast<uint8_t>((static_cast<uint64_t>(n) >> (8 * i)) & 0xFF));
  }
  out.insert(out.end(), maskKey, maskKey + 4);
  for (size_t i = 0; i < n; ++i)
    out.push_back(static_cast<uint8_t>(payload[i]) ^ maskKey[i % 4]);
  return out;
}

std::optional<Frame> decodeFrame(const std::vector<uint8_t>& buf) {
  if (buf.size() < 2) return std::nullopt;
  Frame f;
  f.fin = (buf[0] & 0x80) != 0;
  f.opcode = buf[0] & 0x0F;
  bool masked = (buf[1] & 0x80) != 0;
  uint64_t len = buf[1] & 0x7F;
  size_t pos = 2;
  if (len == 126) {
    if (buf.size() < 4) return std::nullopt;
    len = (static_cast<uint64_t>(buf[2]) << 8) | buf[3];
    pos = 4;
  } else if (len == 127) {
    if (buf.size() < 10) return std::nullopt;
    len = 0;
    for (int i = 0; i < 8; ++i) len = (len << 8) | buf[2 + i];
    pos = 10;
  }
  if ((buf[0] & 0x70) != 0 || masked) {
    // RSV bits without an extension, or a masked server frame — protocol
    // violation; signal the caller to drop the connection.
    f.opcode = 0xFF;
    f.bytesConsumed = buf.size();
    return f;
  }
  if (len > (64ull << 20)) { f.opcode = 0xFF; f.bytesConsumed = buf.size(); return f; }
  if (buf.size() < pos + len) return std::nullopt;
  f.payload.assign(reinterpret_cast<const char*>(buf.data() + pos), static_cast<size_t>(len));
  f.bytesConsumed = pos + static_cast<size_t>(len);
  return f;
}

} // namespace wsframe

static std::string base64(const uint8_t* data, size_t len) {
  std::string out;
  out.resize(4 * ((len + 2) / 3) + 1);
  int n = EVP_EncodeBlock(reinterpret_cast<unsigned char*>(out.data()), data,
                          static_cast<int>(len));
  out.resize(n > 0 ? static_cast<size_t>(n) : 0);
  return out;
}

std::string wsAcceptFor(const std::string& secWebSocketKey) {
  static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  std::string joined = secWebSocketKey + kGuid;
  uint8_t digest[SHA_DIGEST_LENGTH];
  SHA1(reinterpret_cast<const unsigned char*>(joined.data()), joined.size(), digest);
  return base64(digest, sizeof digest);
}

// ---- CtraderWs -------------------------------------------------------------

CtraderWs::~CtraderWs() { teardown(); }

void CtraderWs::teardown() {
  if (ssl_) {
    SSL_free(static_cast<SSL*>(ssl_));
    ssl_ = nullptr;
  }
  if (ctx_) {
    SSL_CTX_free(static_cast<SSL_CTX*>(ctx_));
    ctx_ = nullptr;
  }
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  open_ = false;
  buf_.clear();
}

bool CtraderWs::connect(const std::string& host, int port) {
  teardown();
  lastError_.clear();

  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  std::string portStr = std::to_string(port);
  if (getaddrinfo(host.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
    lastError_ = "dns resolve failed for " + host;
    return false;
  }
  int fd = -1;
  for (addrinfo* ai = res; ai; ai = ai->ai_next) {
    fd = ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    if (::connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
    ::close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) {
    lastError_ = "tcp connect failed";
    return false;
  }
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  fd_ = fd;

  SSL_CTX* ctx = SSL_CTX_new(TLS_client_method());
  if (!ctx) { lastError_ = "SSL_CTX_new failed"; teardown(); return false; }
  SSL_CTX_set_default_verify_paths(ctx);
  SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, nullptr);
  ctx_ = ctx;
  SSL* ssl = SSL_new(ctx);
  if (!ssl) { lastError_ = "SSL_new failed"; teardown(); return false; }
  ssl_ = ssl;
  SSL_set_fd(ssl, fd_);
  SSL_set_tlsext_host_name(ssl, host.c_str()); // SNI — cTrader hosts require it
  SSL_set1_host(ssl, host.c_str());
  if (SSL_connect(ssl) != 1) {
    lastError_ = "tls handshake failed: " +
                 std::string(ERR_reason_error_string(ERR_get_error()) ?: "unknown");
    teardown();
    return false;
  }

  // HTTP upgrade
  uint8_t keyBytes[16];
  if (RAND_bytes(keyBytes, sizeof keyBytes) != 1) {
    lastError_ = "RAND_bytes failed";
    teardown();
    return false;
  }
  std::string key = base64(keyBytes, sizeof keyBytes);
  std::string req =
      "GET / HTTP/1.1\r\n"
      "Host: " + host + ":" + portStr + "\r\n"
      "Upgrade: websocket\r\n"
      "Connection: Upgrade\r\n"
      "Sec-WebSocket-Key: " + key + "\r\n"
      "Sec-WebSocket-Version: 13\r\n"
      "\r\n";
  if (!sendRaw(reinterpret_cast<const uint8_t*>(req.data()), req.size())) {
    lastError_ = "handshake write failed";
    teardown();
    return false;
  }

  // Read until end of HTTP headers.
  std::string resp;
  while (resp.find("\r\n\r\n") == std::string::npos) {
    char tmp[2048];
    int n = SSL_read(static_cast<SSL*>(ssl_), tmp, sizeof tmp);
    if (n <= 0) { lastError_ = "handshake read failed"; teardown(); return false; }
    resp.append(tmp, static_cast<size_t>(n));
    if (resp.size() > 64 * 1024) { lastError_ = "oversized handshake response"; teardown(); return false; }
  }
  if (resp.rfind("HTTP/1.1 101", 0) != 0) {
    lastError_ = "upgrade rejected: " + resp.substr(0, resp.find("\r\n"));
    teardown();
    return false;
  }
  // Validate Sec-WebSocket-Accept (case-insensitive header scan).
  std::string lower = resp;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  size_t hp = lower.find("sec-websocket-accept:");
  if (hp == std::string::npos) { lastError_ = "missing Sec-WebSocket-Accept"; teardown(); return false; }
  size_t vs = resp.find(':', hp) + 1;
  size_t ve = resp.find("\r\n", vs);
  std::string accept = resp.substr(vs, ve - vs);
  accept.erase(0, accept.find_first_not_of(" \t"));
  accept.erase(accept.find_last_not_of(" \t") + 1);
  if (accept != wsAcceptFor(key)) {
    lastError_ = "Sec-WebSocket-Accept mismatch";
    teardown();
    return false;
  }

  size_t bodyStart = resp.find("\r\n\r\n") + 4;
  if (bodyStart < resp.size())
    buf_.assign(resp.begin() + static_cast<long>(bodyStart), resp.end());
  open_ = true;
  return true;
}

bool CtraderWs::sendRaw(const uint8_t* data, size_t len) {
  size_t off = 0;
  while (off < len) {
    int n = SSL_write(static_cast<SSL*>(ssl_), data + off, static_cast<int>(len - off));
    if (n <= 0) return false;
    off += static_cast<size_t>(n);
  }
  return true;
}

bool CtraderWs::sendFrame(uint8_t opcode, const std::string& payload) {
  if (!open_) return false;
  uint8_t mask[4];
  if (RAND_bytes(mask, sizeof mask) != 1) return false;
  auto frame = wsframe::encodeFrame(opcode, payload, mask);
  if (!sendRaw(frame.data(), frame.size())) {
    lastError_ = "frame write failed";
    open_ = false;
    return false;
  }
  return true;
}

bool CtraderWs::sendText(const std::string& text) {
  return sendFrame(wsframe::TEXT, text);
}

bool CtraderWs::fillBuffer(int timeoutMs) {
  SSL* ssl = static_cast<SSL*>(ssl_);
  // TLS may already have decrypted bytes buffered; skip select() then.
  if (SSL_pending(ssl) == 0) {
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(fd_, &rfds);
    timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
    int r = select(fd_ + 1, &rfds, nullptr, nullptr, &tv);
    if (r == 0) return false; // timeout — not an error
    if (r < 0) { lastError_ = "select failed"; open_ = false; return false; }
  }
  uint8_t tmp[8192];
  int n = SSL_read(ssl, tmp, sizeof tmp);
  if (n <= 0) {
    lastError_ = "connection closed by peer";
    open_ = false;
    return false;
  }
  buf_.insert(buf_.end(), tmp, tmp + n);
  return true;
}

std::optional<std::string> CtraderWs::recvText(int timeoutMs) {
  while (open_) {
    auto f = wsframe::decodeFrame(buf_);
    if (!f) {
      if (!fillBuffer(timeoutMs)) return std::nullopt;
      continue;
    }
    buf_.erase(buf_.begin(), buf_.begin() + static_cast<long>(f->bytesConsumed));
    switch (f->opcode) {
      case wsframe::TEXT:
        // cTrader sends single-frame JSON; fragmented text is out of scope
        // and treated as a protocol error to keep parsing honest.
        if (!f->fin) { lastError_ = "fragmented frame"; close(); return std::nullopt; }
        return f->payload;
      case wsframe::PING:
        sendFrame(wsframe::PONG, f->payload);
        continue;
      case wsframe::PONG:
        continue;
      case wsframe::CLOSE:
        sendFrame(wsframe::CLOSE, "");
        lastError_ = "close frame received";
        teardown();
        return std::nullopt;
      default:
        lastError_ = "unexpected opcode";
        teardown();
        return std::nullopt;
    }
  }
  return std::nullopt;
}

void CtraderWs::close() {
  if (open_) sendFrame(wsframe::CLOSE, "");
  teardown();
}
