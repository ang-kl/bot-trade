// PERF-1's fourth requirement (docs/plan-ui-and-strategy-review-2026-09-26.md
// §"PERF-1, cheap layout-jump fixes"): "ScrollTrigger refreshes once after
// the data settles, not on every insertion."
//
// Verified against the vendored source (public/vendor/gsap/ScrollTrigger.min.js):
// every `ScrollTrigger.create()` — which `gsap.fromTo(el, {...}, {scrollTrigger}
// )` calls under the hood — measures and refreshes ITS OWN start/end position
// synchronously at construction (`Te.refresh()` in the constructor). That part
// is unavoidable per trigger and is not what this fixes. What GSAP does NOT do
// for you is coalesce a full-page re-measurement across triggers that get
// created at DIFFERENT times (e.g. cards inserted progressively as data
// arrives over several animation frames): each such wave schedules its own
// debounced `ScrollTrigger.refresh()` of every registered trigger
// (`_queueRefreshAll`), so a page whose reveal cards appear in bursts pays for
// a full refresh per burst instead of one full refresh after the batch has
// actually settled.
//
// Fix: wire every reveal element's tween in a single synchronous pass (so
// their individual, unavoidable self-measurements all happen back-to-back
// while the DOM is not being mutated), then schedule exactly ONE additional
// `ScrollTrigger.refresh()` for AFTER that pass and the next paint — so a
// batch of insertions costs one settle-time refresh, not one per insertion.
export function armScrollReveal(gsapInstance, ScrollTrigger, elements, opts = {}) {
  const list = elements ? Array.from(elements) : []
  if (!gsapInstance || !ScrollTrigger || list.length === 0) return
  const schedule = opts.schedule
    || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => fn())

  gsapInstance.registerPlugin(ScrollTrigger)
  for (const el of list) {
    gsapInstance.fromTo(el, { opacity: 0.3, scale: 0.985 }, {
      opacity: 1, scale: 1, duration: 0.4, ease: 'power1.out',
      scrollTrigger: { trigger: el, start: 'top 92%' },
    })
  }
  // One refresh, after every trigger above exists and the DOM has had a frame
  // to settle — not one refresh per element while the batch is still being
  // inserted.
  schedule(() => ScrollTrigger.refresh())
}
