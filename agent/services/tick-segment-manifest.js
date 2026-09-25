// ---------------------------------------------------------------------------
// agent/services/tick-segment-manifest.js — V3 R1 (P8b): the tick segment
// manifest. Every sealed segment each sidecar lists, by NAME and BYTES, and
// what became of it, so the P8 recovery drill (T1: "every sealed segment from
// before is listed again with the same bytes") and the retention check (T2)
// can be graded from saved GET bodies. Before this, GET /state/tick-segments
// returned per-side counts only.
//
// WHERE IT RUNS. The heartbeat's sidecar probe (heartbeat.js probeOneSidecar)
// calls reconcileSegmentManifest on EVERY probe (about every 2 minutes), after
// the /tick-status pull. Not hourly: at a higher capture rate a segment lasts
// under an hour (about 53 minutes at 10x today's bytes), and a segment sealed
// and retired between two hourly listings would never be seen.
//
// HOW A VANISHED SEGMENT IS CLASSED. The recorder's retire()
// (cpp-exec/src/tick_recorder.cpp) deletes the OLDEST sealed segments while
// the sealed bytes exceed spoolCapBytes, and nothing else deletes a sealed
// segment. So a name that stops being listed is:
//   retired      — oldest-first (older than every segment that survived) AND
//                  the cap arithmetic allows it: the bytes that could have
//                  been sealed alongside it exceed the cap. Within one boot
//                  the recorder's own `retired` counter must also cover it;
//                  across a restart the counter cannot be used (it is per
//                  boot, and a retire the old boot made after its last sample
//                  died with that process — the false lost_restart the plan's
//                  first design had), so order and arithmetic decide.
//   lost_restart — gone at a restart (a new bootId) and no retire explains it.
//   unexplained  — gone within one boot and no retire explains it.
// Within one boot a name the counter does not yet cover is held PENDING for
// one probe: /tick-status is read before the listing, so a retire between the
// two reads shows in the next status.
//
// WHAT IS JUDGED. Persistence is judged against the per-side durability policy
// the owner declared (agent/config/tick-spool-durability.json): DURABLE
// (a restart must lose nothing) or EPHEMERAL_LOSS_RECORDED (losses are
// expected and recorded). With no policy in force a side reads NOT_VERIFIABLE.
// Nothing here moves an order, a limit or a gateway; it records and reports.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { getState, setState } from '../db.js'
import { listSidecarSegments, SEGMENT_NAME_RE } from './tick-segments.js'

export const GONE = Object.freeze({ RETIRED: 'retired', LOST_RESTART: 'lost_restart', UNEXPLAINED: 'unexplained' })
export const DURABILITY = Object.freeze({ DURABLE: 'DURABLE', EPHEMERAL_LOSS_RECORDED: 'EPHEMERAL_LOSS_RECORDED' })
export const VERDICT = Object.freeze({ VERIFIED: 'VERIFIED', FAILED: 'FAILED', NOT_VERIFIABLE: 'NOT_VERIFIABLE' })
export const MANIFEST_STATE_KEY = 'tick_segment_manifest_json'
export const DURABILITY_FILE = new URL('../config/tick-spool-durability.json', import.meta.url)
export const MANIFEST_SIDES = ['cpp_exec', 'cpp_exec_demo']

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const bytesOf = (s) => Number(s?.bytes) || 0
const sum = (xs) => xs.reduce((a, s) => a + bytesOf(s), 0)

/** The first record's time, from the recorder's own name: seg-<13-digit ms>-<6-digit index>.tks. */
export function segmentStartMs(name) {
  const m = /^seg-([0-9]{13})-[0-9]{6}\.tks$/.exec(String(name || ''))
  return m ? Number(m[1]) : null
}

/**
 * Class every segment that was known present and is no longer listed. Pure.
 *
 * before           the manifest's present rows [{ name, bytes }]
 * after            the sidecar's listing [{ name, bytes }] (oldest first; the
 *                  sidecar truncates to its OLDEST entries)
 * truncated        the listing said it was truncated
 * boot             'same' | 'changed' | 'unknown'
 * capBytes         { prev, cur } spoolCapBytes of the previous and current boot
 * segmentBytes     the recorder's segment size, for unseen seals
 * unseenSeals      same boot: seals the counter shows that the listing does not
 * retiredAvailable same boot: retires the counter shows that no vanished name
 *                  has been matched to yet; null when the counter is unknown
 * pendingSince     { name: ms } names already held pending at an earlier probe
 *
 * Returns { gone: [{ name, bytes, reason, detail }], pending: [{ name, since }],
 * unobserved: [name], survivors, fresh: [{ name, bytes }], retiredMatched }.
 */
export function classifyVanished({
  before = [], after = [], truncated = false, boot = 'same', capBytes = {}, segmentBytes = null,
  unseenSeals = 0, retiredAvailable = null, pendingSince = {}, nowMs = Date.now(),
} = {}) {
  const listed = [...after].sort(byName)
  const listedSet = new Set(listed.map(s => s.name))
  const lastListed = listed.length ? listed[listed.length - 1].name : null
  const prior = [...before].sort(byName)
  const priorSet = new Set(prior.map(s => s.name))
  // A truncated listing keeps the OLDEST entries (listSealedSegments): a known
  // name newer than its last entry was not looked at — neither present nor gone.
  const observable = (name) => !truncated || (lastListed != null && name <= lastListed)
  const unobserved = prior.filter(s => !observable(s.name)).map(s => s.name)
  const vanished = prior.filter(s => observable(s.name) && !listedSet.has(s.name))
  const survivors = prior.filter(s => listedSet.has(s.name))
  const fresh = listed.filter(s => !priorSet.has(s.name))
  const oldestSurvivor = survivors.length ? survivors[0].name : null

  // The cap in force when the retire ran: the one process's cap within a boot;
  // either boot's across a restart (the old boot may have retired just before
  // it died, the new one at start()).
  const caps = (boot === 'changed' ? [capBytes.prev, capBytes.cur] : [capBytes.cur ?? capBytes.prev])
    .map(num).filter(c => c != null && c > 0)
  const capMin = caps.length ? Math.min(...caps) : null
  const segMax = Math.max(num(segmentBytes) || 0, ...listed.map(bytesOf), ...prior.map(bytesOf))
  const unseenBytes = Math.max(0, num(unseenSeals) || 0) * segMax
  // Everything that could have been sealed alongside a vanished segment at
  // the moment it went: every survivor (older ones would have gone first),
  // every new segment and every seal the listing never showed.
  const baseline = sum(survivors) + sum(fresh) + unseenBytes

  // Oldest-first: retire() never removes a segment while an older sealed one
  // stays, so a vanished name newer than a survivor cannot be a retire.
  const inOrder = vanished.filter(v => oldestSurvivor == null || v.name < oldestSurvivor)
  const capAllows = new Map() // name → upper bound of sealed bytes at its retire
  let tail = 0
  for (let i = inOrder.length - 1; i >= 0; i--) {
    tail += bytesOf(inOrder[i])
    const upper = tail + baseline
    if (capMin != null && upper > capMin) capAllows.set(inOrder[i].name, upper)
  }

  const out = { gone: [], pending: [], unobserved, survivors: survivors.length, fresh, retiredMatched: 0 }
  const gone = (v, reason, detail) => out.gone.push({ name: v.name, bytes: bytesOf(v), reason, detail })
  const whyNot = (v) => {
    if (!(oldestSurvivor == null || v.name < oldestSurvivor)) return `not oldest-first: ${oldestSurvivor} is older and still listed, and a retire removes the oldest sealed segment first`
    if (capMin == null) return 'the spool cap is not reported, so no retire can be shown'
    const upper = [...inOrder].reverse().reduce((acc, x) => (x.name >= v.name ? acc + bytesOf(x) : acc), 0) + baseline
    return `at most ${upper} B could have been sealed with it, not above the ${capMin} B cap, so no retire can explain it`
  }
  let available = retiredAvailable == null ? null : Math.max(0, Number(retiredAvailable) || 0)
  for (const v of vanished) { // oldest first, the order retire() removes them in
    const upper = capAllows.get(v.name)
    if (upper != null && boot === 'same' && available != null) {
      if (available > 0) {
        available--
        out.retiredMatched++
        gone(v, GONE.RETIRED, `retired oldest-first within one boot: the recorder counted the retire, and up to ${upper} B sealed with it exceeds the ${capMin} B cap`)
      } else if (pendingSince[v.name] != null) {
        gone(v, GONE.UNEXPLAINED, `gone within one boot since ${new Date(Number(pendingSince[v.name])).toISOString()} and the recorder counted no retire for it`)
      } else {
        out.pending.push({ name: v.name, since: nowMs })
      }
    } else if (upper != null) {
      gone(v, GONE.RETIRED, boot === 'changed'
        ? `retired oldest-first across a restart: up to ${upper} B sealed with it exceeds the ${capMin} B cap (the old boot's last retires die with its counter)`
        : `retired oldest-first: up to ${upper} B sealed with it exceeds the ${capMin} B cap`)
    } else {
      gone(v, boot === 'changed' ? GONE.LOST_RESTART : GONE.UNEXPLAINED, `${boot === 'changed' ? 'gone at a restart' : 'gone within one boot'}: ${whyNot(v)}`)
    }
  }
  return out
}

function loadState(db) {
  try { return JSON.parse(getState(db, MANIFEST_STATE_KEY) || '{}') || {} } catch { return {} }
}
function saveState(db, all) {
  try { setState(db, MANIFEST_STATE_KEY, JSON.stringify(all)) } catch { /* state unwritable: the next probe retries */ }
}

/**
 * One listing of one side, reconciled into tick_segment_manifest. Never throws
 * for a sidecar that did not answer: that is recorded on the side's state.
 * `status` is the /tick-status the probe just pulled (the recorder's per-boot
 * counters and cap); `bootId` is the probe's /health bootId.
 */
export async function reconcileSegmentManifest(db, side, { status = null, bootId = null, nowMs = Date.now(), list } = {}) {
  const lister = list ?? ((base) => listSidecarSegments({ ...(base ? { base } : {}), timeoutMs: 5_000 }))
  const listing = await lister(side.base)
  const all = loadState(db)
  const stored = all[side.name] || null
  // The last GOOD listing is what a new one is compared with; a failed one
  // only stamps the error and keeps it.
  const prev = stored?.atMs != null ? stored : null
  if (!listing || listing.ok !== true) {
    all[side.name] = { ...(stored || {}), lastErrorAtMs: nowMs, lastError: String(listing?.error || 'the sidecar did not answer GET /tick-segments') }
    saveState(db, all)
    return { ok: false, error: all[side.name].lastError }
  }
  if (listing.enabled === false) {
    all[side.name] = { ...(stored || {}), lastErrorAtMs: nowMs, lastError: `recorder disabled on the sidecar: ${listing.reason || 'no TICK_SPOOL_PATH'}` }
    saveState(db, all)
    return { ok: true, enabled: false }
  }
  const seg = status?.segments || {}
  const cur = {
    bootId: bootId ? String(bootId) : null,
    retired: num(seg.retired), sealed: num(seg.sealed),
    capBytes: num(seg.spoolCapBytes), segmentBytes: num(seg.segmentBytes),
  }
  const listed = (Array.isArray(listing.segments) ? listing.segments : [])
    .filter(s => s && SEGMENT_NAME_RE.test(String(s.name || '')))
    .map(s => ({ name: String(s.name), bytes: Number(s.bytes) || 0, sealedAtMs: num(s.sealedAtMs) || null })) // listSidecarSegments turns a missing mtime into 0: stored as unknown, not 1970
  const present = db.prepare('SELECT name, bytes FROM tick_segment_manifest WHERE side = ? AND gone_at_ms IS NULL ORDER BY name').all(side.name)
  const boot = !prev
    ? (present.length ? 'unknown' : 'first')
    : (!cur.bootId || !prev.bootId) ? 'unknown' : (cur.bootId === prev.bootId ? 'same' : 'changed')
  const counters = boot === 'same' && cur.retired != null && prev.retired != null
  const accounted = counters ? (num(prev.retiredAccounted) ?? prev.retired) : null
  const pendingSince = boot === 'same' ? (prev?.pending || {}) : {}
  const presentNames = new Set(present.map(p => p.name))
  const freshCount = listed.filter(s => !presentNames.has(s.name)).length
  // Seals the recorder counted this boot that the listing never showed: they
  // were sealed and retired between two listings. Within one boot only.
  const unseenSeals = boot === 'same' && cur.sealed != null && prev.sealed != null ? Math.max(0, (cur.sealed - prev.sealed) - freshCount) : 0
  const c = boot === 'first'
    ? { gone: [], pending: [], unobserved: [], survivors: 0, fresh: listed, retiredMatched: 0 }
    : classifyVanished({
        before: present, after: listed, truncated: listing.truncated === true, boot,
        capBytes: { prev: prev?.capBytes ?? null, cur: cur.capBytes },
        segmentBytes: cur.segmentBytes ?? prev?.segmentBytes ?? null,
        unseenSeals, retiredAvailable: counters ? cur.retired - accounted : null, pendingSince, nowMs,
      })
  const listedBy = new Map(listed.map(s => [s.name, s]))
  const bytesChanged = []
  const reappeared = []
  db.transaction(() => {
    const findGone = db.prepare('SELECT gone_reason, gone_at_ms, gone_boot_id, bytes FROM tick_segment_manifest WHERE side = ? AND name = ?')
    const insert = db.prepare(`INSERT INTO tick_segment_manifest (side, name, start_ms, bytes, first_bytes, sealed_at_ms, first_seen_ms, first_boot_id, last_seen_ms, last_boot_id)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const back = db.prepare(`UPDATE tick_segment_manifest SET gone_at_ms = NULL, gone_boot_id = NULL, gone_reason = NULL, gone_detail = NULL,
                               reappeared_at_ms = ?, reappeared_from = ?, bytes = ? WHERE side = ? AND name = ?`)
    // The restart row that counted it (same boot, same listing) moves it from
    // retired / lost to reappeared, so restarts[] agrees with the manifest.
    // A segment classed within one boot has no restart row at its listing.
    const unLost = db.prepare(`UPDATE tick_segment_boots SET lost = MAX(0, lost - 1), lost_bytes = MAX(0, lost_bytes - ?),
                                 reappeared = reappeared + 1, reappeared_bytes = reappeared_bytes + ? WHERE side = ? AND boot_id = ? AND at_ms = ?`)
    const unRetired = db.prepare(`UPDATE tick_segment_boots SET retired = MAX(0, retired - 1),
                                    reappeared = reappeared + 1, reappeared_bytes = reappeared_bytes + ? WHERE side = ? AND boot_id = ? AND at_ms = ?`)
    for (const s of c.fresh) {
      const old = findGone.get(side.name, s.name)
      if (old) {
        back.run(nowMs, `${old.gone_reason} at ${new Date(Number(old.gone_at_ms)).toISOString()}`, s.bytes, side.name, s.name)
        const was = Number(old.bytes) || 0
        if (old.gone_boot_id != null && old.gone_reason === GONE.LOST_RESTART) unLost.run(was, was, side.name, old.gone_boot_id, old.gone_at_ms)
        else if (old.gone_boot_id != null && old.gone_reason === GONE.RETIRED) unRetired.run(was, side.name, old.gone_boot_id, old.gone_at_ms)
        reappeared.push(s.name)
      } else insert.run(side.name, s.name, segmentStartMs(s.name), s.bytes, s.bytes, s.sealedAtMs, nowMs, cur.bootId, nowMs, cur.bootId)
    }
    const resize = db.prepare('UPDATE tick_segment_manifest SET bytes = ? WHERE side = ? AND name = ?')
    for (const p of present) {
      const l = listedBy.get(p.name)
      if (l && l.bytes !== Number(p.bytes)) { resize.run(l.bytes, side.name, p.name); bytesChanged.push({ name: p.name, from: Number(p.bytes), to: l.bytes }) }
    }
    const markGone = db.prepare(`UPDATE tick_segment_manifest SET gone_at_ms = ?, gone_boot_id = ?, gone_reason = ?, gone_detail = ?
                                 WHERE side = ? AND name = ? AND gone_at_ms IS NULL`)
    for (const g of c.gone) markGone.run(nowMs, cur.bootId, g.reason, String(g.detail).slice(0, 500), side.name, g.name)
    db.prepare(`UPDATE tick_segment_manifest SET last_seen_ms = ?, last_boot_id = ?
                WHERE side = ? AND gone_at_ms IS NULL AND name IN (SELECT value FROM json_each(?))`)
      .run(nowMs, cur.bootId, side.name, JSON.stringify(listed.map(s => s.name)))
    if (boot === 'changed') {
      const retired = c.gone.filter(g => g.reason === GONE.RETIRED)
      const lost = c.gone.filter(g => g.reason === GONE.LOST_RESTART)
      db.prepare(`INSERT OR IGNORE INTO tick_segment_boots (side, at_ms, prev_boot_id, boot_id, prev_listing_ms, listed_before, bytes_before, survived, retired, lost, lost_bytes, bytes_changed)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(side.name, nowMs, prev.bootId, cur.bootId, num(prev.atMs), present.length - c.unobserved.length, sum(present.filter(p => !c.unobserved.includes(p.name))),
             c.survivors, retired.length, lost.length, sum(lost), bytesChanged.length)
    }
    const pending = {}
    for (const p of c.pending) pending[p.name] = pendingSince[p.name] ?? p.since
    all[side.name] = {
      atMs: nowMs, bootId: cur.bootId, retired: cur.retired, sealed: cur.sealed,
      // Retires this boot already matched to a name (or made before the
      // manifest first saw the boot, which no name can claim).
      retiredAccounted: counters ? accounted + c.retiredMatched : cur.retired,
      capBytes: cur.capBytes, segmentBytes: cur.segmentBytes,
      listed: listed.length, listedBytes: sum(listed), openBytes: num(listing.openBytes), truncated: listing.truncated === true,
      pending, boot, lastOkAtMs: nowMs, lastError: null, lastErrorAtMs: stored?.lastErrorAtMs ?? null,
    }
    saveState(db, all)
  })()
  // The Railway log is the owner's read-back path: every classed segment is named.
  for (const g of c.gone.slice(0, 5)) console.log(`[tick] ${side.name} segment ${g.name} (${g.bytes} B) gone: ${g.reason} — ${g.detail}`)
  if (c.gone.length > 5) console.log(`[tick] ${side.name} … ${c.gone.length - 5} more segment(s) gone this listing (GET /state/tick-segments names them)`)
  if (reappeared.length) console.log(`[tick] ${side.name} ${reappeared.length} segment(s) classed gone earlier are listed again and restored (${reappeared.slice(0, 3).join(', ')}${reappeared.length > 3 ? ', …' : ''})`)
  for (const b of bytesChanged) console.warn(`[tick] ${side.name} sealed segment ${b.name} changed size ${b.from} → ${b.to} B`)
  if (boot === 'changed') console.log(`[tick] ${side.name} segment manifest: restart ${prev.bootId} → ${cur.bootId}; ${c.survivors} sealed segment(s) listed again, ${c.gone.filter(g => g.reason === GONE.RETIRED).length} retired, ${c.gone.filter(g => g.reason === GONE.LOST_RESTART).length} lost`)
  return { ok: true, boot, listed: listed.length, fresh: c.fresh.length, gone: c.gone, pending: c.pending.map(p => p.name), reappeared, bytesChanged, unobserved: c.unobserved.length }
}

/** The owner's per-side durability declarations; a malformed entry is dropped and named. */
export function loadDurabilityPolicy(file = DURABILITY_FILE) {
  let raw = null
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { return { sides: {}, errors: [`durability policy unreadable: ${err?.message || err}`] } }
  const sides = {}
  const errors = []
  for (const [name, entries] of Object.entries(raw?.sides || {})) {
    sides[name] = []
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !Object.values(DURABILITY).includes(e.policy)) { errors.push(`${name}: unknown policy ${JSON.stringify(e?.policy)}`); continue }
      const fromMs = e.from == null ? null : Date.parse(e.from)
      if (e.from != null && !Number.isFinite(fromMs)) { errors.push(`${name}: unreadable from ${JSON.stringify(e.from)}`); continue }
      sides[name].push({ policy: e.policy, from: e.from ?? null, fromMs, gateway: e.gateway ?? null, basis: e.basis ?? null, pending: e.pending ?? null })
    }
  }
  return { sides, errors }
}

/** The declaration in force at `atMs`: the latest `from` at or before it. */
export function policyAt(entries = [], atMs = Date.now()) {
  let best = null
  for (const e of entries) if (e.fromMs != null && e.fromMs <= atMs && (!best || e.fromMs > best.fromMs)) best = e
  return best
}

const count = (db, sql, ...args) => { try { return Number(db.prepare(sql).get(...args)?.n) || 0 } catch { return 0 } }

/**
 * Persistence of one side's sealed segments across gateway restarts, judged
 * under the policy in force.
 *
 * A RESTART IS JUDGED BY THE BOOT BEFORE IT. What a restart loses is the OLD
 * boot's spool, so it is judged under the policy that governed that spool:
 * a restart counts when Node last listed the previous boot at or after the
 * policy's `from` (tick_segment_boots.prev_listing_ms), and a lost segment
 * counts when it was last listed at or after it (last_seen_ms). Judging by
 * when the NEW boot was first listed read the X1 restart — the old ephemeral
 * live spool, lost as declared — as a DURABLE failure the moment DURABLE's
 * `from` was set to the first volume boot's start, which always precedes
 * Node's first listing of it: FAILED, permanently and falsely (R1 checker).
 */
export function persistenceVerdict(db, sideName, { entries = [], state = null, nowMs = Date.now() } = {}) {
  const inForce = policyAt(entries, nowMs)
  const declared = entries.filter(e => e.fromMs == null).map(e => ({ policy: e.policy, pending: e.pending || e.basis }))
  if (!inForce) return { verdict: VERDICT.NOT_VERIFIABLE, policy: null, declaredNotInForce: declared, reason: 'no durability policy is in force for this side (DURABLE or EPHEMERAL_LOSS_RECORDED, agent/config/tick-spool-durability.json), so a restart\'s losses cannot be judged' }
  const base = { policy: inForce.policy, since: inForce.from, basis: inForce.basis, declaredNotInForce: declared }
  if (state && state.atMs != null && !state.bootId) return { ...base, verdict: VERDICT.NOT_VERIFIABLE, reason: 'the sidecar reports no bootId, so a restart cannot be observed' }
  let boots = []
  try { boots = db.prepare('SELECT at_ms, prev_boot_id, boot_id, listed_before, survived, retired, lost, lost_bytes FROM tick_segment_boots WHERE side = ? AND prev_listing_ms >= ? ORDER BY at_ms').all(sideName, inForce.fromMs) } catch { boots = [] }
  const withSegments = boots.filter(b => Number(b.listed_before) > 0)
  const lost = count(db, "SELECT COUNT(*) AS n FROM tick_segment_manifest WHERE side = ? AND gone_reason = 'lost_restart' AND last_seen_ms >= ?", sideName, inForce.fromMs)
  let lostBytes = 0
  try { lostBytes = Number(db.prepare("SELECT COALESCE(SUM(bytes), 0) AS b FROM tick_segment_manifest WHERE side = ? AND gone_reason = 'lost_restart' AND last_seen_ms >= ?").get(sideName, inForce.fromMs)?.b) || 0 } catch { lostBytes = 0 }
  const resized = count(db, 'SELECT COUNT(*) AS n FROM tick_segment_manifest WHERE side = ? AND bytes <> first_bytes AND last_seen_ms >= ?', sideName, inForce.fromMs)
  const facts = { restartsObserved: boots.length, restartsWithSegments: withSegments.length, lostRestart: lost, lostBytes, resized }
  if (inForce.policy === DURABILITY.DURABLE) {
    if (lost > 0) return { ...base, ...facts, verdict: VERDICT.FAILED, reason: `${lost} sealed segment(s) (${lostBytes} B) gone at a gateway restart under the DURABLE policy` }
    if (resized > 0) return { ...base, ...facts, verdict: VERDICT.FAILED, reason: `${resized} sealed segment(s) listed again with different bytes` }
    if (withSegments.length) return { ...base, ...facts, verdict: VERDICT.VERIFIED, reason: `${withSegments.length} gateway restart(s) observed with sealed segments on the spool; every one was listed again with the same bytes` }
    return { ...base, ...facts, verdict: VERDICT.NOT_VERIFIABLE, reason: `no gateway restart with sealed segments on the spool has been observed since ${inForce.from}` }
  }
  if (withSegments.length) return { ...base, ...facts, verdict: VERDICT.VERIFIED, reason: `ephemeral by declaration: ${withSegments.length} gateway restart(s) observed, ${lost} sealed segment(s) (${lostBytes} B) lost and each recorded as lost_restart` }
  return { ...base, ...facts, verdict: VERDICT.NOT_VERIFIABLE, reason: `no gateway restart with sealed segments on the spool has been observed since ${inForce.from}, so no loss has been recorded yet` }
}

/** Retention: the recorder retires oldest-first at its cap and nothing else takes a sealed segment. */
export function retentionVerdict(db, sideName, { state = null } = {}) {
  const retired = count(db, "SELECT COUNT(*) AS n FROM tick_segment_manifest WHERE side = ? AND gone_reason = 'retired'", sideName)
  const unexplained = count(db, "SELECT COUNT(*) AS n FROM tick_segment_manifest WHERE side = ? AND gone_reason = 'unexplained'", sideName)
  const facts = { retired, unexplained, pending: Object.keys(state?.pending || {}).length, capBytes: state?.capBytes ?? null, listedBytes: state?.listedBytes ?? null }
  if (unexplained > 0) return { ...facts, verdict: VERDICT.FAILED, reason: `${unexplained} sealed segment(s) vanished within one boot with no retire to explain them` }
  if (retired > 0) return { ...facts, verdict: VERDICT.VERIFIED, reason: `${retired} segment(s) retired oldest-first at the ${facts.capBytes ?? '?'} B cap, each explained by the recorder's count or the cap arithmetic` }
  return { ...facts, verdict: VERDICT.NOT_VERIFIABLE, reason: facts.capBytes != null && facts.listedBytes != null ? `no segment has been retired yet: ${facts.listedBytes} of the ${facts.capBytes} B cap is sealed` : 'no segment has been retired yet' }
}

/** Per side: every segment by name and bytes, what became of the ones gone, and the two verdicts. */
export function segmentManifestView(db, { sides = MANIFEST_SIDES, nowMs = Date.now(), policy = loadDurabilityPolicy(), goneLimit = 100 } = {}) {
  const all = loadState(db)
  const out = {}
  for (const name of sides) {
    const state = all[name] || null
    let segments = [], gone = []
    try {
      segments = db.prepare('SELECT name, bytes, first_bytes, start_ms, sealed_at_ms, first_seen_ms, first_boot_id, last_seen_ms, reappeared_at_ms, reappeared_from FROM tick_segment_manifest WHERE side = ? AND gone_at_ms IS NULL ORDER BY name').all(name)
      gone = db.prepare('SELECT name, bytes, start_ms, sealed_at_ms, first_seen_ms, last_seen_ms, gone_at_ms, gone_boot_id, gone_reason, gone_detail FROM tick_segment_manifest WHERE side = ? AND gone_at_ms IS NOT NULL ORDER BY gone_at_ms DESC, name DESC LIMIT ?').all(name, goneLimit)
    } catch { segments = []; gone = [] }
    let boots = []
    try { boots = db.prepare('SELECT at_ms AS atMs, prev_boot_id AS prevBootId, boot_id AS bootId, prev_listing_ms AS prevListingMs, listed_before AS listedBefore, bytes_before AS bytesBefore, survived, retired, lost, lost_bytes AS lostBytes, reappeared, reappeared_bytes AS reappearedBytes, bytes_changed AS bytesChanged FROM tick_segment_boots WHERE side = ? ORDER BY at_ms DESC LIMIT 20').all(name) } catch { boots = [] }
    const oldestStart = segments.reduce((m, s) => (s.start_ms != null && (m == null || s.start_ms < m) ? s.start_ms : m), null)
    const oldestSealed = segments.reduce((m, s) => (s.sealed_at_ms != null && (m == null || s.sealed_at_ms < m) ? s.sealed_at_ms : m), null)
    const byReason = (r) => count(db, 'SELECT COUNT(*) AS n FROM tick_segment_manifest WHERE side = ? AND gone_reason = ?', name, r)
    const entries = policy.sides?.[name] || []
    out[name] = {
      lastListing: state ? { atMs: state.lastOkAtMs ?? null, bootId: state.bootId ?? null, capBytes: state.capBytes ?? null, segmentBytes: state.segmentBytes ?? null, openBytes: state.openBytes ?? null, truncated: state.truncated ?? null, lastError: state.lastError ?? null, lastErrorAtMs: state.lastErrorAtMs ?? null } : null,
      listed: segments.length,
      listedBytes: segments.reduce((a, s) => a + (Number(s.bytes) || 0), 0),
      retired: byReason(GONE.RETIRED),
      lostRestart: byReason(GONE.LOST_RESTART),
      unexplained: byReason(GONE.UNEXPLAINED),
      pending: Object.entries(state?.pending || {}).map(([n, since]) => ({ name: n, sinceMs: since })),
      bytesChanged: segments.filter(s => Number(s.bytes) !== Number(s.first_bytes)).length,
      oldestStartMs: oldestStart,
      oldestSealedAtMs: oldestSealed,
      horizonHours: oldestStart != null ? +((nowMs - oldestStart) / 3_600_000).toFixed(2) : null,
      segments: segments.map(s => ({ name: s.name, bytes: s.bytes, firstBytes: s.first_bytes, startMs: s.start_ms, sealedAtMs: s.sealed_at_ms, firstSeenMs: s.first_seen_ms, firstBootId: s.first_boot_id, lastSeenMs: s.last_seen_ms, ...(s.reappeared_at_ms != null ? { reappearedAtMs: s.reappeared_at_ms, reappearedFrom: s.reappeared_from } : {}) })),
      gone: gone.map(g => ({ name: g.name, bytes: g.bytes, startMs: g.start_ms, sealedAtMs: g.sealed_at_ms, firstSeenMs: g.first_seen_ms, lastSeenMs: g.last_seen_ms, goneAtMs: g.gone_at_ms, goneBootId: g.gone_boot_id, reason: g.gone_reason, detail: g.gone_detail })),
      goneTotal: count(db, 'SELECT COUNT(*) AS n FROM tick_segment_manifest WHERE side = ? AND gone_at_ms IS NOT NULL', name),
      restarts: boots,
      persistence: persistenceVerdict(db, name, { entries, state, nowMs }),
      retention: retentionVerdict(db, name, { state }),
    }
  }
  return { sides: out, policyErrors: policy.errors || [], note: 'V3 R1: listed on every heartbeat probe. A segment that stops being listed is retired (oldest-first at the cap), lost_restart (gone at a restart, no retire explains it) or unexplained (gone within one boot, no retire explains it). Persistence is judged under the side\'s declared durability policy; the manifest is kept, never pruned.' }
}
