#include "watchdog_http.hpp"
#include <curl/curl.h>
#include <mutex>
namespace verify {
namespace {
size_t collect(char* ptr, size_t size, size_t count, void* data) {
  auto& out = *static_cast<std::string*>(data);
  if (size && count > (256 * 1024 - out.size()) / size) return 0;
  out.append(ptr, size * count); return size * count;
}
}
WatchHttpResult watchHttp(const std::string& url, const std::string& bearer, const std::string& post, long deadlineMs) {
  WatchHttpResult result;
  static std::once_flag init;
  std::call_once(init, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
  if ((!url.starts_with("http://") && !url.starts_with("https://")) || url.size() > 2048
      || url.find_first_of("\r\n") != std::string::npos || bearer.find_first_of("\r\n") != std::string::npos
      || deadlineMs < 1 || deadlineMs > 5000 || post.size() > 16384) return result;
  CURL* curl = curl_easy_init(); if (!curl) return result;
  // A threaded or asynchronous resolver is necessary for a bounded DNS wait
  // with NOSIGNAL. Refuse an unsuitable build rather than making a false claim.
  if (!(curl_version_info(CURLVERSION_NOW)->features & CURL_VERSION_ASYNCHDNS)) { curl_easy_cleanup(curl); return result; }
  std::string body;
  curl_slist* headers = nullptr;
  if (!bearer.empty()) headers = curl_slist_append(headers, ("Authorization: Bearer " + bearer).c_str());
  if (!post.empty()) headers = curl_slist_append(headers, "Content-Type: application/json");
  curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
  curl_easy_setopt(curl, CURLOPT_PROTOCOLS_STR, "http,https");
  curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
  curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
  curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 2L);
  curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, deadlineMs);
  curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, deadlineMs);
  curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
  curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect);
  curl_easy_setopt(curl, CURLOPT_WRITEDATA, &body);
  if (!post.empty()) { curl_easy_setopt(curl, CURLOPT_POSTFIELDS, post.c_str()); curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(post.size())); }
  const auto code = curl_easy_perform(curl);
  if (code == CURLE_OK) {
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &result.status);
    result.body = jsn::parse(body).value_or(jsn::Value());
    result.received = result.status >= 200 && result.status < 300 && result.body.isObject();
  }
  curl_slist_free_all(headers); curl_easy_cleanup(curl);
  return result;
}
}
