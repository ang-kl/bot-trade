// cpp-exec/src/tick_segment_routes.cpp — see tick_segment_routes.hpp.
#include "tick_segment_routes.hpp"

#include <cstdlib>

#include "json.hpp"
#include "tick_recorder.hpp"

namespace {

const char* kDisabled = "{\"enabled\":false,\"reason\":\"TICK_SPOOL_PATH not set\"}";

} // namespace

void registerTickSegmentRoutes(HttpServer& server, const std::string& spoolDir,
                               bool recorderPresent, const std::string& execSecret) {
  // BEARER REQUIRED. Mirrors /health's `trusted` computation and then
  // inverts its default: /health redacts when untrusted, this refuses.
  auto authorized = [execSecret](const HttpRequest& req) {
    if (execSecret.empty()) return false;
    auto it = req.headers.find("authorization");
    return it != req.headers.end() && it->second == "Bearer " + execSecret;
  };

  // The sealed segments, oldest first, at most kMaxListEntries (truncated
  // says so). The OPEN segment is never listed — only its byte count — which
  // is the whole point of the sealing rename: a reader must never see a torn
  // tail.
  server.route("GET", "/tick-segments", [spoolDir, recorderPresent, authorized](const HttpRequest& req) -> HttpResponse {
    if (!authorized(req)) return {401, "{\"error\":\"unauthorized\"}"};
    if (!recorderPresent) return {200, kDisabled};
    const tick::SegmentList list = tick::listSealedSegments(spoolDir);
    jsn::Value v{jsn::Object{}};
    v.set("enabled", true);
    v.set("spool", spoolDir);
    jsn::Array arr;
    for (const tick::SegmentEntry& e : list.segments) {
      jsn::Value s{jsn::Object{}};
      s.set("name", e.name);
      s.set("bytes", static_cast<double>(e.bytes));
      s.set("sealedAtMs", static_cast<double>(e.sealedAtMs));
      s.set("index", static_cast<double>(e.index));
      arr.push_back(std::move(s));
    }
    v.set("segments", jsn::Value(std::move(arr)));
    v.set("openBytes", static_cast<double>(list.openBytes));
    v.set("truncated", list.truncated);
    v.set("maxChunkBytes", static_cast<double>(tick::kMaxChunkBytes));
    return {200, jsn::dump(v)};
  });

  // One bounded range of ONE sealed segment. `len` is clamped to
  // kMaxChunkBytes (1 MiB); an offset at or past EOF is len:0, eof:true (not
  // an error). The NAME is the security boundary: anything but the
  // recorder's own sealed pattern is 400 bad_name, and a name that validates
  // but names nothing (retired between the listing and this call) is 404
  // not_found — never a partial answer dressed as the file.
  server.route("GET", "/tick-segment", [spoolDir, recorderPresent, authorized](const HttpRequest& req) -> HttpResponse {
    if (!authorized(req)) return {401, "{\"error\":\"unauthorized\"}"};
    if (!recorderPresent) return {200, kDisabled};
    const std::string name = queryParam(req.query, "name");
    const uint64_t offset = std::strtoull(queryParam(req.query, "offset", "0").c_str(), nullptr, 10);
    const std::string lenRaw = queryParam(req.query, "len", "");
    const uint64_t len = lenRaw.empty() ? tick::kMaxChunkBytes : std::strtoull(lenRaw.c_str(), nullptr, 10);
    const tick::SegmentChunk c = tick::readSegmentChunk(spoolDir, name, offset, len);
    if (c.status == tick::ChunkStatus::BAD_NAME) return {400, "{\"error\":\"bad_name\"}"};
    if (c.status == tick::ChunkStatus::NOT_FOUND) return {404, "{\"error\":\"not_found\"}"};
    jsn::Value v{jsn::Object{}};
    v.set("name", name);
    v.set("totalBytes", static_cast<double>(c.totalBytes));
    v.set("offset", static_cast<double>(c.offset));
    v.set("len", static_cast<double>(c.bytes.size()));
    v.set("eof", c.eof);
    v.set("b64", tick::base64Encode(c.bytes));
    return {200, jsn::dump(v)};
  });
}
