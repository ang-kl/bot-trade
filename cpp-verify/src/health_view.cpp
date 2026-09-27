// cpp-verify/src/health_view.cpp — see health_view.hpp.
#include "health_view.hpp"

#include <utility>

namespace health_view {

jsn::Value sessions(const std::vector<SessionRow>& rows, bool trusted) {
  jsn::Array out;
  for (const auto& r : rows) {
    jsn::Value h{jsn::Object{}};
    h.set("host", r.host);
    h.set("open", r.open);
    h.set("accountCount", static_cast<double>(r.accounts.size()));
    if (trusted) {
      jsn::Array accts;
      for (long long id : r.accounts) accts.push_back(jsn::Value(static_cast<double>(id)));
      h.set("accounts", jsn::Value(std::move(accts)));
    }
    out.push_back(std::move(h));
  }
  return jsn::Value(std::move(out));
}

} // namespace health_view
