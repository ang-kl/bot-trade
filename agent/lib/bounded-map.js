// ---------------------------------------------------------------------------
// agent/lib/bounded-map.js — a Map that cannot grow without limit.
//
// WHY (#123): four module-level Maps in fast-monitor.js are keyed by position
// id or symbol and never deleted from:
//
//   lastCheckAt   position id -> ms
//   lastPriceAt   position id -> { mid, at }
//   volCache      symbol      -> { relVol, at }
//   quoteFreeze   symbol      -> { mid, changedAt, alerted }
//
// Position ids are minted per fill and never reused, so `lastCheckAt` and
// `lastPriceAt` gain an entry for every position this process ever sees and
// lose none. On a desk opening a few hundred positions a day in a process
// that stays up for weeks, that is a slow leak with no ceiling — and worse
// than the memory is that nothing says how big they got, because a Map has no
// alarm.
//
// The symbol-keyed pair is bounded in practice by the instrument universe,
// but "bounded in practice" is a property of today's watchlist rather than of
// the code, and #166's storage work already showed how quickly this desk's
// row counts move.
//
// EVICTION IS OLDEST-FIRST, NOT A FLUSH. A cache that empties itself on
// reaching its cap loses every warm entry at once and stampedes whatever
// refills it — the exact mistake profit-keeper.js's ATR cache header warns
// about (#625). JS Maps iterate in insertion order, so the first key is the
// oldest write and evicting it is O(1) with no bookkeeping.
//
// TOUCH-ON-READ IS OPTIONAL AND OFF BY DEFAULT. Making a read count as
// recency turns this into an LRU, which is right for a cache and wrong for a
// "when did I last check this position" ledger — there, re-reading an old
// entry must not keep it alive ahead of a newer one.
// ---------------------------------------------------------------------------

export class BoundedMap {
  /**
   * @param {number} max      hard ceiling on entries
   * @param {object} [opts]
   * @param {boolean} [opts.lru]   re-insert on get, making eviction LRU rather
   *                               than insertion-order. Default false.
   * @param {string}  [opts.name]  label for diagnostics
   */
  constructor(max, { lru = false, name = 'bounded' } = {}) {
    const n = Math.floor(Number(max))
    if (!Number.isFinite(n) || n < 1) throw new Error(`BoundedMap(${name}): max must be a positive integer`)
    this.max = n
    this.lru = !!lru
    this.name = name
    this.evictions = 0
    this._m = new Map()
  }

  get size() { return this._m.size }

  has(k) { return this._m.has(k) }

  get(k) {
    if (!this.lru) return this._m.get(k)
    if (!this._m.has(k)) return undefined
    const v = this._m.get(k)
    this._m.delete(k)
    this._m.set(k, v)
    return v
  }

  set(k, v) {
    // Delete first so an UPDATE moves the key to the newest position rather
    // than leaving it at its original insertion point — otherwise a key
    // written every tick would still be evicted as "oldest".
    if (this._m.has(k)) this._m.delete(k)
    this._m.set(k, v)
    while (this._m.size > this.max) {
      const oldest = this._m.keys().next().value
      this._m.delete(oldest)
      this.evictions++
    }
    return this
  }

  delete(k) { return this._m.delete(k) }
  clear() { this._m.clear() }
  keys() { return this._m.keys() }
  values() { return this._m.values() }
  entries() { return this._m.entries() }
  [Symbol.iterator]() { return this._m[Symbol.iterator]() }

  /** What an operator needs to know: is it at its ceiling, and has it lost anything? */
  stats() {
    return { name: this.name, size: this._m.size, max: this.max, evictions: this.evictions, full: this._m.size >= this.max }
  }
}

/** Convenience for the common case. */
export const boundedMap = (max, opts) => new BoundedMap(max, opts)
