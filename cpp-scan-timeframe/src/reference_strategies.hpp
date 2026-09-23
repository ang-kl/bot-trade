#pragma once
#include "backtest.hpp"
namespace tfscan {
// Closed-bar calculations only. Account admission and order authority remain
// outside this process. A null value is an evaluated no-signal result.
jsn::Value compute(const std::string& strategy, const std::vector<bt::Bar>& bars, const bt::Options& options, const jsn::Value& settings = jsn::Object{});
bool supports(const std::string& strategy);
}
