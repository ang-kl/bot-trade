// ---------------------------------------------------------------------------
// agent/lib/strategy-prefilter-rr.js — one number, one file, no imports.
//
// It lives alone HERE rather than in services/strategies.js because that
// module builds STRATEGY_REGISTRY out of the strategy compute functions, so a
// strategy importing back from it is a cycle: the first attempt at this fix
// put the constant there and 128 tests died with "Cannot access
// STRATEGY_PREFILTER_RR before initialization". A leaf module with no imports
// of its own cannot form one.
//
// See STRATEGY_PREFILTER_RR's re-export in services/strategies.js for what the
// value means and why nine private copies of it was a defect.
// ---------------------------------------------------------------------------

export const STRATEGY_PREFILTER_RR = 1.5
