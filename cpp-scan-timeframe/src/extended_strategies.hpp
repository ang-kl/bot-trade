#pragma once
#include "backtest.hpp"
namespace tfscan {
bool supportsExtended(const std::string& strategy);
jsn::Value computeExtended(const std::string& strategy, const std::vector<bt::Bar>& bars, const bt::Options& options, const jsn::Value& settings);
}
