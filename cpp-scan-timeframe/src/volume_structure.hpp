#pragma once
#include "vpo_indicators.hpp"
#include <string>
#include <utility>
namespace tfscan {
// The system's IANA transition table supplies New York's historical offset.
// Dates beyond its explicit transition coverage are refused, never guessed.
long long fxDayOpenMs(long long timeMs);
struct VolumeStructure {
  bool valid = false;
  vpo::VolumeProfileResult prev;
  long long openMs = 0;
  int sessionBars = 0;
  std::string structure, migration;
  std::vector<std::pair<double,double>> lvns;
};
VolumeStructure volumeStructure(const std::vector<bt::Bar>& bars);
bool inLowVolumeNode(double price, const std::vector<std::pair<double,double>>& nodes);
}
