// Claude · № 11,713 07-Oct — C·1: re-anchor the registry on the feeds the gateways actually stream.
// Hand-built because scripts/prepare-scanner-alignment.mjs can only ADD tick profiles and
// requires a tick move; the fix here is to DROP dead tick anchors and move the timeframe set.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { initDB, setState } from '../agent/db.js'
import { scannerProfileRegistry, registerScannerProfiles } from '../agent/services/scanner-profile-registry.js'
const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x
const digest = x => createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex')
const [snapPath, outDir] = process.argv.slice(2)
const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
if (digest(snap.profiles) !== snap.revision) throw new Error('snapshot revision mismatch')
const hostOf = Object.fromEntries(snap.accounts.map(a => [a.account_id, a.is_live ? 'live.ctraderapi.com' : 'demo.ctraderapi.com']))
const observed = new Set(snap.tickFeeds.map(f => f.accountId + '@' + f.host))
const TF_FROM = '46979908', TF_TO = snap.selected
const mapOf = id => { const m = snap.maps[id]; if (!m || String(m.accountId) !== id) throw new Error('map missing ' + id); return m.map }
const remap = (p, from, to) => {
  if (hostOf[from] !== hostOf[to]) throw new Error('cross host')
  const fm = mapOf(from), tm = mapOf(to)
  const names = Object.keys(fm).filter(n => String(fm[n]) === p.feed.symbolId)
  if (names.length !== 1) throw new Error('source symbol ambiguous ' + p.feed.symbolId)
  const name = names[0]; if (!Object.hasOwn(tm, name)) throw new Error('target symbol missing ' + name)
  return { ...structuredClone(p), feed: { provider: 'ctrader', host: hostOf[to], accountId: to, symbolId: String(tm[name]) } }
}
const dropped = [], moved = []
const profiles = []
for (const p of snap.profiles) {
  if (p.source === 'cpp-scan-tick') {
    if (observed.has(p.feed.accountId + '@' + p.feed.host)) profiles.push(structuredClone(p))
    else dropped.push(p.feed.accountId + '@' + p.feed.host)
  } else if (p.source === 'cpp-scan-timeframe') {
    if (p.feed.accountId !== TF_FROM) throw new Error('timeframe population not exact')
    const n = remap(p, TF_FROM, TF_TO); profiles.push(n); moved.push([p.feed.symbolId, n.feed.symbolId])
  } else throw new Error('unknown source ' + p.source)
}
// in-memory round trip through the real registry code
const db = initDB(':memory:')
for (const a of snap.accounts) db.prepare('INSERT INTO accounts(account_id,is_live) VALUES(?,?)').run(a.account_id, a.is_live)
for (const [id, m] of Object.entries(snap.maps)) setState(db, `symbol_id_map:${id}`, JSON.stringify(m))
setState(db, 'ctrader_account_id', snap.selected)
const r0 = registerScannerProfiles(db, { expectedRevision: scannerProfileRegistry(db).revision, profiles: snap.profiles }, { env: {} })
if (r0.revision !== snap.revision) throw new Error('round trip: original revision')
const proposal = { expectedRevision: snap.revision, profiles }
const r1 = registerScannerProfiles(db, proposal, { env: {} })
const rollback = { expectedRevision: r1.revision, profiles: structuredClone(snap.profiles) }
const r2 = registerScannerProfiles(db, rollback, { env: {} })
if (r2.revision !== snap.revision || r1.orderAuthority !== false) throw new Error('round trip: rollback')
const count = {}; for (const d of dropped) count[d] = (count[d] || 0) + 1
const by = {}; for (const p of profiles) { const k = p.source + ' ' + p.feed.host + ' ' + p.feed.accountId; by[k] = (by[k] || 0) + 1 }
const evidence = { preparedAt: new Date().toISOString(), sourceReadAt: snap.readAt, previousRevision: snap.revision, proposedRevision: r1.revision,
  originalCount: snap.profiles.length, proposedCount: profiles.length, droppedDeadTickAnchors: count, timeframeMoved: { from: TF_FROM, to: TF_TO, count: moved.length, symbolIdChanges: moved.filter(([a, b]) => a !== b).length },
  resultingPopulation: by, observedTickFeeds: snap.tickFeeds, nativeTimeframe: snap.nativeTimeframe, roundTrip: 'in_memory_registry_only', applied: false, orderAuthority: false,
  proposalSha256: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'), rollbackSha256: createHash('sha256').update(JSON.stringify(rollback)).digest('hex') }
writeFileSync(outDir + '/proposal.json', JSON.stringify(proposal))
writeFileSync(outDir + '/rollback.json', JSON.stringify(rollback))
writeFileSync(outDir + '/evidence.json', JSON.stringify(evidence, null, 2))
console.log(JSON.stringify(evidence, null, 1))
