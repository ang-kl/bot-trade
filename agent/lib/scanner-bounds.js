// Scanner observation bounds, in one leaf module with no imports so the boot
// script, the bridge worker and the registry read the same numbers without
// loading each other.
//
// 1024 profiles: the draft from production reads is 106 tick (53 per gateway)
// plus 690 timeframe (46 legacy-scan instruments x 3 strategies x 5
// timeframes) = 796, which the old 512 refused with 'registration_bound'.
// 512 KiB: that draft is 276,080 bytes, and Express's default 100 KB parser
// refused it before the registry's own bound was ever reached.
export const SCANNER_PROFILE_LIMIT = 1024
export const SCANNER_REGISTRATION_BYTES = 512 * 1024
export const SCANNER_PROFILES_PATH = '/actions/scanner-profiles'
