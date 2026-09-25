// ---------------------------------------------------------------------------
// agent/services/boot-clock.js — ONE definition of "BOOT" (V3 M1, P1/P4-1).
//
// The V3 docs measured startup against three different origins: "Database-open
// to BOOT 70.65 s" (closure:161), "listening 7.49 s after BOOT"
// (decision-audit-startup:43-44) and "7.6 s after container start"
// (closure:116-117). A limit such as "listening within 15 s of BOOT" cannot be
// graded while BOOT means three things.
//
// BOOT is PROCESS START: `performance.timeOrigin`, the Unix-epoch millisecond
// at which this Node process began. Everything "since boot" in the boot record
// and the latency windows is measured from it — for an event happening now,
// with `performance.now()`, which is monotonic from that same origin, so a
// wall-clock step (NTP) cannot make a stamp read negative or inflated.
//
// What this origin does NOT see: the time between the container starting and
// the Node process starting (image entrypoint, npm). That gap is outside the
// process and is named as such in docs/v3-p1p4-acceptance-2026-09-25.md
// rather than folded into a number that looks like it covers it.
// ---------------------------------------------------------------------------
import { performance } from 'node:perf_hooks'

/** Unix-epoch ms at which this process started. */
export const BOOT_ORIGIN_MS = performance.timeOrigin

/** The proposed startup window (owner to confirm): BOOT to BOOT + 15 min. */
export const STARTUP_WINDOW_MS = 15 * 60_000

/** Milliseconds since BOOT, now — monotonic. */
export function sinceBootNowMs() {
  return Math.round(performance.now())
}

/** Milliseconds since BOOT for a wall-clock timestamp `atMs`. */
export function sinceBootMs(atMs, originMs = BOOT_ORIGIN_MS) {
  return Math.round(Number(atMs) - originMs)
}

/** True when `atMs` falls inside [BOOT, BOOT + windowMs]. */
export function inStartupWindow(atMs, originMs = BOOT_ORIGIN_MS, windowMs = STARTUP_WINDOW_MS) {
  const d = Number(atMs) - originMs
  return Number.isFinite(d) && d >= 0 && d <= windowMs
}
